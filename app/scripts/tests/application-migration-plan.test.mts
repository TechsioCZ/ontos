import { Array as EffectArray, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ApplicationMigrationPlanError,
  selectApplicationMigrationPlan,
  resolveApplicationMigrationRequirements,
} from '../application-migration-plan.mts';
import type {
  ApplicationMigrationObservation,
  ApplicationMigrationOwnerInventory,
  ApplicationMigrationRequirement,
  ApplicationMigrationRequirements,
} from '../application-migration-plan.mts';

const OBSERVED_JOURNAL = 'observed-journal' as const;
const VERIFIED_TARGET = 'verified-target' as const;
const first = { hash: 'a'.repeat(64), name: '20260101000000_first' };
const second = { hash: 'b'.repeat(64), name: '20260102000000_second' };
const requirement = (ownerId: string, migrate = true, verify = true): ApplicationMigrationRequirement => ({
  migrate,
  ownerId,
  verify,
});
const owner = (
  ownerId: string,
  prerequisites: readonly ApplicationMigrationRequirement[] = [],
  optional = false,
): ApplicationMigrationOwnerInventory => ({
  journalName: `__drizzle_migrations_${ownerId}`,
  migrations: [first, second],
  optional,
  ownerId,
  prerequisites,
  schemas: [ownerId],
});
const core = owner('core');
const retained = owner('retained');
const feature = owner('feature', [requirement('core', false), requirement('retained', false)]);
const unrelated = owner('unrelated');
const inventory = [core, retained, feature, unrelated];
const observation = (
  stream: ApplicationMigrationOwnerInventory,
  entries: readonly (typeof first)[],
  schemaEvidence: ApplicationMigrationObservation['schemaEvidence'],
): ApplicationMigrationObservation => ({
  catalogFingerprint: 'c'.repeat(64),
  entries,
  journalExists: entries.length > 0,
  journalName: stream.journalName,
  ownerId: stream.ownerId,
  schemaEvidence,
  schemasPresent: schemaEvidence === 'absent' ? [] : stream.schemas,
});
const currentCore = observation(core, [first, second], VERIFIED_TARGET);
const currentRetained = observation(retained, [first, second], VERIFIED_TARGET);
const pendingFeature = observation(feature, [first], OBSERVED_JOURNAL);
const selected: ApplicationMigrationRequirements = { mode: 'selected', owners: [requirement('feature')] };

it.effect('selects only the required owner and retained Core/B verifiers independently of artifact builds', () =>
  Effect.gen(function* requiredClosure() {
    const plan = yield* selectApplicationMigrationPlan(selected, inventory, [
      currentCore,
      currentRetained,
      pendingFeature,
    ]);
    expect(plan.initializationOwners).toEqual(['core', 'retained', 'feature']);
    expect(
      plan.owners.map((entry) => ({ ownerId: entry.ownerId, pending: entry.pendingMigrations, verify: entry.verify })),
    ).toEqual([
      { ownerId: 'core', pending: [], verify: true },
      { ownerId: 'retained', pending: [], verify: true },
      { ownerId: 'feature', pending: [second], verify: true },
    ]);
    expect(plan.initializationOwners).not.toContain('unrelated');
    expect(plan.owners[2]?.before).toEqual(pendingFeature);
    expect(plan.owners[2]?.verification).toBe('pending');
  }),
);

it.effect('does not invent a migration for a rebuilt owner whose actual journal is already current', () =>
  Effect.gen(function* currentOwner() {
    const plan = yield* selectApplicationMigrationPlan(selected, inventory, [
      currentCore,
      currentRetained,
      observation(feature, [first, second], VERIFIED_TARGET),
    ]);
    expect(plan.owners.flatMap((entry) => entry.pendingMigrations)).toEqual([]);
    expect(plan.owners[2]?.verification).toBe('verified');
  }),
);

it.effect('keeps a required verifier pending when a current journal has only observed-journal evidence', () =>
  Effect.gen(function* verificationIsIndependent() {
    const before = observation(feature, [first, second], OBSERVED_JOURNAL);
    const plan = yield* selectApplicationMigrationPlan(selected, inventory, [currentCore, currentRetained, before]);
    expect(plan.owners[2]?.pendingMigrations).toEqual([]);
    expect(plan.owners[2]?.verification).toBe('pending');
    expect(plan.owners[2]?.before.catalogFingerprint).toBe('c'.repeat(64));
  }),
);

