#!/usr/bin/env node
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const jwt  = require('jsonwebtoken');

const PORT       = 5099;
const JWT_SECRET = 'metrics-test-secret';

function post(urlPath, body, token) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const t0  = Date.now();
        const req = http.request(
            { hostname: 'localhost', port: PORT, path: urlPath, method: 'POST', headers },
            (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ ms: Date.now() - t0, data: JSON.parse(d) })); }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function measureWs() {
    return new Promise((resolve) => {
        const token  = jwt.sign({ username: 'test', displayName: 'Test' }, JWT_SECRET, { expiresIn: '1h' });
        const t0     = Date.now();
        const socket = io(`http://localhost:${PORT}`, { auth: { token }, transports: ['websocket'] });
        socket.on('connect', () => {
            const connectMs = Date.now() - t0;
            const t1 = Date.now();
            socket.emit('join', { roomId: 'metrics-room', clientId: 999 });
            socket.on('yjs-init', () => { resolve({ connectMs, syncMs: Date.now() - t1 }); socket.disconnect(); });
        });
        socket.on('connect_error', () => { socket.disconnect(); resolve({ connectMs: -1, syncMs: -1 }); });
        setTimeout(() => { socket.disconnect(); resolve({ connectMs: -1, syncMs: -1 }); }, 8000);
    });
}

function startServer() {
    return new Promise((resolve, reject) => {
        const proc = spawn('node', ['server.js'], {
            env: { ...process.env, PORT: String(PORT), JWT_SECRET, NODE_ENV: 'test' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', d => { if (d.toString().includes('port')) resolve(proc); });
        proc.on('error', reject);
        setTimeout(() => reject(new Error('Server did not start')), 10000);
    });
}

async function main() {
    console.log('\nStarting server...');
    const proc = await startServer();

    try {
        const reg   = await post('/api/register', { username: 'metricsuser', password: 'password123' });
        const token = reg.data.token;

        let loginTotal = 0;
        for (let i = 0; i < 3; i++)
            loginTotal += (await post('/api/login', { username: 'metricsuser', password: 'password123' })).ms;

        const execMs = (await post('/api/execute', { code: 'console.log("hello")' }, token)).ms;
        const ws     = await measureWs();

        console.log('\n CodeSync — Metrics');
        console.log(' ───────────────────────────────────────────');
        console.log(` WebSocket connect             : ${ws.connectMs}ms`);
        console.log(` Yjs sync (join → first state) : ${ws.syncMs}ms`);
        console.log(` Auth latency (login, 3 runs)  : ${Math.round(loginTotal / 3)}ms`);
        console.log(` Code execution                : ${execMs}ms`);
        console.log(' ───────────────────────────────────────────\n');
    } finally {
        proc.kill();
    }
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
