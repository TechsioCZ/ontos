import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ApplicationMigrationStream } from '../application-migration-inventory.mts';
import {
  applicationCatalogExpectation,
  applicationCatalogMismatch,
  resolveApplicationVerificationSelection,
  verifierPathsOfPart,
} from '../verify-application-db-schema.mts';

const stream = (ownerId: string, options: Partial<ApplicationMigrationStream> = {}): ApplicationMigrationStream => ({
  configFile: 'drizzle.config.ts',
  database: 'primary',
  directory: `verticals/${ownerId}`,
  journalName: `__drizzle_migrations_${ownerId.replaceAll('-', '_')}`,
  migrationDirectory: `verticals/${ownerId}/drizzle`,
  migrations: [{ hash: 'a'.repeat(64), name: '20260101000000_first' }],
  optional: false,
  ownerId,
  preparationScripts: [],
  prerequisites: [],
  runtimeIdentityIds: [],
  schemas: [ownerId.replaceAll('-', '_')],
  verifierPaths: [`verticals/${ownerId}/scripts/verify-db-schema.mts`],
  ...options,
});
const core = stream('core-runtime', { schemas: ['core', 'trust'] });
const a = stream('a', { prerequisites: [{ migrate: false, ownerId: core.ownerId, verify: true }] });
const b = stream('b');
const portal = stream('commerce-customer-context-portal-auth', {
  database: 'portal-auth',
  optional: true,
  schemas: ['commerce_auth'],
});
const inventory = [core, a, b, portal];

it.effect(
  'selects only the owner and its real verification prerequisites without initializing an excluded verifier',
  () =>
    Effect.gen(function* selectsLazyVerifierClosure() {
      const excluded = {
        ...b,
        get verifierPaths(): readonly string[] {
          throw new Error('Excluded owner verifier initialized');
        },
      };
      const selected = yield* resolveApplicationVerificationSelection({
        inventory: [core, a, excluded, portal],
        ownersOption: Option.some(a.ownerId),
      });
      expect(selected.mode).toBe('selected');
      expect(selected.streams.map((owner) => owner.ownerId)).toEqual([core.ownerId, a.ownerId]);
      expect(selected.streams.flatMap((owner) => owner.verifierPaths)).toEqual([
        ...core.verifierPaths,
        ...a.verifierPaths,
      ]);
    }),
);

it.effect('includes a retained owner verifier independently of whether its artifact was rebuilt', () =>
  Effect.gen(function* verifiesRetainedOwner() {
    const selected = yield* resolveApplicationVerificationSelection({
      inventory,
      ownersOption: Option.some(`${a.ownerId},${b.ownerId}`),
    });
    expect(selected.streams.map((owner) => owner.ownerId)).toEqual([core.ownerId, a.ownerId, b.ownerId]);
    const optional = yield* resolveApplicationVerificationSelection({
      inventory,
      ownersOption: Option.some(portal.ownerId),
    });
    expect(optional.streams).toEqual([portal]);
  }),
);

it.effect('preserves explicit empty selection and none requirements without inventing an owner verifier', () =>
  Effect.gen(function* selectsNoVerification() {
    expect(yield* resolveApplicationVerificationSelection({ inventory, ownersOption: Option.some('') })).toEqual({
      mode: 'none',
      streams: [],
    });
    expect(
      yield* resolveApplicationVerificationSelection({
        inventory,
        ownersOption: Option.none(),
        requirements: { mode: 'none', owners: [] },
      }),
    ).toEqual({ mode: 'none', streams: [] });
    const all = yield* resolveApplicationVerificationSelection({ inventory, ownersOption: Option.none() });
    expect(all.streams.map((owner) => owner.ownerId)).toEqual([core.ownerId, a.ownerId, b.ownerId]);
    const configuredPortal = yield* resolveApplicationVerificationSelection({
      inventory,
      ownersOption: Option.none(),
      requirements: { mode: 'all', owners: [{ migrate: false, ownerId: portal.ownerId, verify: true }] },
    });
    expect(configuredPortal.streams.map((owner) => owner.ownerId)).toEqual(inventory.map((owner) => owner.ownerId));
  }),
);

