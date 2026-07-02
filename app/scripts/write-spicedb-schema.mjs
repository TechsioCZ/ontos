import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const endpoint = process.env['SPICEDB_DOCKER_ENDPOINT'] ?? 'spicedb:50051';
const token = process.env['SPICEDB_PRESHARED_KEY'] ?? 'local-spicedb-key';

const runDocker = (args) => {
  const result = spawnSync('docker', args, {
    cwd: root,
    stdio: 'inherit',
  });

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
};

runDocker(['compose', 'up', '-d', '--wait', 'spicedb']);
runDocker([
  'compose',
  '--profile',
  'tools',
  'run',
  '--rm',
  'zed',
  '--endpoint',
  endpoint,
  '--token',
  token,
  '--insecure',
  'schema',
  'write',
  '/spicedb/schema.zed',
]);
