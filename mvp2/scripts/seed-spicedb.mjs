import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const endpoint = 'spicedb:50051';
const token = process.env['SPICEDB_PRESHARED_KEY'] ?? 'local-spicedb-key';

const demoTenantId = '11111111-1111-4111-8111-111111111111';
const adminPrincipalId = '33333333-3333-4333-8333-333333333333';

const runDocker = (args) => {
  const result = spawnSync('docker', args, {
    cwd: root,
    stdio: 'inherit',
  });

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
};

const runZed = (args) => {
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
    ...args,
  ]);
};

runDocker(['compose', 'up', '-d', '--wait', 'spicedb']);
runZed(['schema', 'write', '/spicedb/schema.zed']);
runZed([
  'relationship',
  'touch',
  `resource_type:${demoTenantId}_property-unit`,
  'reader',
  `principal:${adminPrincipalId}`,
]);

console.log('Seeded SpiceDB property.unit read permission for the Admin demo principal.');
