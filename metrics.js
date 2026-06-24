#!/usr/bin/env node
'use strict';

/**
 * CodeSync — Project Metrics Script
 * Run: node metrics.js
 * Starts the server, makes live requests, measures real latencies.
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');
const { io } = require('socket.io-client');
const jwt    = require('jsonwebtoken');

const ROOT       = __dirname;
const PORT       = 5099; // isolated port so it never conflicts
const JWT_SECRET = 'metrics-test-secret';
const SKIP_DIRS  = new Set(['node_modules', 'build', '.git', 'public']);

// ── file helpers ──────────────────────────────────────────────────────────────

function walk(dir, exts) {
    let out = [];
    for (const name of fs.readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) out = out.concat(walk(full, exts));
        else if (exts.some(e => name.endsWith(e))) out.push(full);
    }
    return out;
}

function loc(file) {
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l.trim().length > 0)
        .length;
}

function gzipBytes(file) {
    try { return +execSync(`gzip -c "${file}" | wc -c`).toString().trim(); }
    catch { return 0; }
}

function kb(bytes) { return (bytes / 1024).toFixed(1) + ' KB'; }

// ── http helpers ──────────────────────────────────────────────────────────────

function post(urlPath, body, token) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const t0  = Date.now();
        const req = http.request(
            { hostname: 'localhost', port: PORT, path: urlPath, method: 'POST', headers },
            (res) => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => resolve({ ms: Date.now() - t0, data: JSON.parse(raw), status: res.statusCode }));
            }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function avgMs(fn, runs = 3) {
    let total = 0;
    for (let i = 0; i < runs; i++) total += (await fn()).ms;
    return Math.round(total / runs);
}

// ── websocket helper ──────────────────────────────────────────────────────────

function measureWs() {
    return new Promise((resolve) => {
        const token  = jwt.sign({ username: 'test', displayName: 'Test' }, JWT_SECRET, { expiresIn: '1h' });
        const t0     = Date.now();
        const socket = io(`http://localhost:${PORT}`, { auth: { token }, transports: ['websocket'] });

        socket.on('connect', () => {
            const connectMs = Date.now() - t0;
            const t1 = Date.now();
            socket.emit('join', { roomId: 'metrics-room', clientId: 999 });
            socket.on('yjs-init', () => {
                resolve({ connectMs, syncMs: Date.now() - t1 });
                socket.disconnect();
            });
        });

        socket.on('connect_error', () => { socket.disconnect(); resolve({ connectMs: -1, syncMs: -1 }); });
        setTimeout(() => { socket.disconnect(); resolve({ connectMs: -1, syncMs: -1 }); }, 8000);
    });
}

// ── start / stop server ───────────────────────────────────────────────────────

function startServer() {
    return new Promise((resolve, reject) => {
        const proc = spawn('node', ['server.js'], {
            env: { ...process.env, PORT: String(PORT), JWT_SECRET, NODE_ENV: 'test' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', d => { if (d.toString().includes('port')) resolve(proc); });
        proc.stderr.on('data', d => { if (d.toString().includes('port')) resolve(proc); });
        proc.on('error', reject);
        setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    });
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    const line = '═'.repeat(52);
    console.log(`\n╔${line}╗`);
    console.log(`║${'  CodeSync — Project Metrics'.padEnd(52)}║`);
    console.log(`╚${line}╝\n`);

    // ── 1. Codebase analysis ────────────────────────────────────────────────
    const srcFiles = walk(path.join(ROOT, 'src'), ['.js', '.css'])
        .filter(f => !['App.test', 'setupTests', 'reportWebVitals', 'logo.svg'].some(x => f.includes(x)));
    const serverFile  = path.join(ROOT, 'server.js');
    const backendLoc  = loc(serverFile);
    const frontendLoc = srcFiles.reduce((s, f) => s + loc(f), 0);
    const totalLoc    = backendLoc + frontendLoc;

    const serverSrc  = fs.readFileSync(serverFile, 'utf8');
    const apiRoutes  = (serverSrc.match(/^app\.(post|get|put|delete)\(/gm) || []).length - 1; // subtract catch-all
    const wsEvents   = (serverSrc.match(/socket\.on\(/g) || []).length;

    console.log('📁  CODEBASE');
    console.log(`    Source files          : ${srcFiles.length + 1} files`);   // +1 for server.js
    console.log(`    Total LOC             : ${totalLoc} lines`);
    console.log(`    Backend  (server.js)  : ${backendLoc} lines`);
    console.log(`    Frontend (src/)       : ${frontendLoc} lines`);
    console.log(`    API endpoints         : ${apiRoutes} (/register /login /execute)`);
    console.log(`    WebSocket events      : ${wsEvents} (join, yjs-update, awareness, disconnect...)`);

    // ── 2. Dependencies ─────────────────────────────────────────────────────
    const pkg         = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const runtimeDeps = Object.keys(pkg.dependencies)
        .filter(d => !d.startsWith('@testing-library') && d !== 'web-vitals' && d !== 'react-scripts');
    const devDeps     = Object.keys(pkg.devDependencies || {});

    console.log('\n📦  DEPENDENCIES');
    console.log(`    Runtime packages      : ${runtimeDeps.length}`);
    console.log(`    Dev packages          : ${devDeps.length}`);
    console.log(`    Total in package.json : ${runtimeDeps.length + devDeps.length}`);

    // ── 3. Build sizes ──────────────────────────────────────────────────────
    const buildJsDir  = path.join(ROOT, 'build', 'static', 'js');
    const buildCssDir = path.join(ROOT, 'build', 'static', 'css');
    let jsGzip = 0, cssGzip = 0, jsRaw = 0;

    if (fs.existsSync(buildJsDir)) {
        const jsFiles  = fs.readdirSync(buildJsDir) .filter(f => f.endsWith('.js') && !f.endsWith('.map')).map(f => path.join(buildJsDir, f));
        const cssFiles = fs.readdirSync(buildCssDir).filter(f => f.endsWith('.css')&& !f.endsWith('.map')).map(f => path.join(buildCssDir, f));
        jsGzip  = jsFiles .reduce((s, f) => s + gzipBytes(f), 0);
        cssGzip = cssFiles.reduce((s, f) => s + gzipBytes(f), 0);
        jsRaw   = jsFiles .reduce((s, f) => s + fs.statSync(f).size, 0);
    }

    console.log('\n🏗️   BUILD (production)');
    console.log(`    JS bundle raw         : ${kb(jsRaw)}`);
    console.log(`    JS bundle gzipped     : ${kb(jsGzip)}`);
    console.log(`    CSS bundle gzipped    : ${kb(cssGzip)}`);
    console.log(`    Total gzipped         : ${kb(jsGzip + cssGzip)}`);

    // ── 4. Security parameters ──────────────────────────────────────────────
    const bcryptRounds = (serverSrc.match(/bcrypt\.hash\([^,]+,\s*(\d+)/)   || [])[1] || '?';
    const jwtExpiry    = (serverSrc.match(/expiresIn:\s*'([^']+)'/)          || [])[1] || '?';
    const vmTimeout    = (serverSrc.match(/timeout:\s*(\d+)/)                || [])[1] || '?';

    console.log('\n🔐  SECURITY');
    console.log(`    bcrypt rounds         : ${bcryptRounds} (~100ms per hash)`);
    console.log(`    JWT session expiry    : ${jwtExpiry}`);
    console.log(`    VM execution timeout  : ${parseInt(vmTimeout) / 1000}s`);

    // ── 5. Runtime measurements ─────────────────────────────────────────────
    console.log('\n⚡  RUNTIME  (live — server started on port ' + PORT + ')');
    console.log('    Starting server...');

    let serverProc;
    try {
        serverProc = await startServer();
        console.log('    Server ready.\n');

        // register
        const reg = await post('/api/register', { username: 'metricsuser', password: 'password123' });
        const token = reg.data.token;
        console.log(`    POST /api/register    : ${reg.ms}ms  (status ${reg.status})`);

        // login — average 3 runs
        const loginMs = await avgMs(() =>
            post('/api/login', { username: 'metricsuser', password: 'password123' }), 3);
        console.log(`    POST /api/login       : ${loginMs}ms avg  (3 runs, bcrypt verify)`);

        // execute — simple
        const execSimple = await post('/api/execute', { code: 'console.log("hello world")' }, token);
        console.log(`    POST /api/execute     : ${execSimple.ms}ms  (simple console.log)`);

        // execute — heavier
        const execHeavy = await post('/api/execute',
            { code: 'let s=0; for(let i=0;i<1_000_000;i++) s+=i; console.log(s);' }, token);
        console.log(`    POST /api/execute     : ${execHeavy.ms}ms  (1 million iterations)`);

        // websocket
        const ws = await measureWs();
        if (ws.connectMs > 0) {
            console.log(`    WebSocket connect     : ${ws.connectMs}ms`);
            console.log(`    Yjs sync (join→init)  : ${ws.syncMs}ms`);
        }

        // ── 6. Summary ──────────────────────────────────────────────────────
        console.log(`\n${'─'.repeat(54)}`);
        console.log('  RESUME-READY METRICS');
        console.log(`${'─'.repeat(54)}`);
        console.log(`  Codebase     : ${totalLoc} lines · ${srcFiles.length + 1} source files`);
        console.log(`  Dependencies : ${runtimeDeps.length} runtime packages`);
        console.log(`  Bundle       : ${kb(jsGzip + cssGzip)} gzipped`);
        console.log(`  Auth latency : ${loginMs}ms avg login (bcrypt ${bcryptRounds} rounds)`);
        console.log(`  API latency  : ${execSimple.ms}ms code execution`);
        if (ws.connectMs > 0) {
        console.log(`  WS connect   : ${ws.connectMs}ms`);
        console.log(`  Yjs sync     : ${ws.syncMs}ms (join → first document state)`);
        }
        console.log(`  Security     : ${jwtExpiry} JWT · ${bcryptRounds}-round bcrypt · ${parseInt(vmTimeout)/1000}s VM timeout`);
        console.log(`${'─'.repeat(54)}\n`);

    } finally {
        if (serverProc) serverProc.kill();
    }
}

main().catch(err => {
    console.error('\n✗ Metrics failed:', err.message);
    process.exit(1);
});
