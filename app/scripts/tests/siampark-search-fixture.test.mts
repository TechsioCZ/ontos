import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

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
const fixture = {
  accounts: demoAccounts,
  legalEntity: {
    legalEntityId: demoLegalEntityId,
    legalName: 'Synthetic demo',
    registrationCountry: 'CZ',
    registrationNumber: 'DEMO',
  },
  modules: [],
  relationships: [],
  searchDocuments: demoSearchDocuments,
  tenant: { defaultLocale: 'cs', displayName: 'Synthetic demo', slug: 'siampark-demo', tenantId: demoTenantId },
};
const runValidation = Effect.fn('SiamparkSearchFixture.runValidation')(function* validateFixture(
  input: typeof Schema.Unknown.Type,
  validateOnly: boolean,
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
          ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
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
    expect(result.stdout).toContain('no data changed');
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
