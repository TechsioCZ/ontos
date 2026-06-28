import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const endpoint = 'spicedb:50051';
const token = process.env['SPICEDB_PRESHARED_KEY'] ?? 'local-spicedb-key';

const demoTenantId = '11111111-1111-4111-8111-111111111111';
const adminPrincipalId = '33333333-3333-4333-8333-333333333333';
const localDemoRelationships = [
  {
    relation: 'reader',
    resource: `resource_type:${demoTenantId}_property-unit`,
    subject: `principal:${adminPrincipalId}`,
  },
  {
    relation: 'changer',
    resource: `core_modules:${demoTenantId}_core-modules`,
    subject: `principal:${adminPrincipalId}`,
  },
];

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
for (const relationship of localDemoRelationships) {
  runZed([
    'relationship',
    'touch',
    relationship.resource,
    relationship.relation,
    relationship.subject,
  ]);
}

console.log(
  'Seeded SpiceDB property.unit read and core.modules change permissions for the Admin demo principal.',
);
