import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { LIVE_ADMIN_URL, SCRATCH_ADMIN_URL, createFakePostgres, liveCluster, scratchCluster } from './data-fixture.mjs';
import {
  BACKUP_KIND,
  REHEARSAL_KIND,
  assertRehearsalEvidence,
  backupManifestDigest,
  backupStable,
  createPostgresTools,
  readCandidate,
  rehearseStable,
  restoreStable,
  verifyBackup,
} from './data.mjs';
import { createFakeGate } from './maintenance-fixture.mjs';
import { enterMaintenance } from './maintenance.mjs';

const REVISION = 'a'.repeat(40);
const CANDIDATE = { tag: 'sales-stable/2026-11-27', commit: 'b'.repeat(40) };
const IDENTITIES = [
  { role: 'ontos_runtime', urlKey: 'DATABASE_URL' },
  { role: 'party_registry_runtime', urlKey: 'PARTY_REGISTRY_DATABASE_URL' },
];
const quiet = { write: () => true };

const setup = async ({ maintenance = true } = {}) => {
  const { zerops, gate } = createFakeGate();
  if (maintenance) await enterMaintenance(zerops.config, gate);
  const fakePg = await createFakePostgres();
  const pg = createPostgresTools({ binDir: fakePg.binDir, stderr: quiet });
  const work = await mkdtemp(path.join(tmpdir(), 'ontos-stable-data-'));
  return { zerops, fakePg, pg, work, config: zerops.config, client: gate.client, cloudflare: gate.cloudflare, edge: gate.edge };
};

const backup = (context, name = 'backup') =>
  backupStable({ config: context.config, output: path.join(context.work, name), sourceRevision: REVISION, adminUrl: LIVE_ADMIN_URL, client: context.client, cloudflare: context.cloudflare, edge: context.edge, pg: context.pg });

test('backup: both databases and the roles, private files, a manifest that binds project, revision, time and digests', async () => {
  const context = await setup();
  const manifest = await backup(context);
  assert.equal(manifest.kind, BACKUP_KIND);
  assert.equal(manifest.projectId, context.config.projectId);
  assert.equal(manifest.sourceRevision, REVISION);
  assert.equal(manifest.consistency, 'maintenance');
  assert.ok(!Number.isNaN(Date.parse(manifest.createdAt)));
  assert.equal(manifest.server.systemIdentifier, '7000000000000000001');
  assert.deepEqual(manifest.databases.map(({ name }) => name), ['db18', 'spicedb']);
  const directory = path.join(context.work, 'backup');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const file of ['manifest.json', 'roles.json', 'db18.dump', 'spicedb.dump']) {
    assert.equal((await stat(path.join(directory, file))).mode & 0o777, 0o400, file);
  }
  const roles = JSON.parse(await readFile(path.join(directory, 'roles.json'), 'utf8'));
  assert.deepEqual(roles.roles.map(({ name }) => name), ['db18', 'ontos_runtime', 'party_registry_runtime', 'spicedb']);
  assert.ok(!JSON.stringify(roles).includes('password'));
  for (const call of await context.fakePg.calls()) {
    assert.ok(!call.args.join(' ').includes('live-secret-password'), 'no credential in arguments');
    assert.deepEqual(call.envKeys.filter((key) => !key.startsWith('PG') && !key.startsWith('__CF_') && !['PATH', 'HOME', 'TMPDIR'].includes(key)), []);
  }
});

test('backup refuses an open project, a foreign database URL and an existing output', async () => {
  const open = await setup({ maintenance: false });
  await assert.rejects(backup(open), /stable project is open; back up in maintenance/u);
  await assert.rejects(stat(path.join(open.work, 'backup')), { code: 'ENOENT' });
  const live = await backupStable({ config: open.config, output: path.join(open.work, 'live'), sourceRevision: REVISION, adminUrl: LIVE_ADMIN_URL, client: open.client, cloudflare: open.cloudflare, edge: open.edge, pg: open.pg, allowLive: true });
  assert.equal(live.consistency, 'live');

  const context = await setup();
  await assert.rejects(
    backupStable({ config: context.config, output: path.join(context.work, 'x'), sourceRevision: REVISION, adminUrl: 'postgresql://db18:pw@other-db:5432/db18', client: context.client, cloudflare: context.cloudflare, edge: context.edge, pg: context.pg }),
    /does not address the stable project db18/u,
  );
  await backup(context);
  await assert.rejects(backup(context), /never overwrites/u);
});

