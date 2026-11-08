import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, DateTime, Effect, Exit, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  RELEASE_ACCESS_BOOTSTRAP_REMEDIATION,
  RELEASE_ACCESS_VERIFICATION_STATUS_FILE,
  ReleaseAccessVerificationError,
  SCHEMA_CUTOVER_REMEDIATION,
  loadReleaseAccessConfiguration,
  recordReleaseAccessVerification,
  releaseAccessVerificationFailure,
  releaseAccessVerificationStatus,
  verifyReleaseAccessWith,
  verifyTenantAccessIntent,
} from './release-access-verification.mts';

const gateSource = readFileSync(new URL('release-access-verification.mts', import.meta.url), 'utf-8');

const ACTIVE_TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const SUSPENDED_TENANT = '33333333-3333-4333-8333-333333333333';

const completeIntent = { members: [{}], owners: [{}], scopes: [{}] };
const matchingProjection = { drift: [], ok: true, tupleCount: 12 };

it('refuses an active Tenant whose intent carries no canonical authority', () => {
  const problem = verifyTenantAccessIntent({
    intent: { members: [], owners: [], scopes: [] },
    tenantId: ACTIVE_TENANT,
    verification: matchingProjection,
  });
  expect(problem?.reason).toContain(ACTIVE_TENANT);
  expect(problem?.reason).toContain('no canonical access scope');
  expect(problem?.remediation).toBe(RELEASE_ACCESS_BOOTSTRAP_REMEDIATION);
  expect(problem?.tenantId).toBe(ACTIVE_TENANT);
});

it('refuses a Tenant whose scopes exist but whose owner membership does not', () => {
  const problem = verifyTenantAccessIntent({
    intent: { members: [{}], owners: [], scopes: [{}] },
    tenantId: ACTIVE_TENANT,
    verification: matchingProjection,
  });
  expect(problem?.reason).toContain('no canonical owner membership');
});

it('refuses a Tenant whose projection differs from its intent', () => {
  const problem = verifyTenantAccessIntent({
    intent: completeIntent,
    tenantId: ACTIVE_TENANT,
    verification: { drift: [{}, {}], ok: false, tupleCount: 12 },
  });
  expect(problem?.reason).toContain('2 tuple(s) that differ from its intent');
  expect(problem?.reason).toContain(ACTIVE_TENANT);
});

it('accepts a Tenant whose intent is complete and whose projection matches', () => {
  expect(
    verifyTenantAccessIntent({
      intent: completeIntent,
      tenantId: ACTIVE_TENANT,
      verification: matchingProjection,
    }),
  ).toBeUndefined();
});

it.effect('verifies every active Tenant and skips suspended ones', () =>
  Effect.gen(function* verifiesActiveTenants() {
    const asked: string[] = [];
    const result = yield* verifyReleaseAccessWith({
      inventory: {
        tenants: [
          { status: 'suspended', tenantId: SUSPENDED_TENANT },
          { status: 'active', tenantId: OTHER_TENANT },
          { status: 'active', tenantId: ACTIVE_TENANT },
        ],
      },
      verifyTenant: (tenantId) =>
        Effect.sync(() => {
          asked.push(tenantId);
          return { tuples: 3 };
        }),
    });
    expect(asked.toSorted()).toEqual([ACTIVE_TENANT, OTHER_TENANT]);
    expect(result).toEqual({ tenants: 2, tuples: 6, verified: 2 });
  }),
);

it.effect('fails closed when one active Tenant cannot be proven', () =>
  Effect.gen(function* failsClosed() {
    const exit = yield* verifyReleaseAccessWith({
      inventory: {
        tenants: [
          { status: 'active', tenantId: ACTIVE_TENANT },
          { status: 'active', tenantId: OTHER_TENANT },
        ],
      },
      verifyTenant: (tenantId) =>
        tenantId === OTHER_TENANT
          ? Effect.fail(
              new ReleaseAccessVerificationError({
                reason: 'refused',
                remediation: RELEASE_ACCESS_BOOTSTRAP_REMEDIATION,
                tenantId,
              }),
            )
          : Effect.succeed({ tuples: 1 }),
    }).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain(OTHER_TENANT);
  }),
);

const refusal = (environment: Record<string, string>) =>
  loadReleaseAccessConfiguration(ConfigProvider.fromUnknown(environment)).pipe(
    Effect.exit,
    Effect.map((exit) => JSON.stringify(exit)),
  );
const stageSpiceDb = {
  SPICEDB_CA_CERT: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
  SPICEDB_ENDPOINT: 'spicedb:50051',
  SPICEDB_PRESHARED_KEY: 'withheld-key',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
};

