import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import {
    Awareness,
    encodeAwarenessUpdate,
    applyAwarenessUpdate,
    removeAwarenessStates,
} from 'y-protocols/awareness';
import { io } from 'socket.io-client';
import toast, { Toaster } from 'react-hot-toast';

// Empty string = same origin (single deployment). Set env var for split deployment.
const BACKEND = process.env.REACT_APP_BACKEND_URL || '';

const COLORS = ['#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d19a66'];
const userColor = (name) => {
    let h = 0;
    for (const c of name) h = c.charCodeAt(0) + ((h << 5) - h);
    return COLORS[Math.abs(h) % COLORS.length];
};

const EditorPage = () => {
    const { roomId }  = useParams();
    const navigate    = useNavigate();
    const token       = localStorage.getItem('token');
    const username    = localStorage.getItem('username');

    const containerRef = useRef(null);
    const viewRef      = useRef(null);
    const socketRef    = useRef(null);

    const [users, setUsers]           = useState([]);
    const [output, setOutput]         = useState(null);
    const [running, setRunning]       = useState(false);
    const [showOutput, setShowOutput] = useState(false);

    useEffect(() => {
        if (!token || !username) return;

        const ydoc      = new Y.Doc();
        const ytext     = ydoc.getText('codemirror');
        const awareness = new Awareness(ydoc);

        awareness.setLocalState({ user: { name: username, color: userColor(username) } });

        const socketUrl = BACKEND || window.location.origin;
        const socket = io(socketUrl, { auth: { token }, transports: ['websocket'] });
        socketRef.current = socket;

        socket.on('connect_error', (err) => {
            toast.error(err.message === 'Unauthorized' ? 'Session expired' : 'Connection failed');
            if (err.message === 'Unauthorized') { localStorage.clear(); navigate('/'); }
        });

        socket.on('connect', () => socket.emit('join', { roomId, clientId: ydoc.clientID }));

        // Yjs document sync
        socket.on('yjs-init',   (u) => Y.applyUpdate(ydoc, new Uint8Array(u), 'server'));
        socket.on('yjs-update', (u) => Y.applyUpdate(ydoc, new Uint8Array(u), 'server'));
        ydoc.on('update', (update, origin) => {
            if (origin !== 'server')
                socket.emit('yjs-update', { roomId, update: Array.from(update) });
        });

        // Awareness (cursors)
        awareness.on('update', ({ added, updated, removed }) => {
            const u = encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]);
            socket.emit('awareness-update', { roomId, update: Array.from(u) });
        });
        socket.on('awareness-update', (u) =>
            applyAwarenessUpdate(awareness, new Uint8Array(u), 'server')
        );
        socket.on('broadcast-awareness', () => {
            const u = encodeAwarenessUpdate(awareness, [ydoc.clientID]);
            socket.emit('awareness-update', { roomId, update: Array.from(u) });
        });
        socket.on('remove-awareness', (clientId) =>
            removeAwarenessStates(awareness, [clientId], 'server')
        );

        socket.on('room-users', setUsers);

        // CodeMirror 6
        const view = new EditorView({
            extensions: [
                basicSetup,
                oneDark,
                javascript({ jsx: true }),
                yCollab(ytext, awareness, { undoManager: false }),
                EditorView.theme({
                    '&':            { height: '100%', fontSize: '14px' },
                    '.cm-scroller': { fontFamily: '"Fira Code","Cascadia Code",monospace', overflow: 'auto' },
                    '.cm-content':  { minHeight: '100%' },
                }),
            ],
            parent: containerRef.current,
        });
        viewRef.current = view;

        socket.emit('request-awareness', { roomId });

        return () => {
            awareness.setLocalState(null);
            socket.disconnect();
            view.destroy();
            ydoc.destroy();
        };
    }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

    const runCode = async () => {
        const code = viewRef.current?.state.doc.toString() || '';
        if (!code.trim()) return toast.error('Editor is empty');
        setRunning(true);
        setShowOutput(true);
        setOutput(null);
        try {
            const res = await fetch(`${BACKEND}/api/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ code }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            setOutput(data);
        } catch (err) {
            toast.error(err.message);
            setShowOutput(false);
        } finally {
            setRunning(false);
        }
    };

    // All hooks above — conditional return after
    if (!token || !username) return <Navigate to="/" />;

    const displayOutput = output
        ? (output.error
            ? `Error:\n${output.error}${output.output ? '\n\n' + output.output : ''}`
            : output.output)
        : (running ? 'Running...' : '');

    return (
        <div className="editor-layout">
            <Toaster position="top-right" />

            <aside className="sidebar">
                <div className="sidebar-body">
                    <div className="sidebar-brand">CodeSync</div>

                    <p className="sidebar-label">CONNECTED ({users.length})</p>
                    <div className="user-list">
                        {users.map(u => (
                            <div key={u} className="user-row">
                                <span className="user-dot" style={{ background: userColor(u) }} />
                                <span className="user-name">{u}</span>
                            </div>
                        ))}
                    </div>

                    <p className="sidebar-label" style={{ marginTop: 24 }}>ROOM ID</p>
                    <p className="room-id-text">{roomId}</p>
                </div>

                <div className="sidebar-foot">
                    <button className="btn run-btn" onClick={runCode} disabled={running}>
                        {running ? 'Running...' : '▶  Run JS'}
                    </button>
                    <button className="btn copy-btn" onClick={() => {
                        navigator.clipboard.writeText(roomId);
                        toast.success('Room ID copied');
                    }}>
                        Copy Room ID
                    </button>
                    <button className="btn leave-btn" onClick={() => navigate('/')}>Leave</button>
                </div>
            </aside>

            <div className="editor-wrap">
                <div
                    ref={containerRef}
                    className="cm-host"
                    style={{ height: showOutput ? 'calc(100vh - 220px)' : '100vh' }}
                />
                {showOutput && (
                    <div className="output-panel">
                        <div className="output-bar">
                            <span className="output-meta">
                                Output {output?.error ? '— Error' : output ? '— OK' : ''}
                            </span>
                            <button className="output-close" onClick={() => setShowOutput(false)}>✕</button>
                        </div>
                        <pre className="output-body">{displayOutput}</pre>
                    </div>
                )}
            </div>
        </div>
    );
};

export default EditorPage;