test('verifyBackup rejects a changed file, an unlisted file, open permissions and another project', async () => {
  const context = await setup();
  await backup(context);
  const directory = path.join(context.work, 'backup');
  await assert.rejects(verifyBackup(directory, { projectId: 'OTHERproject0000000000' }), /another project/u);
  const dump = path.join(directory, 'spicedb.dump');
  await chmod(dump, 0o644);
  await assert.rejects(verifyBackup(directory, { projectId: context.config.projectId }), /spicedb\.dump is readable by others/u);
  await chmod(dump, 0o600);
  await appendFile(dump, 'x');
  await assert.rejects(verifyBackup(directory, { projectId: context.config.projectId }), /does not match its checksum/u);

  const other = await setup();
  await backup(other);
  await writeFile(path.join(other.work, 'backup', 'extra'), '', { mode: 0o600 });
  await assert.rejects(verifyBackup(path.join(other.work, 'backup'), { projectId: other.config.projectId }), /unlisted files extra/u);
});

const restoreArgs = (context, overrides = {}) => ({
  config: context.config,
  backup: path.join(context.work, 'backup'),
  confirmProject: context.config.projectId,
  destroyCurrentData: true,
  preRestoreOutput: path.join(context.work, 'pre-restore'),
  currentRevision: REVISION,
  adminUrl: LIVE_ADMIN_URL,
  client: context.client,
  cloudflare: context.cloudflare,
  edge: context.edge,
  pg: context.pg,
  ...overrides,
});

test('restore refuses without the project, the acknowledgement, maintenance or the source cluster', async () => {
  const context = await setup();
  await backup(context);
  await assert.rejects(restoreStable(restoreArgs(context, { confirmProject: context.config.demoProjectId })), /--confirm-project/u);
  await assert.rejects(restoreStable(restoreArgs(context, { destroyCurrentData: false })), /--destroy-current-data/u);
  context.zerops.byName('app').status = 'ACTIVE';
  await assert.rejects(restoreStable(restoreArgs(context)), /gated, not in maintenance/u);
  context.zerops.byName('app').status = 'STOPPED';

  const moved = await setup();
  await backup(moved);
  const state = await moved.fakePg.state();
  state.clusters.db18.systemIdentifier = '7000000000000000002';
  await writeFile(path.join(moved.fakePg.binDir, 'state.json'), JSON.stringify(state));
  await assert.rejects(restoreStable(restoreArgs(moved)), /different PostgreSQL cluster/u);
  assert.ok(!(await moved.fakePg.calls()).some(({ sql }) => sql?.includes('drop database')));
});

test('restore copies the current data first, replaces both databases, restarts SpiceDB and stays in maintenance', async () => {
  const context = await setup();
  await backup(context);
  const state = await context.fakePg.state();
  state.clusters.db18.databases = state.clusters.db18.databases.map((database) => ({ ...database, content: `${database.content} then broken` }));
  await writeFile(path.join(context.fakePg.binDir, 'state.json'), JSON.stringify(state));
  context.zerops.state.calls.length = 0;

  const result = await restoreStable(restoreArgs(context));
  assert.equal(result.state, 'maintenance');
  assert.equal(result.backupManifestSha256, await backupManifestDigest(path.join(context.work, 'backup')));
  const preRestore = await verifyBackup(path.join(context.work, 'pre-restore'), { projectId: context.config.projectId });
  assert.ok((await readFile(path.join(context.work, 'pre-restore', 'db18.dump'), 'utf8')).includes('then broken'));
  assert.equal(preRestore.sourceRevision, REVISION);
  const after = await context.fakePg.state();
  assert.deepEqual(after.clusters.db18.databases.map(({ content }) => content).sort(), ['customer rows v1', 'relationships v1']);
  const spicedb = context.config.services.spicedb;
  const actions = context.zerops.state.calls.filter((call) => call.startsWith('PUT '));
  assert.deepEqual(actions, [`PUT /service-stack/${spicedb}/stop`, `PUT /service-stack/${spicedb}/start`]);
});

const rehearseArgs = (context, overrides = {}) => ({
  config: context.config,
  backup: path.join(context.work, 'backup'),
  evidence: path.join(context.work, 'evidence', 'rehearsal.json'),
  scratchAdminUrl: SCRATCH_ADMIN_URL,
  liveAdminUrl: LIVE_ADMIN_URL,
  candidate: CANDIDATE,
  pg: context.pg,
  identities: IDENTITIES,
  ...overrides,
});

