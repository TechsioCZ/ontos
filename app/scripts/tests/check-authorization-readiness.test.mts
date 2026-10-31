import { createHash } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import type { ProtectedEntrypointInventory } from '../authorization/protected-entrypoint-inventory.mts';
import { checkAuthorizationReadiness, hashAuthorizationEvidence } from '../check-authorization-readiness.mts';
import type {
  AuthorizationNegativeSmokeEvidence,
  AuthorizationReadinessInput,
} from '../check-authorization-readiness.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const approvalReference = 'https://github.com/TechsioCZ/ontos/issues/169';
const contactsCreateCustomerEntrypoint = 'contacts.create-customer';
const contactsCustomerDetailEntrypoint = 'contacts.route.customer-detail';
const contactsEventsWorkerEntrypoint = 'contacts.worker.events';
const contactsOwner = 'contacts.core';
const shellDeployment = 'shell-super-app';

const inventory: ProtectedEntrypointInventory = {
  businessPermissions: [],
  entries: [
    {
      authorization: {
        kind: 'action_execution',
        provisioning: 'tenant_membership_default',
      },
      deployment: 'contacts',
      entrypointKey: contactsCreateCustomerEntrypoint,
      owner: contactsOwner,
      surface: 'action',
    },
    {
      authorization: { kind: 'context_permission', permission: 'view' },
      deployment: 'contacts',
      entrypointKey: contactsCustomerDetailEntrypoint,
      owner: contactsOwner,
      surface: 'route',
    },
    {
      authorization: { kind: 'owner_local_background' },
      deployment: 'contacts',
      entrypointKey: contactsEventsWorkerEntrypoint,
      owner: contactsOwner,
      surface: 'worker',
    },
    {
      authorization: { credential: 'session', kind: 'capability_issuance' },
      deployment: shellDeployment,
      entrypointKey: 'shell.gateway.session',
      owner: shellDeployment,
      surface: 'capability_issuance',
    },
  ],
  inventoryHash: 'a'.repeat(64),
  schemaVersion: 2,
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
    approvalReference,
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
    approvalReference,
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
    verifiedActionEntrypoints: [contactsCreateCustomerEntrypoint],
    verifiedActiveModuleEntrypoints: [
      contactsCreateCustomerEntrypoint,
      contactsCustomerDetailEntrypoint,
      contactsEventsWorkerEntrypoint,
    ],
    verifiedContextPermissionEntrypoints: [contactsCustomerDetailEntrypoint],
    verifiedWorkerEntrypoints: [contactsEventsWorkerEntrypoint],
    workerOwnershipVersion: 'worker-owner-v1',
  },
  replayMigrationHash: 'd'.repeat(64),
  rollout: {
    activatedAt: '2026-09-01T00:00:00.000Z',
    baselineInventoryHash: inventory.inventoryHash,
    baselineSourceRevision: inventory.sourceRevision,
    compatibilityEligibleEntrypoints: [],
    decisionReference: approvalReference,
    expiresAt: '2026-09-30T00:00:00.000Z',
    mode: 'report_only',
    schemaVersion: 1,
  },
  spiceDbSchemaHash: 'e'.repeat(64),
};

const makeReadinessCliFixture = (provisioning = 'principal_self_credentials') =>
  Effect.gen(function* makeReadinessCliFixtureEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-authorization-readiness-' });
    const selfCredentialEntrypoint = 'core.identity.bind-self-api-key';
    const spiceDbSchemaSource = 'definition fixture {}\n';
    const replayMigrationSource = 'SELECT 1;\n';
    const observation = {
      ...ready.observation,
      replayMigrationHash: createHash('sha256').update(replayMigrationSource).digest('hex'),
      spiceDbSchemaHash: createHash('sha256').update(spiceDbSchemaSource).digest('hex'),
      verifiedActionEntrypoints: [...ready.observation.verifiedActionEntrypoints, selfCredentialEntrypoint],
      verifiedActiveModuleEntrypoints: [...ready.observation.verifiedActiveModuleEntrypoints, selfCredentialEntrypoint],
    };
    const reportDirectory = '.codex/reports/authorization';
    const inventoryPath = path.join(root, reportDirectory, 'protected-entrypoints.json');
    const observationPath = path.join(root, reportDirectory, 'fixed-context-observation.stage.json');
    const outputPath = path.join(root, reportDirectory, 'readiness.json');
    const documents = [
      ['topology/authorization-contexts/stage.json', ready.context],
      ['topology/authorization-rollout.json', { ...ready.rollout, mode: 'enforced' }],
      [
        `${reportDirectory}/protected-entrypoints.json`,
        {
          ...inventory,
          entries: [
            ...inventory.entries,
            {
              authorization: { kind: 'action_execution', provisioning },
              deployment: shellDeployment,
              entrypointKey: selfCredentialEntrypoint,
              owner: 'core.identity',
              surface: 'action',
            },
          ],
        },
      ],
      [`${reportDirectory}/fail-closed-impact.json`, ready.impact],
      [`${reportDirectory}/fixed-context-observation.stage.json`, observation],
      [`${reportDirectory}/negative-smoke.stage.json`, negativeSmoke],
    ] as const;
    const files = [
      ...documents.map(([file, value]) => [file, `${JSON.stringify(value)}\n`] as const),
      [ready.context.spiceDbSchemaPath, spiceDbSchemaSource],
      [ready.context.replayMigrationPath, replayMigrationSource],
    ] as const;
    for (const [file, source] of files) {
      const target = path.join(root, file);
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem.writeFileString(target, source);
    }
    return { inventoryPath, observation, observationPath, outputPath, root };
  });