it.effect('plans a clean owner install from explicit absent schema/journal evidence', () =>
  Effect.gen(function* cleanInstall() {
    const plan = yield* selectApplicationMigrationPlan(selected, inventory, [
      currentCore,
      currentRetained,
      observation(feature, [], 'absent'),
    ]);
    expect(plan.owners[2]?.pendingMigrations).toEqual([first, second]);
    expect(plan.owners[2]?.verification).toBe('pending');
  }),
);

it.effect('none initializes nothing and does not claim any migration or verifier was executed', () =>
  Effect.gen(function* noImpact() {
    const plan = yield* selectApplicationMigrationPlan({ mode: 'none', owners: [] }, inventory, []);
    expect(plan).toEqual({ initializationOwners: [], mode: 'none', owners: [], schemaVersion: 1 });
  }),
);

it.effect('all preserves independent primary/auth streams and includes optional portal auth only when named', () =>
  Effect.gen(function* allOwners() {
    const contacts = owner('contacts', [requirement('core')]);
    const party = owner('party', [requirement('contacts')]);
    const auth = owner('auth', [requirement('core')]);
    const portal = owner('portal', [requirement('core')], true);
    const streams = [party, auth, core, contacts, portal];
    const observations = streams.map((stream) => observation(stream, [first, second], VERIFIED_TARGET));
    const primary = yield* selectApplicationMigrationPlan({ mode: 'all', owners: [] }, streams, observations);
    expect(primary.initializationOwners).toEqual(['core', 'contacts', 'party', 'auth']);
    const withPortal = yield* selectApplicationMigrationPlan(
      { mode: 'all', owners: [requirement('portal')] },
      streams,
      observations,
    );
    expect(withPortal.initializationOwners).toEqual(['core', 'contacts', 'party', 'auth', 'portal']);
    expect(withPortal.owners.every((entry) => entry.pendingMigrations.length === 0)).toBe(true);
  }),
);

it.effect('uses source inventory order and declared prerequisites regardless of root and observation input order', () =>
  Effect.gen(function* deterministicSelection() {
    const requirements = [requirement('feature'), requirement('unrelated')];
    const observations = [currentCore, currentRetained, pendingFeature, observation(unrelated, [], 'absent')];
    const forward = yield* selectApplicationMigrationPlan(
      { mode: 'selected', owners: requirements },
      inventory,
      observations,
    );
    const reversed = yield* selectApplicationMigrationPlan(
      { mode: 'selected', owners: EffectArray.reverse(requirements) },
      inventory,
      EffectArray.reverse(observations),
    );
    expect(reversed).toEqual(forward);
  }),
);

it.effect('honors a reviewed migration bound and rejects a journal beyond that target', () =>
  Effect.gen(function* boundedTarget() {
    const bounded = {
      mode: 'selected' as const,
      owners: [{ ...requirement('feature'), throughMigration: first.name }],
    };
    const plan = yield* selectApplicationMigrationPlan(bounded, inventory, [
      currentCore,
      currentRetained,
      pendingFeature,
    ]);
    expect(plan.owners[2]?.pendingMigrations).toEqual([]);
    expect(plan.owners[2]?.throughMigration).toBe(first.name);
    const allBounded = yield* selectApplicationMigrationPlan({ mode: 'all', owners: bounded.owners }, inventory, [
      currentCore,
      currentRetained,
      pendingFeature,
      observation(unrelated, [first, second], VERIFIED_TARGET),
    ]);
    expect(allBounded.owners.find((entry) => entry.ownerId === 'feature')?.pendingMigrations).toEqual([]);
    const conflict = yield* selectApplicationMigrationPlan(
      { mode: 'selected', owners: [requirement('core'), requirement('feature')] },
      [core, { ...feature, prerequisites: [{ ...requirement('core'), throughMigration: first.name }] }],
      [currentCore, pendingFeature],
    ).pipe(Effect.flip);
    expect(Schema.is(ApplicationMigrationPlanError)(conflict)).toBe(true);
    const failure = yield* selectApplicationMigrationPlan(bounded, inventory, [
      currentCore,
      currentRetained,
      observation(feature, [first, second], VERIFIED_TARGET),
    ]).pipe(Effect.flip);
    expect(Schema.is(ApplicationMigrationPlanError)(failure)).toBe(true);
  }),
);