it.effect('refuses outside stage and against any SpiceDB other than the fixed stage endpoint', () =>
  Effect.gen(function* refusesTargets() {
    const accepted = yield* loadReleaseAccessConfiguration(ConfigProvider.fromUnknown(stageSpiceDb));
    expect(accepted.endpoint).toBe('spicedb:50051');
    const message = 'runs only on stage against the fixed stage SpiceDB';
    expect(yield* refusal({ ...stageSpiceDb, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' })).toContain(message);
    expect(yield* refusal({ ...stageSpiceDb, SPICEDB_ENDPOINT: 'spicedb.example:443' })).toContain(message);
    expect(yield* refusal({ ...stageSpiceDb, SPICEDB_ENDPOINT: 'spicedb.example:443' })).not.toContain('withheld-key');
  }),
);

it('app-host verifies the release before publishing it, does not ignore a failure, and never writes', () => {
  const host = readFileSync(new URL('app-host.mts', import.meta.url), 'utf-8');
  const verify = host.indexOf('yield* verifyReleaseAccessIntent(releaseSnapshot)');
  const publish = host.indexOf('yield* publishSnapshot(releaseSnapshot)');
  const openPort = host.indexOf('yield* openPublicPort;\n    yield* Ref.set(published, true);\n    yield* closePublic');
  expect(verify).toBeGreaterThan(-1);
  expect(publish).toBeGreaterThan(verify);
  expect(openPort).toBeGreaterThan(publish);
  const step = host.slice(host.indexOf('const verifyReleaseAccessIntent'), verify);
  expect(step).not.toContain('Effect.ignore');
  // The gate is read-only: it reads intent and verifies the projection, and it has no write path at all.
  const source = readFileSync(new URL('release-access-verification.mts', import.meta.url), 'utf-8');
  expect(source).not.toContain('.reconcile(');
  expect(source).not.toContain('writeRelationships');
  expect(source).not.toContain('provisionReleaseActionAuthorization');
});

it.effect('records the verification as a readable status file under the workspace', () =>
  Effect.gen(function* recordsStatus() {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped();
    yield* recordReleaseAccessVerification(workspace, {
      ...releaseAccessVerificationStatus('r1', { tenants: 2, tuples: 8, verified: 2 }),
      finishedAt: DateTime.makeUnsafe('2026-11-05T12:00:00Z'),
    });
    const text = yield* fs.readFileString(`${workspace}/${RELEASE_ACCESS_VERIFICATION_STATUS_FILE}`);
    expect(JSON.parse(text)).toEqual({
      finishedAt: '2026-11-05T12:00:00.000Z',
      outcome: 'verified',
      revision: 'r1',
      tenants: 2,
      tuples: 8,
      verified: 2,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('records a refusal with its precise reason and remediation', () =>
  Effect.gen(function* recordsFailure() {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped();
    yield* recordReleaseAccessVerification(workspace, {
      ...releaseAccessVerificationFailure(
        'r2',
        new ReleaseAccessVerificationError({
          reason: `Active Tenant ${ACTIVE_TENANT} has no canonical access scope`,
          remediation: RELEASE_ACCESS_BOOTSTRAP_REMEDIATION,
          tenantId: ACTIVE_TENANT,
        }),
      ),
      finishedAt: DateTime.makeUnsafe('2026-11-05T12:00:00Z'),
    });
    const text = yield* fs.readFileString(`${workspace}/${RELEASE_ACCESS_VERIFICATION_STATUS_FILE}`);
    const status = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ outcome: Schema.Literal('failed'), reason: Schema.String })),
    )(text);
    expect(status.outcome).toBe('failed');
    expect(status.reason).toContain(ACTIVE_TENANT);
    expect(text).toContain('canonical access bootstrap');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it('requires a separately approved schema cutover, and never installs a schema itself', () => {
  // A live engine keeps whatever schema it was given (the deployment bootstrap file is read only when the
  // datastore is empty), so the release proves the schema instead of writing it.
  expect(SCHEMA_CUTOVER_REMEDIATION).toContain('separately approved');
  expect(SCHEMA_CUTOVER_REMEDIATION).toContain('datastore is empty');
  expect(gateSource).toContain('verifyReleaseSchema');
  expect(gateSource).not.toContain('writeSchema');
  expect(gateSource).not.toContain('writeRelationships');
  // The gate reads the schema at one revision and compares it natively; it never compares schema text.
  expect(gateSource).toContain('diffSchema');
  expect(gateSource).not.toContain('.reconcile(');
});
