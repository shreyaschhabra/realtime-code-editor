const express   = require('express');
const http      = require('http');
const path      = require('path');
const cors      = require('cors');
const vm        = require('vm');
const { Server }= require('socket.io');
const Y         = require('yjs');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');

const app    = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(express.static('build'));

// --- In-memory stores (reset on server restart) ---
const users = new Map(); // username -> { passwordHash, displayName }
const ydocs = new Map(); // roomId   -> Y.Doc

function getOrCreateDoc(roomId) {
    if (!ydocs.has(roomId)) ydocs.set(roomId, new Y.Doc());
    return ydocs.get(roomId);
}

// --- Auth middleware ---
function auth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// --- Auth routes ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username?.trim() || !password)
        return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const key = username.trim().toLowerCase();
    if (users.has(key))
        return res.status(409).json({ error: 'Username already taken' });

    const passwordHash = await bcrypt.hash(password, 10);
    users.set(key, { passwordHash, displayName: username.trim() });

    const token = jwt.sign({ username: key, displayName: username.trim() }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: username.trim() });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'Username and password required' });

    const key  = username.trim().toLowerCase();
    const user = users.get(key);
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
        return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ username: key, displayName: user.displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.displayName });
});

// --- Code execution (JS only, via built-in vm module) ---
app.post('/api/execute', auth, (req, res) => {
    const { code } = req.body;
    if (!code?.trim()) return res.status(400).json({ error: 'No code provided' });

    const logs = [];
    const sandbox = {
        console: {
            log:   (...a) => logs.push(a.map(String).join(' ')),
            error: (...a) => logs.push('[error] ' + a.map(String).join(' ')),
            warn:  (...a) => logs.push('[warn] '  + a.map(String).join(' ')),
        },
    };

    try {
        vm.runInNewContext(code, sandbox, { timeout: 5000 });
        res.json({ output: logs.join('\n') || '(no output)', error: '' });
    } catch (err) {
        res.json({ output: logs.join('\n'), error: err.message });
    }
});

// Serve React app for all non-API routes (production)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

// --- Socket.IO ---
const io = new Server(server, {
    cors: { origin: process.env.FRONTEND_URL || 'http://localhost:3000' },
});

io.use((socket, next) => {
    try {
        socket.user = jwt.verify(socket.handshake.auth?.token, JWT_SECRET);
        next();
    } catch {
        next(new Error('Unauthorized'));
    }
});

const socketMeta = new Map(); // socketId -> { roomId, yjsClientId }

io.on('connection', (socket) => {
    function getRoomUsers(roomId) {
        return [...(io.sockets.adapter.rooms.get(roomId) || [])]
            .map(id => io.sockets.sockets.get(id)?.user?.displayName)
            .filter(Boolean);
    }

    socket.on('join', ({ roomId, clientId }) => {
        socket.join(roomId);
        socketMeta.set(socket.id, { roomId, clientId });

        const doc   = getOrCreateDoc(roomId);
        const state = Y.encodeStateAsUpdate(doc);
        socket.emit('yjs-init', Array.from(state));

        io.to(roomId).emit('room-users', getRoomUsers(roomId));
    });

    socket.on('yjs-update', ({ roomId, update }) => {
        const doc = ydocs.get(roomId);
        if (!doc) return;
        Y.applyUpdate(doc, new Uint8Array(update), 'client');
        socket.in(roomId).emit('yjs-update', update);
    });

    socket.on('awareness-update', ({ roomId, update }) => {
        socket.in(roomId).emit('awareness-update', update);
    });

    socket.on('request-awareness', ({ roomId }) => {
        socket.in(roomId).emit('broadcast-awareness');
    });

    socket.on('disconnecting', () => {
        const meta = socketMeta.get(socket.id);
        if (!meta) return;

        const { roomId, clientId } = meta;
        if (clientId != null) socket.in(roomId).emit('remove-awareness', clientId);

        const remaining = [...(io.sockets.adapter.rooms.get(roomId) || [])]
            .filter(id => id !== socket.id)
            .map(id => io.sockets.sockets.get(id)?.user?.displayName)
            .filter(Boolean);
        socket.in(roomId).emit('room-users', remaining);

        socketMeta.delete(socket.id);
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
