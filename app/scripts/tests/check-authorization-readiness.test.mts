import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProtectedEntrypointInventory } from '../authorization/protected-entrypoint-inventory.mts';
import {
  checkAuthorizationReadiness,
  hashAuthorizationEvidence,
} from '../check-authorization-readiness.mts';
import type {
  AuthorizationNegativeSmokeEvidence,
  AuthorizationReadinessInput,
} from '../check-authorization-readiness.mts';

const inventory: ProtectedEntrypointInventory = {
  entries: [
    {
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
      deployment: 'contacts',
      entrypointKey: 'contacts.create-customer',
      owner: 'contacts.core',
      surface: 'action',
    },
    {
      authorization: { kind: 'context_permission', permission: 'view' },
      deployment: 'contacts',
      entrypointKey: 'contacts.route.customer-detail',
      owner: 'contacts.core',
      surface: 'route',
    },
    {
      authorization: { kind: 'owner_local_background' },
      deployment: 'contacts',
      entrypointKey: 'contacts.worker.events',
      owner: 'contacts.core',
      surface: 'worker',
    },
    {
      authorization: { credential: 'session', kind: 'capability_issuance' },
      deployment: 'shell-super-app',
      entrypointKey: 'shell.gateway.session',
      owner: 'shell-super-app',
      surface: 'capability_issuance',
    },
  ],
  inventoryHash: 'a'.repeat(64),
  schemaVersion: 1,
  sourceRevision: 'revision',
};

const scenarios = [
  'expired_capability',
  'missing_action_policy',
  'replayed_capability',
  'wrong_audience',
  'wrong_tenant',
];
const negativeSmoke: AuthorizationNegativeSmokeEvidence = {
  environment: 'stage',
  inventoryHash: inventory.inventoryHash,
  scenarios: scenarios.flatMap((scenario) =>
    (['api_key', 'session'] as const).map((credential) => ({
      credential,
      outcome: 'denied' as const,
      scenario,
    })),
  ),
  schemaVersion: 1,
  sourceRevision: inventory.sourceRevision,
};
const negativeSmokeHash = hashAuthorizationEvidence(negativeSmoke);

const ready: AuthorizationReadinessInput = {
  context: {
    approvalReference: 'https://github.com/TechsioCZ/ontos/issues/169',
    approvalStatus: 'approved',
    environment: 'stage',
    gatewayAudiences: ['contacts'],
    minimumObservationSeconds: 86_400,
    moduleStateVersion: 'module-state-v1',
    negativeSmokeScenarios: scenarios,
    policyDataVersion: 'policy-data-v1',
    replayMigrationPath: 'verticals/contacts/drizzle/0003.sql',
    schemaVersion: 1,
    spiceDbSchemaPath: 'packages/core-runtime/spicedb/bootstrap.yaml',
    workerOwnershipVersion: 'worker-owner-v1',
  },
  contextHash: 'b'.repeat(64),
  impact: {
    aggregates: [],
    inventoryHash: inventory.inventoryHash,
    observation: {
      endedAt: '2026-09-10T00:00:00.000Z',
      startedAt: '2026-09-02T00:00:00.000Z',
    },
    schemaVersion: 1,
    sourceRevision: inventory.sourceRevision,
    totalWouldDeny: 0,
  },
  impactReportHash: 'c'.repeat(64),
  inventory,
  negativeSmoke,
  negativeSmokeHash,
  nowEpochMs: Date.parse('2026-09-10T00:00:00.000Z'),
  observation: {
    approvalReference: 'https://github.com/TechsioCZ/ontos/issues/169',
    environment: 'stage',
    gatewayAudiences: ['contacts'],
    gatewayIssuer: 'https://shell.stage.example.test',
    inventoryHash: inventory.inventoryHash,
    moduleStateVersion: 'module-state-v1',
    negativeSmokeHash,
    policyDataVersion: 'policy-data-v1',
    replayMigrationHash: 'd'.repeat(64),
    schemaVersion: 1,
    sourceRevision: inventory.sourceRevision,
    spiceDbSchemaHash: 'e'.repeat(64),
    verifiedActionEntrypoints: ['contacts.create-customer'],
    verifiedActiveModuleEntrypoints: [
      'contacts.create-customer',
      'contacts.route.customer-detail',
      'contacts.worker.events',
    ],
    verifiedContextPermissionEntrypoints: ['contacts.route.customer-detail'],
    verifiedWorkerEntrypoints: ['contacts.worker.events'],
    workerOwnershipVersion: 'worker-owner-v1',
  },
  replayMigrationHash: 'd'.repeat(64),
  rollout: {
    activatedAt: '2026-09-01T00:00:00.000Z',
    baselineInventoryHash: inventory.inventoryHash,
    baselineSourceRevision: inventory.sourceRevision,
    compatibilityEligibleEntrypoints: [],
    decisionReference: 'https://github.com/TechsioCZ/ontos/issues/169',
    expiresAt: '2026-09-30T00:00:00.000Z',
    mode: 'report_only',
    schemaVersion: 1,
  },
  spiceDbSchemaHash: 'e'.repeat(64),
};

