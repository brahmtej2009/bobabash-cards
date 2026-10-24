// Local dev: the dashboard on http://localhost:3002. Login codes print here (no mail server needed).
const { spawn } = require('node:child_process');
const path = require('node:path');
// node dev.cjs <name> <port>: a second, empty dashboard (data-<name>) for clean tests
const [name, port] = process.argv.slice(2);
const env = name ? { ...process.env, DATA_DIR: `./data-${name}`, CARDS_PORT: port || '3012', EVENTS_INTERNAL: process.env.EVENTS_INTERNAL || 'https://events.boba-bash.xyz' } : process.env;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--env-file=.env.dev', 'server.js'], { cwd: path.join(__dirname, 'server'), stdio: 'inherit', env });
const stop = () => { server.kill(); process.exit(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));