it.effect('fails closed for unknown owners, invalid roots and missing selected native observations', () =>
  Effect.gen(function* invalidRequirements() {
    const invalid: readonly ApplicationMigrationRequirements[] = [
      { mode: 'selected', owners: [requirement('unknown')] },
      { mode: 'selected', owners: [requirement('feature'), requirement('feature')] },
      { mode: 'none', owners: [requirement('feature')] },
      { mode: 'selected', owners: [] },
      { mode: 'selected', owners: [requirement('feature', false, false)] },
      { mode: 'selected', owners: [{ ...requirement('feature'), throughMigration: '20260103000000_unknown' }] },
    ];
    for (const requirements of invalid) {
      const failure = yield* selectApplicationMigrationPlan(requirements, inventory, [
        currentCore,
        currentRetained,
        pendingFeature,
      ]).pipe(Effect.flip);
      expect(Schema.is(ApplicationMigrationPlanError)(failure)).toBe(true);
    }
    const missing = yield* selectApplicationMigrationPlan(selected, inventory, [currentCore, pendingFeature]).pipe(
      Effect.flip,
    );
    expect(Schema.is(ApplicationMigrationPlanError)(missing)).toBe(true);
  }),
);

it.effect('fails closed on dependency cycles and independent streams sharing a journal', () =>
  Effect.gen(function* invalidInventory() {
    const cyclic = [owner('feature', [requirement('retained')]), owner('retained', [requirement('feature')])];
    const cycle = yield* selectApplicationMigrationPlan(selected, cyclic, []).pipe(Effect.flip);
    expect(Schema.is(ApplicationMigrationPlanError)(cycle)).toBe(true);
    const shared = yield* selectApplicationMigrationPlan(
      selected,
      [core, { ...feature, journalName: core.journalName }],
      [],
    ).pipe(Effect.flip);
    expect(Schema.is(ApplicationMigrationPlanError)(shared)).toBe(true);
  }),
);

it.effect('fails closed on name/hash divergence, unknown journal names and inconsistent native schema evidence', () =>
  Effect.gen(function* inconsistentEvidence() {
    const invalid: readonly ApplicationMigrationObservation[] = [
      { ...pendingFeature, journalName: '__drizzle_migrations_wrong' },
      { ...pendingFeature, entries: [{ ...first, hash: 'd'.repeat(64) }] },
      { ...pendingFeature, entries: [{ ...second, name: '20260103000000_unknown' }] },
      { ...pendingFeature, entries: [first, first] },
      { ...pendingFeature, journalExists: false },
      { ...pendingFeature, entries: [] },
      { ...pendingFeature, schemaEvidence: 'inconsistent' },
      { ...pendingFeature, schemaEvidence: 'absent' },
      { ...pendingFeature, schemasPresent: [] },
      { ...pendingFeature, catalogFingerprint: '' },
    ];
    for (const evidence of invalid) {
      const failure = yield* selectApplicationMigrationPlan(selected, inventory, [
        currentCore,
        currentRetained,
        evidence,
      ]).pipe(Effect.flip);
      expect(Schema.is(ApplicationMigrationPlanError)(failure)).toBe(true);
    }
  }),
);

it.effect('preserves compatible completion expansions applied before another required Core migration', () =>
  Effect.gen(function* sparseCompletionJournal() {
    const completion = { hash: 'a'.repeat(64), name: '20261019161320_outbox-composition-completion' };
    const pending = { hash: 'b'.repeat(64), name: '20261020120000_owner_expansion' };
    const resolution = { hash: 'd'.repeat(64), name: '20261029194254_outbox-delivery-resolution' };
    const stream = { ...core, migrations: [completion, pending, resolution] };
    const before = observation(stream, [resolution, completion], OBSERVED_JOURNAL);
    const plan = yield* selectApplicationMigrationPlan(
      { mode: 'selected', owners: [requirement('core')] },
      [stream],
      [before],
    );
    expect(plan.owners[0]?.pendingMigrations).toEqual([pending]);
    expect(plan.owners[0]?.before.entries).toEqual([completion, resolution]);
    expect(plan.owners[0]?.before.catalogFingerprint).toBe(before.catalogFingerprint);
    expect(plan.owners[0]?.verification).toBe('pending');
  }),
);

it.effect(
  'resolves exact prerequisite initialization before requesting any native observations or owner configuration',
  () =>
    Effect.gen(function* sourceOnlyClosure() {
      const resolved = yield* resolveApplicationMigrationRequirements(selected, inventory);
      expect(resolved).toEqual([requirement('core', false), requirement('retained', false), requirement('feature')]);
      const none = yield* resolveApplicationMigrationRequirements({ mode: 'none', owners: [] }, inventory);
      expect(none).toEqual([]);
    }),
);
