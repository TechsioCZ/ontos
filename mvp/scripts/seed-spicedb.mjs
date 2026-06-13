import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const endpoint = 'spicedb:50051';
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

const resetSpiceDb = () => {
  runDocker(['compose', 'up', '-d', '--wait', 'spicedb']);
  runDocker(['compose', 'restart', 'spicedb']);
  runDocker(['compose', 'up', '-d', '--wait', 'spicedb']);
};

const runZed = (args) => {
  runDocker([
    'compose',
    'run',
    '--rm',
    'zed',
    '--endpoint',
    endpoint,
    '--token',
    token,
    '--insecure',
    ...args,
  ]);
};

resetSpiceDb();
runZed(['schema', 'write', '/spicedb/schema.zed']);

for (const relationship of [
  ['module:tenant-a_property-registry', 'action_caller', 'user:ba-user-demo-admin-a'],
  ['module:tenant-a_property-registry', 'writer', 'user:ba-user-demo-admin-a'],
  ['module:tenant-b_property-registry', 'action_caller', 'user:ba-user-demo-admin-b'],
  ['protected_resource:resource-a', 'reader', 'user:ba-user-demo-admin-a'],
  ['protected_resource:resource-b', 'reader', 'user:ba-user-demo-viewer-a'],
  ['protected_resource:resource-c', 'reader', 'user:ba-user-demo-admin-a'],
  ['protected_resource:resource-c', 'reader', 'user:ba-user-demo-viewer-a'],
]) {
  runZed(['relationship', 'touch', ...relationship]);
}

console.log('Seeded SpiceDB module action/write and protected-resource reader relationships.');
