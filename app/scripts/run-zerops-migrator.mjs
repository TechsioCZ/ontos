import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const run = (command, arguments_) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${signal ?? `code ${String(code)}`}`));
    });
  });

await run('pnpm', ['db:bootstrap-spicedb']);
await run('pnpm', ['db:migrate']);
await run('pnpm', ['db:verify']);

const port = Number.parseInt(process.env['MIGRATOR_PORT'] ?? '8080', 10);
const server = createServer((request, response) => {
  if (request.url === '/ready') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ready\n');
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Migration verification complete; readiness listening on port ${String(port)}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
