import React, { useState } from 'react';
import { v4 as uuidV4 } from 'uuid';
import toast, { Toaster } from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

// Empty string = same origin (single deployment). Set env var for split deployment.
const BACKEND = process.env.REACT_APP_BACKEND_URL || '';

const Auth = ({ onLogin, loggedIn }) => {
    const [mode, setMode] = useState('login');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [roomId, setRoomId] = useState('');
    const [loading, setLoading] = useState(false);
    const navigate = useNavigate();

    const submit = async () => {
        if (!username.trim() || !password.trim()) return toast.error('Username and password required');
        setLoading(true);
        try {
            const res = await fetch(`${BACKEND}/api/${mode}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username.trim(), password }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            localStorage.setItem('token', data.token);
            localStorage.setItem('username', data.username);
            onLogin(data.username);
        } catch (err) {
            toast.error(err.message);
        } finally {
            setLoading(false);
        }
    };

    const joinRoom = () => navigate(`/editor/${roomId.trim() || uuidV4()}`);

    if (loggedIn) {
        return (
            <div className="auth-wrap">
                <Toaster position="top-right" />
                <div className="auth-card">
                    <h1 className="auth-title">CodeSync</h1>
                    <p className="auth-sub">Welcome, <strong>{localStorage.getItem('username')}</strong></p>
                    <input
                        className="auth-input"
                        placeholder="Room ID (leave blank to create new)"
                        value={roomId}
                        onChange={e => setRoomId(e.target.value)}
                        onKeyUp={e => e.key === 'Enter' && joinRoom()}
                    />
                    <button className="auth-btn primary" onClick={joinRoom}>
                        Join / Create Room
                    </button>
                    <button className="auth-btn ghost" onClick={() => {
                        localStorage.clear();
                        onLogin(null);
                        setUsername('');
                        setPassword('');
                    }}>
                        Logout
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="auth-wrap">
            <Toaster position="top-right" />
            <div className="auth-card">
                <h1 className="auth-title">CodeSync</h1>
                <p className="auth-sub">{mode === 'login' ? 'Sign in to continue' : 'Create an account'}</p>
                <input
                    className="auth-input"
                    placeholder="Username"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    onKeyUp={e => e.key === 'Enter' && submit()}
                    autoComplete="username"
                />
                <input
                    className="auth-input"
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyUp={e => e.key === 'Enter' && submit()}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
                <button className="auth-btn primary" onClick={submit} disabled={loading}>
                    {loading ? 'Loading...' : mode === 'login' ? 'Login' : 'Register'}
                </button>
                <p className="auth-toggle">
                    {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
                    <span onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                        {mode === 'login' ? 'Register' : 'Login'}
                    </span>
                </p>
            </div>
        </div>
    );
};

export default Auth;
