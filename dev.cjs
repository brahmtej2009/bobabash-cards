// Local dev: the dashboard on http://localhost:3002. Login codes print here (no mail server needed).
const { spawn } = require('node:child_process');
const path = require('node:path');
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--env-file=.env.dev', 'server.js'], { cwd: path.join(__dirname, 'server'), stdio: 'inherit' });
const stop = () => { server.kill(); process.exit(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));