test('rehearse refuses the source cluster, a stable host and an occupied scratch cluster', async () => {
  const context = await setup();
  await backup(context);
  await assert.rejects(rehearseStable(rehearseArgs(context, { scratchAdminUrl: LIVE_ADMIN_URL, liveAdminUrl: undefined })), /addresses a stable project service/u);
  await assert.rejects(rehearseStable(rehearseArgs(context, { scratchAdminUrl: 'postgresql://postgres:x@db18:5432/postgres' })), /DATABASE_ADMIN_URL server/u);

  const clone = await createFakePostgres({ db18: liveCluster(), 'scratch.local': { ...scratchCluster(), systemIdentifier: '7000000000000000001' } });
  await assert.rejects(rehearseStable(rehearseArgs(context, { pg: createPostgresTools({ binDir: clone.binDir, stderr: quiet }) })), /is the backup source cluster/u);

  const occupied = await createFakePostgres({ db18: liveCluster(), 'scratch.local': { ...scratchCluster(), databases: [{ name: 'db18', owner: 'x', content: '' }] } });
  await assert.rejects(rehearseStable(rehearseArgs(context, { pg: createPostgresTools({ binDir: occupied.binDir, stderr: quiet }) })), /--replace-scratch-databases/u);
});

test('rehearse restores into scratch, runs the migrator on throwaway credentials and writes passed evidence', async () => {
  const context = await setup();
  await backup(context);
  let migratorEnv;
  const record = await rehearseStable(rehearseArgs(context, { runMigrator: async ({ env }) => ((migratorEnv = env), 0) }));
  assert.equal(record.kind, REHEARSAL_KIND);
  assert.equal(record.verdict, 'passed');
  assert.equal(record.sourceProjectId, context.config.projectId);
  const backupDirectory = path.join(context.work, 'backup');
  const digest = await backupManifestDigest(backupDirectory);
  assert.equal(record.backupTakenAt, (await verifyBackup(backupDirectory, { projectId: context.config.projectId })).createdAt);
  assertRehearsalEvidence(record, { config: context.config, backupManifestSha256: digest, ...CANDIDATE });
  assert.throws(() => assertRehearsalEvidence(record, { config: context.config, backupManifestSha256: digest, ...CANDIDATE, commit: 'c'.repeat(40) }), /another candidate/u);
  const written = JSON.parse(await readFile(path.join(context.work, 'evidence', 'rehearsal.json'), 'utf8'));
  assert.deepEqual(written, record);
  assert.equal((await stat(path.join(context.work, 'evidence', 'rehearsal.json'))).mode & 0o777, 0o400);

  const serialized = JSON.stringify(migratorEnv);
  assert.ok(!serialized.includes('live-secret-password') && !serialized.includes('@db18:'), 'no live credential or host reaches the migrator');
  assert.equal(migratorEnv.MIGRATOR_ONCE, 'true');
  assert.equal(migratorEnv.SPICEDB_ENDPOINT, '');
  assert.match(migratorEnv.DATABASE_ADMIN_URL, /^postgresql:\/\/postgres:scratch-password@scratch\.local:5432\/db18$/u);
  assert.match(migratorEnv.PARTY_REGISTRY_DATABASE_URL, /^postgresql:\/\/party_registry_runtime:[\da-f]{48}@scratch\.local:5432\/db18$/u);
  const scratch = (await context.fakePg.state()).clusters['scratch.local'];
  assert.deepEqual(scratch.databases.map(({ content }) => content).sort(), ['customer rows v1', 'relationships v1']);
  assert.ok(scratch.roles.some(({ name }) => name === 'spicedb'));
  const passwordCall = (await context.fakePg.calls()).find(({ sql }) => sql?.includes('login password'));
  assert.ok(!passwordCall.args.join(' ').includes('password'), 'throwaway passwords travel on stdin');
});

test('a failing migration is reported, recorded as failed, and leaves the backup intact', async () => {
  const context = await setup();
  await backup(context);
  await assert.rejects(rehearseStable(rehearseArgs(context, { runMigrator: async () => 1 })), /migrator exited 1; the backup is unchanged/u);
  const written = JSON.parse(await readFile(path.join(context.work, 'evidence', 'rehearsal.json'), 'utf8'));
  assert.equal(written.verdict, 'failed');
  assert.equal(written.migratorExitCode, 1);
  await verifyBackup(path.join(context.work, 'backup'), { projectId: context.config.projectId });
});

test('the candidate must be a clean checkout of the named tag', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'ontos-stable-candidate-'));
  const git = (...args) => execFileSync('git', ['-C', repository, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  git('init', '-q');
  await writeFile(path.join(repository, 'file'), 'one');
  git('add', 'file');
  git('commit', '-qm', 'one');
  git('tag', 'sales-stable/2026-11-27');
  const head = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.deepEqual(readCandidate('sales-stable/2026-11-27', repository), { tag: 'sales-stable/2026-11-27', commit: head });
  assert.throws(() => readCandidate('sales-stable/2026-11-28', repository), /does not exist/u);
  await writeFile(path.join(repository, 'file'), 'two');
  assert.throws(() => readCandidate('sales-stable/2026-11-27', repository), /uncommitted changes/u);
  git('commit', '-qam', 'two');
  assert.throws(() => readCandidate('sales-stable/2026-11-27', repository), /does not point at the checked-out commit/u);
});