const runReadinessCli = (root: string) =>
  Effect.gen(function* runReadinessCliEffect() {
    const path = yield* Path.Path;
    const script = yield* path.fromFileUrl(new URL('../check-authorization-readiness.mts', import.meta.url));
    return yield* collectToolingProcess(
      ChildProcess.make(process.execPath, [script, 'stage'], {
        cwd: root,
        env: { TMPDIR: root, ULTRAMODERN_WORKSPACE_ROOT: root },
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      }),
    );
  });

it.live('readiness CLI accepts principal_self_credentials with complete Action and module coverage', () =>
  Effect.gen(function* selfCredentialReadinessCli() {
    const fixture = yield* makeReadinessCliFixture();
    const result = yield* runReadinessCli(fixture.root);
    expect(result.status === 0 ? '' : result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
    const fileSystem = yield* FileSystem.FileSystem;
    const evidence = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          environment: Schema.Literal('stage'),
          inventoryHash: Schema.String,
          sourceRevision: Schema.String,
          status: Schema.Literal('ready'),
        }),
      ),
    )(yield* fileSystem.readFileString(fixture.outputPath));
    expect(evidence).toEqual({
      environment: 'stage',
      inventoryHash: inventory.inventoryHash,
      sourceRevision: inventory.sourceRevision,
      status: 'ready',
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('readiness CLI rejects unknown Action provisioning without writing readiness evidence', () =>
  Effect.gen(function* unknownProvisioningReadinessCli() {
    const fixture = yield* makeReadinessCliFixture('unknown_provisioning');
    const result = yield* runReadinessCli(fixture.root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`authorization evidence is invalid: ${fixture.inventoryPath}`);
    const fileSystem = yield* FileSystem.FileSystem;
    expect(yield* fileSystem.exists(fixture.outputPath)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const coverage of ['verifiedActionEntrypoints', 'verifiedActiveModuleEntrypoints'] as const) {
  it.live(`readiness CLI still requires principal_self_credentials in ${coverage}`, () =>
    Effect.gen(function* missingSelfCredentialReadinessCoverage() {
      const fixture = yield* makeReadinessCliFixture();
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        fixture.observationPath,
        `${JSON.stringify({
          ...fixture.observation,
          [coverage]: fixture.observation[coverage].filter(
            (entrypoint) => entrypoint !== 'core.identity.bind-self-api-key',
          ),
        })}\n`,
      );
      const result = yield* runReadinessCli(fixture.root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'required relationships, route permissions, module state, or worker ownership are incomplete',
      );
      expect(yield* fileSystem.exists(fixture.outputPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it('readiness emits deterministic evidence bound to the fixed context and exact build', () => {
  const evidence = checkAuthorizationReadiness(ready);
  expect(evidence.status).toBe('ready');
  expect(evidence.inventoryHash).toBe(inventory.inventoryHash);
  expect(evidence.fixedContextHash).toBe(ready.contextHash);
  expect(evidence.negativeSmokeHash).toBe(negativeSmokeHash);
});

it('readiness rejects unapproved contexts and unresolved or stale impact evidence', () => {
  expect(() =>
    checkAuthorizationReadiness({
      ...ready,
      context: { ...ready.context, approvalStatus: 'pending' },
    }),
  ).toThrow(/unapproved/u);
  expect(() =>
    checkAuthorizationReadiness({
      ...ready,
      impact: { ...ready.impact, totalWouldDeny: 1 },
    }),
  ).toThrow(/stale or unresolved/u);
  expect(() =>
    checkAuthorizationReadiness({
      ...ready,
      impact: { ...ready.impact, sourceRevision: 'other' },
    }),
  ).toThrow(/stale or unresolved/u);
});

it('readiness rejects missing relationships, module state, worker ownership, and replay migration', () => {
  for (const key of [
    'verifiedActionEntrypoints',
    'verifiedActiveModuleEntrypoints',
    'verifiedContextPermissionEntrypoints',
    'verifiedWorkerEntrypoints',
  ] as const) {
    expect(() =>
      checkAuthorizationReadiness({
        ...ready,
        observation: { ...ready.observation, [key]: [] },
      }),
    ).toThrow(/incomplete/u);
  }
  expect(() =>
    checkAuthorizationReadiness({
      ...ready,
      observation: {
        ...ready.observation,
        replayMigrationHash: 'f'.repeat(64),
      },
    }),
  ).toThrow(/stale/u);
});

it('readiness rejects incorrect issuer/audience topology, short observations, and smoke gaps', () => {
  expect(() =>
    checkAuthorizationReadiness({
      ...ready,
      observation: { ...ready.observation, gatewayAudiences: ['other'] },
    }),
  ).toThrow(/issuer or audience/u);
  expect(() =>
    checkAuthorizationReadiness({
      ...ready,
      observation: {
        ...ready.observation,
        gatewayIssuer: 'http://insecure.test',
      },
    }),
  ).toThrow(/issuer or audience/u);
  expect(() =>
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
  ).toThrow(/observation/u);
  expect(() =>
    checkAuthorizationReadiness({
      ...ready,
      negativeSmoke: {
        ...negativeSmoke,
        scenarios: negativeSmoke.scenarios.slice(1),
      },
    }),
  ).toThrow(/smoke evidence is incomplete/u);
});
