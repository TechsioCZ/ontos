import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import {
  demoAccounts,
  demoLegalEntityId,
  demoSearchDocuments,
  demoTenantId,
  partyFixture,
} from '../siampark/fixtures.mts';

const partyResourceType = 'party.registry.party';
const counterpartyResourceType = 'party.registry.counterparty';
const partyModuleId = 'party.registry';
const validationOnlyMessage = 'no data changed';
const fixture = {
  access: {
    assignments: [],
    legalEntityIds: [demoLegalEntityId],
    memberships: [],
    modules: [],
    roles: [],
    workloads: [],
  },
  accounts: demoAccounts,
  legalEntity: {
    legalEntityId: demoLegalEntityId,
    legalName: 'Synthetic demo',
    registrationCountry: 'CZ',
    registrationNumber: 'DEMO',
  },
  modules: [],
  searchDocuments: demoSearchDocuments,
  tenant: { defaultLocale: 'cs', displayName: 'Synthetic demo', slug: 'siampark-demo', tenantId: demoTenantId },
};
const runValidation = Effect.fn('NajemparkSearchFixture.runValidation')(function* validateFixture(
  input: typeof Schema.Unknown.Type,
  validateOnly: boolean,
  environment?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'siampark-search-test-' });
  const file = path.join(directory, 'fixture.json');
  yield* fs.writeFileString(file, yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(input));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(
      process.execPath,
      [
        'packages/core-runtime/scripts/bootstrap-development-context.mts',
        '--fixture',
        file,
        ...(validateOnly ? ['--validate-only'] : []),
      ],
      {
        env: {
          DATABASE_ADMIN_URL: 'invalid',
          DATABASE_URL: 'invalid',
          ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment ?? 'development',
        },
      },
    ),
  );
  return yield* Effect.all(
    {
      code: child.exitCode,
      stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    },
    { concurrency: 'unbounded' },
  );
});

