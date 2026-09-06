import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('../', import.meta.url));

const run = (command, arguments_, cwd = appDirectory) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${signal ?? `code ${String(code)}`}`));
    });
  });

const runAppScript = (relativePath) =>
  run(process.execPath, [path.join(appDirectory, relativePath)]);
const migrate = (relativeDirectory, config) => {
  const workingDirectory = path.join(appDirectory, relativeDirectory);
  return run(
    path.join(workingDirectory, 'node_modules', '.bin', 'drizzle-kit'),
    ['migrate', '--config', config],
    workingDirectory,
  );
};

await runAppScript('scripts/postgres/bootstrap-spicedb-database.mts');
await migrate('packages/core-runtime', 'drizzle.config.ts');
await migrate('apps/shell-super-app', 'drizzle.auth.config.ts');
await runAppScript('scripts/postgres/bootstrap-runtime-role.mts');
await runAppScript('verticals/party-registry/scripts/prepare-contacts-migration.mts');
await migrate('verticals/party-registry', 'drizzle.contacts.config.ts');
await runAppScript('scripts/postgres/bootstrap-runtime-role.mts');
await runAppScript('scripts/verify-application-db-schema.mts');

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