test('readiness emits deterministic evidence bound to the fixed context and exact build', () => {
  const evidence = checkAuthorizationReadiness(ready);
  assert.equal(evidence.status, 'ready');
  assert.equal(evidence.inventoryHash, inventory.inventoryHash);
  assert.equal(evidence.fixedContextHash, ready.contextHash);
  assert.equal(evidence.negativeSmokeHash, negativeSmokeHash);
});

test('readiness rejects unapproved contexts and unresolved or stale impact evidence', () => {
  assert.throws(
    () =>
      checkAuthorizationReadiness({
        ...ready,
        context: { ...ready.context, approvalStatus: 'pending' },
      }),
    /unapproved/u,
  );
  assert.throws(
    () =>
      checkAuthorizationReadiness({
        ...ready,
        impact: { ...ready.impact, totalWouldDeny: 1 },
      }),
    /stale or unresolved/u,
  );
  assert.throws(
    () =>
      checkAuthorizationReadiness({
        ...ready,
        impact: { ...ready.impact, sourceRevision: 'other' },
      }),
    /stale or unresolved/u,
  );
});

test('readiness rejects missing relationships, module state, worker ownership, and replay migration', () => {
  for (const key of [
    'verifiedActionEntrypoints',
    'verifiedActiveModuleEntrypoints',
    'verifiedContextPermissionEntrypoints',
    'verifiedWorkerEntrypoints',
  ] as const) {
    assert.throws(
      () =>
        checkAuthorizationReadiness({
          ...ready,
          observation: { ...ready.observation, [key]: [] },
        }),
      /incomplete/u,
    );
  }
  assert.throws(
    () =>
      checkAuthorizationReadiness({
        ...ready,
        observation: { ...ready.observation, replayMigrationHash: 'f'.repeat(64) },
      }),
    /stale/u,
  );
});

test('readiness rejects incorrect issuer/audience topology, short observations, and smoke gaps', () => {
  assert.throws(
    () =>
      checkAuthorizationReadiness({
        ...ready,
        observation: { ...ready.observation, gatewayAudiences: ['other'] },
      }),
    /issuer or audience/u,
  );
  assert.throws(
    () =>
      checkAuthorizationReadiness({
        ...ready,
        observation: { ...ready.observation, gatewayIssuer: 'http://insecure.test' },
      }),
    /issuer or audience/u,
  );
  assert.throws(
    () =>
      checkAuthorizationReadiness({
        ...ready,
        impact: {
          ...ready.impact,
          observation: {
            endedAt: '2026-09-02T00:00:01.000Z',
            startedAt: '2026-09-02T00:00:00.000Z',
          },
        },
      }),
    /observation/u,
  );
  assert.throws(
    () =>
      checkAuthorizationReadiness({
        ...ready,
        negativeSmoke: { ...negativeSmoke, scenarios: negativeSmoke.scenarios.slice(1) },
      }),
    /smoke evidence is incomplete/u,
  );
});