it.live('validates exactly the canonical six Party and five scoped Counterparty projections without a database', () =>
  Effect.gen(function* canonicalSearchFixture() {
    const parties = demoSearchDocuments.filter((row) => row.ref.resourceType === partyResourceType);
    const counterparties = demoSearchDocuments.filter((row) => row.ref.resourceType === counterpartyResourceType);
    expect(parties.map((row) => row.ref.resourceId)).toEqual(partyFixture.parties.map((row) => row.id));
    expect(counterparties.map((row) => row.ref.resourceId)).toEqual(partyFixture.counterparties.map((row) => row.id));
    expect(parties.map((row) => row.title)).toContain('Eva Králová');
    expect(counterparties.find((row) => row.title === 'Petr Dvořák')).toMatchObject({
      selectedLegalEntityId: demoLegalEntityId,
      temporalFacets: [{ key: 'current-role', value: 'CUSTOMER' }],
    });
    const result = yield* runValidation(fixture, true);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(validationOnlyMessage);
    expect(result.stderr).toBe('');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  'rejects wrong tenant, legal entity, owner, resource kind, and missing canonical subjects before database initialization',
  () =>
    Effect.gen(function* invalidSearchFixture() {
      const otherId = '11111111-1111-4111-8111-111111111111';
      const invalidDocuments = [
        demoSearchDocuments.slice(1),
        demoSearchDocuments.map((row) => ({ ...row, ref: { ...row.ref, tenantId: otherId } })),
        demoSearchDocuments.map((row) => ({ ...row, ref: { ...row.ref, moduleId: 'foreign.owner' } })),
        demoSearchDocuments.map((row) => ({ ...row, ref: { ...row.ref, resourceType: 'foreign.resource' } })),
        demoSearchDocuments.map((row) =>
          row.ref.resourceType === counterpartyResourceType ? { ...row, selectedLegalEntityId: otherId } : row,
        ),
        demoSearchDocuments.map((row) =>
          row.ref.resourceType === counterpartyResourceType
            ? {
                ...row,
                subjectRef: {
                  moduleId: partyModuleId,
                  resourceId: otherId,
                  resourceType: partyResourceType,
                  tenantId: demoTenantId,
                },
              }
            : row,
        ),
      ];
      for (const searchDocuments of invalidDocuments) {
        const result = yield* runValidation({ ...fixture, searchDocuments }, true);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('fixed tenant and legal entity');
        expect(result.stdout).not.toContain('initialized');
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  'defaults the optional validation flag and reaches guarded configuration refusal before database initialization',
  () =>
    Effect.gen(function* omittedBooleanFlag() {
      const result = yield* runValidation(fixture, false);
      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain('MissingOption');
      expect(result.stderr).toContain('DatabaseConfigError');
      expect(result.stdout).not.toContain('initialized');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const reviewedRole = {
  cells: [{ capabilityKey: 'party.registry.party.read', mode: 'run', selector: 'all' }],
  key: 'sales.reader',
  label: 'Reviewed reader',
  legalEntityId: demoLegalEntityId,
};
const reviewedAccess = {
  ...fixture.access,
  assignments: [
    { legalEntityId: demoLegalEntityId, principalId: demoAccounts[0].principalId, roleKey: reviewedRole.key },
  ],
  roles: [reviewedRole],
  workloads: [{ principalId: '72000000-0000-4000-8000-000000000080', workloadKey: 'demo.crm.party-intake' }],
};

it.live('validates canonical role recipes, cells and the original workload namespace without opening a pool', () =>
  Effect.gen(function* canonicalAccessFixture() {
    const result = yield* runValidation({ ...fixture, access: reviewedAccess }, true);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(validationOnlyMessage);
    expect(result.stdout).not.toContain('initialized');
    expect(result.stderr).toBe('');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const { access, field } of [
  {
    access: {
      ...reviewedAccess,
      roles: [{ ...reviewedRole, cells: [{ capabilityKey: 'party', mode: 'run', selector: 'all' }] }],
    },
    field: 'capabilityKey',
  },
  {
    access: {
      ...reviewedAccess,
      assignments: [
        { legalEntityId: demoLegalEntityId, principalId: demoAccounts[0].principalId, roleKey: 'Not a Role key' },
      ],
    },
    field: 'roleKey',
  },
  { access: { ...reviewedAccess, roles: [{ ...reviewedRole, key: 'Not a Role key' }] }, field: 'key' },
  {
    access: {
      ...reviewedAccess,
      workloads: [{ principalId: '72000000-0000-4000-8000-000000000080', workloadKey: 'intake' }],
    },
    field: 'workloadKey',
  },
]) {
  it.live(`rejects a malformed canonical ${field} before database initialization`, () =>
    Effect.gen(function* malformedAccessIdentifier() {
      const result = yield* runValidation({ ...fixture, access }, false);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SchemaError');
      expect(result.stderr).toContain(field);
      expect(result.stderr).not.toContain('DatabaseConfigError');
      expect(result.stdout).not.toContain('initialized');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.live('refuses a non-development environment even for a validation-only CLI request', () =>
  Effect.gen(function* refusesNonDevelopment() {
    const result = yield* runValidation(fixture, true, 'production');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ConfigError');
    expect(result.stdout).not.toContain(validationOnlyMessage);
    expect(result.stdout).not.toContain('initialized');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it('seeds the four rental personas with Nájempark addresses and keeps their stable identities', () => {
  expect(demoAccounts.slice(0, 4).map(({ authUserId, email }) => ({ authUserId, email }))).toEqual([
    { authUserId: 'siampark-management', email: 'management@najempark.demo' },
    { authUserId: 'siampark-operations', email: 'operations@najempark.demo' },
    { authUserId: 'siampark-finance', email: 'finance@najempark.demo' },
    { authUserId: 'siampark-external', email: 'external@najempark.demo' },
  ]);
});
