// Test fixture: disposable stand-ins for psql, pg_dump and pg_restore. Each is a small Node script that keeps the
// clusters it serves (keyed by PGHOST) in state.json beside itself and appends every call to calls.jsonl, with the
// environment variable names it received, so tests see exactly what the real tools would have been given.
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const COMMON = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const statePath = path.join(dir, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const cluster = state.clusters[process.env.PGHOST];
const log = (entry) => fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({
  ...entry, args: process.argv.slice(2), host: process.env.PGHOST, database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD, envKeys: Object.keys(process.env).sort(),
}) + '\\n');
if (process.argv[2] === '--version') { process.stdout.write(path.basename(process.argv[1]) + ' (PostgreSQL) 18.1\\n'); process.exit(0); }
if (cluster === undefined || process.env.PGPASSWORD !== cluster.password) { process.stderr.write('connection refused\\n'); process.exit(2); }
`;

const PSQL = `${COMMON}
const sql = fs.readFileSync(0, 'utf8');
log({ tool: 'psql', sql });
if (sql.includes('json_build_object')) {
  process.stdout.write(JSON.stringify({ serverVersionNum: 180001, systemIdentifier: cluster.systemIdentifier, superuser: true,
    databases: cluster.databases, roles: cluster.roles, memberships: cluster.memberships }) + '\\n');
}
for (const match of sql.matchAll(/drop database if exists "([^"]+)"/g)) cluster.databases = cluster.databases.filter((d) => d.name !== match[1]);
for (const match of sql.matchAll(/create role "([^"]+)" nologin (inherit|noinherit)/g)) cluster.roles.push({ name: match[1], superuser: false, inherit: match[2] === 'inherit', login: false });
for (const match of sql.matchAll(/grant "([^"]+)" to "([^"]+)"/g)) cluster.memberships.push({ role: match[1], member: match[2] });
save();
`;

const PG_DUMP = `${COMMON}
log({ tool: 'pg_dump' });
const database = cluster.databases.find((d) => d.name === process.env.PGDATABASE);
process.stdout.write(JSON.stringify({ name: database.name, owner: database.owner, content: database.content }));
`;

const PG_RESTORE = `${COMMON}
const file = process.argv[process.argv.length - 1];
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
log({ tool: 'pg_restore', restored: dump.name });
if (cluster.databases.some((d) => d.name === dump.name)) { process.stderr.write('database exists\\n'); process.exit(1); }
cluster.databases.push(dump);
save();
`;

export const liveCluster = () => ({
  password: 'live-secret-password',
  systemIdentifier: '7000000000000000001',
  databases: [
    { name: 'db18', owner: 'db18', content: 'customer rows v1' },
    { name: 'spicedb', owner: 'spicedb', content: 'relationships v1' },
  ],
  roles: [
    { name: 'db18', superuser: true, inherit: true, login: true },
    { name: 'ontos_runtime', superuser: false, inherit: false, login: true },
    { name: 'party_registry_runtime', superuser: false, inherit: false, login: true },
    { name: 'spicedb', superuser: false, inherit: false, login: true },
  ],
  memberships: [{ role: 'ontos_runtime', member: 'party_registry_runtime' }],
});

export const scratchCluster = () => ({
  password: 'scratch-password',
  systemIdentifier: '7000000000000000999',
  databases: [],
  roles: [{ name: 'postgres', superuser: true, inherit: true, login: true }],
  memberships: [],
});

export const LIVE_ADMIN_URL = 'postgresql://db18:live-secret-password@db18:5432/db18';
export const SCRATCH_ADMIN_URL = 'postgresql://postgres:scratch-password@scratch.local:5432/postgres';

/** A bin directory with the three fake tools serving `clusters` ({ [PGHOST]: cluster }). */
export const createFakePostgres = async (clusters = { db18: liveCluster(), 'scratch.local': scratchCluster() }) => {
  const binDir = await mkdtemp(path.join(tmpdir(), 'ontos-stable-pg-'));
  for (const [tool, source] of [['psql', PSQL], ['pg_dump', PG_DUMP], ['pg_restore', PG_RESTORE]]) {
    await writeFile(path.join(binDir, tool), source.replace('#!/usr/bin/env node', `#!${process.execPath}`));
    await chmod(path.join(binDir, tool), 0o755);
  }
  await writeFile(path.join(binDir, 'package.json'), '{"type":"commonjs"}');
  await writeFile(path.join(binDir, 'state.json'), JSON.stringify({ clusters }));
  await writeFile(path.join(binDir, 'calls.jsonl'), '');
  return {
    binDir,
    state: async () => JSON.parse(await readFile(path.join(binDir, 'state.json'), 'utf8')),
    calls: async () => (await readFile(path.join(binDir, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
};