it.effect('rejects unknown duplicate and malformed owner selections before initialization', () =>
  Effect.gen(function* rejectsInvalidVerifierSelection() {
    for (const owners of ['unknown', 'a,a', 'a,', ',', ' a', 'a,,b']) {
      const failure = yield* resolveApplicationVerificationSelection({
        inventory,
        ownersOption: Option.some(owners),
      }).pipe(Effect.flip);
      expect(failure.reason).toBe('Invalid application database verifier selection');
    }
    const conflicting = yield* resolveApplicationVerificationSelection({
      inventory,
      ownersOption: Option.some(a.ownerId),
      requirementsOption: Option.some('reviewed-requirements.json'),
    }).pipe(Effect.flip);
    expect(conflicting.reason).toBe('Owners and requirements options are mutually exclusive');
  }),
);

it('requires selected catalogs, tolerates either presence or absence of known excluded catalogs, and rejects unknown names', () => {
  const expected = applicationCatalogExpectation({
    commerceUsesPrimaryDatabase: false,
    inventory,
    mode: 'selected',
    selectedStreams: [core, a],
  });
  const selected = { journals: [core.journalName, a.journalName], schemas: ['core', 'trust', 'a'] };
  const installed = {
    journals: inventory.map((owner) => owner.journalName),
    schemas: inventory.flatMap((owner) => owner.schemas),
  };
  expect(applicationCatalogMismatch(selected, expected)).toBeUndefined();
  expect(applicationCatalogMismatch(installed, expected)).toBeUndefined();
  expect(applicationCatalogMismatch({ ...selected, schemas: ['core', 'trust'] }, expected)).toContain('missing=[a]');
  expect(applicationCatalogMismatch({ ...selected, schemas: [...selected.schemas, 'unknown'] }, expected)).toContain(
    'unknown=[unknown]',
  );
  expect(
    applicationCatalogMismatch(
      { ...selected, journals: [...selected.journals, '__drizzle_migrations_unknown'] },
      expected,
    ),
  ).toContain('unknown=[__drizzle_migrations_unknown]');
});

it('preserves exact all-owner catalogs and only includes portal auth in primary expectations when it shares that database', () => {
  const separatePortal = applicationCatalogExpectation({
    commerceUsesPrimaryDatabase: false,
    inventory,
    mode: 'all',
    selectedStreams: inventory,
  });
  const primary = inventory.filter((owner) => owner.database === 'primary');
  const actual = {
    journals: primary.map((owner) => owner.journalName),
    schemas: primary.flatMap((owner) => owner.schemas),
  };
  expect(applicationCatalogMismatch(actual, separatePortal)).toBeUndefined();
  expect(
    applicationCatalogMismatch({ ...actual, schemas: [...actual.schemas, 'commerce_auth'] }, separatePortal),
  ).toContain('unknown=[commerce_auth]');
  const colocatedPortal = applicationCatalogExpectation({
    commerceUsesPrimaryDatabase: true,
    inventory,
    mode: 'all',
    selectedStreams: inventory,
  });
  expect(applicationCatalogMismatch(actual, colocatedPortal)).toContain('missing=[commerce_auth]');
  expect(
    applicationCatalogMismatch(
      { journals: inventory.map((owner) => owner.journalName), schemas: inventory.flatMap((owner) => owner.schemas) },
      colocatedPortal,
    ),
  ).toBeUndefined();
});

it('splits the verifiers into the foundation (Core) and the other owners, together exactly the whole closure', () => {
  const all = verifierPathsOfPart(inventory, 'all');
  const foundation = verifierPathsOfPart(inventory, 'foundation');
  const owners = verifierPathsOfPart(inventory, 'owners');
  expect(all).toEqual(inventory.flatMap((owner) => owner.verifierPaths));
  expect(foundation).toEqual(core.verifierPaths);
  expect(owners).toEqual([...a.verifierPaths, ...b.verifierPaths, ...portal.verifierPaths]);
  expect([...foundation, ...owners].toSorted()).toEqual([...all].toSorted());
});
