import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ApplicationReleaseIntentError,
  ApplicationReleaseIntentSchema,
  ApplicationReleaseSelectionSchema,
  selectApplicationReleaseUnits,
} from '../application-release-intent.mts';
import type { ApplicationReleaseDeploymentUnit } from '../application-release-intent.mts';

const CATALOG = 'commerce-market-catalog';
const INVENTORY = 'inventory';
const PARTY = 'party-registry';
const SHELL = 'shell-super-app';
const FRESH = 'fresh';
const RETAINED = 'retained';
const unit = (id: string): ApplicationReleaseDeploymentUnit => ({
  id,
  packageName: `@app/${id}`,
  path: id === SHELL ? `apps/${id}` : `verticals/${id}`,
  workerName: `ontos-${id}`,
});
const available = [unit(CATALOG), unit(INVENTORY), unit(PARTY), unit(SHELL)];
const membership = [{ appId: INVENTORY }, { appId: CATALOG }];

it.effect('first release builds every desired slot and the separate Shell without assuming retained evidence', () =>
  Effect.gen(function* firstRelease() {
    const selected = yield* selectApplicationReleaseUnits({ modules: membership }, available, []);
    expect(selected).toEqual({
      complete: [unit(INVENTORY), unit(CATALOG)],
      fresh: [unit(INVENTORY), unit(CATALOG)],
      removed: [],
      retained: [],
      shell: { mode: FRESH, unit: unit(SHELL) },
    });
    expect(yield* Schema.decodeUnknownEffect(ApplicationReleaseSelectionSchema)(selected)).toEqual(selected);
  }),
);

it.effect('zero impact keeps the complete reviewed membership and partitions all existing slots as retained', () =>
  Effect.gen(function* zeroImpact() {
    const baseline = yield* makeApplicationCompositionSnapshotFixture([CATALOG, INVENTORY]);
    const selected = yield* selectApplicationReleaseUnits({ modules: membership }, available, [], baseline);
    expect(selected.complete).toEqual([unit(INVENTORY), unit(CATALOG)]);
    expect(selected.fresh).toEqual([]);
    expect(selected.retained).toEqual(selected.complete);
    expect(selected.shell).toEqual({ mode: RETAINED, unit: unit(SHELL) });
  }),
);

it.effect('one impacted owner is fresh while the other complete slot retains its existing baseline membership', () =>
  Effect.gen(function* oneOwnerImpact() {
    const baseline = yield* makeApplicationCompositionSnapshotFixture([CATALOG, INVENTORY]);
    const selected = yield* selectApplicationReleaseUnits(
      { modules: membership },
      available,
      [{ id: INVENTORY }],
      baseline,
    );
    expect(selected.complete).toEqual([unit(INVENTORY), unit(CATALOG)]);
    expect(selected.fresh).toEqual([unit(INVENTORY)]);
    expect(selected.retained).toEqual([unit(CATALOG)]);
  }),
);

it.effect('consumes the already-computed shared and transitive impact closure without narrowing it', () =>
  Effect.gen(function* sharedImpactClosure() {
    const baseline = yield* makeApplicationCompositionSnapshotFixture([PARTY, CATALOG, INVENTORY]);
    const selected = yield* selectApplicationReleaseUnits(
      { modules: [...membership, { appId: PARTY }] },
      available,
      [{ id: CATALOG }, { id: INVENTORY }],
      baseline,
    );
    expect(selected.fresh).toEqual([unit(INVENTORY), unit(CATALOG)]);
    expect(selected.retained).toEqual([unit(PARTY)]);
    expect(selected.complete).toEqual([unit(INVENTORY), unit(CATALOG), unit(PARTY)]);
  }),
);

it.effect('new desired membership builds its new slot even when source impact is empty', () =>
  Effect.gen(function* addedOwner() {
    const baseline = yield* makeApplicationCompositionSnapshotFixture([INVENTORY]);
    const selected = yield* selectApplicationReleaseUnits({ modules: membership }, available, [], baseline);
    expect(selected.fresh).toEqual([unit(CATALOG)]);
    expect(selected.retained).toEqual([unit(INVENTORY)]);
  }),
);

it.effect('records removed baseline slots without requiring their old execution placement or keeping them in N', () =>
  Effect.gen(function* removedOwner() {
    const baseline = yield* makeApplicationCompositionSnapshotFixture([PARTY, INVENTORY]);
    const selected = yield* selectApplicationReleaseUnits(
      { modules: [{ appId: INVENTORY }] },
      available.filter(({ id }) => id !== PARTY),
      [],
      baseline,
    );
    expect(selected.complete).toEqual([unit(INVENTORY)]);
    expect(selected.removed).toEqual([{ appId: PARTY }]);
    expect(selected.fresh).toEqual([]);
  }),
);

it.effect('known impacted owners outside desired membership never become installed slots', () =>
  Effect.gen(function* explicitMembershipOnly() {
    const baseline = yield* makeApplicationCompositionSnapshotFixture([INVENTORY]);
    const selected = yield* selectApplicationReleaseUnits(
      { modules: [{ appId: INVENTORY }] },
      available,
      [{ id: PARTY }, { id: CATALOG }],
      baseline,
    );
    expect(selected.complete).toEqual([unit(INVENTORY)]);
    expect(selected.fresh).toEqual([]);
    expect(selected.retained).toEqual([unit(INVENTORY)]);
  }),
);

it.effect('an explicitly empty business membership remains empty and records all previous business removals', () =>
  Effect.gen(function* noBusinessMembership() {
    const baseline = yield* makeApplicationCompositionSnapshotFixture([PARTY, INVENTORY]);
    const selected = yield* selectApplicationReleaseUnits({ modules: [] }, available, [{ id: CATALOG }], baseline);
    expect(selected.complete).toEqual([]);
    expect(selected.fresh).toEqual([]);
    expect(selected.retained).toEqual([]);
    expect(selected.removed).toEqual([{ appId: PARTY }, { appId: INVENTORY }]);
    expect(selected.shell.mode).toBe(RETAINED);
  }),
);

it.effect('a Shell-only impact builds Shell separately and keeps business slots retained', () =>
  Effect.gen(function* changedShellOnly() {
    const baseline = yield* makeApplicationCompositionSnapshotFixture([INVENTORY]);
    const selected = yield* selectApplicationReleaseUnits(
      { modules: [{ appId: INVENTORY }] },
      available,
      [{ id: SHELL }],
      baseline,
    );
    expect(selected.complete).toEqual([unit(INVENTORY)]);
    expect(selected.fresh).toEqual([]);
    expect(selected.retained).toEqual([unit(INVENTORY)]);
    expect(selected.shell).toEqual({ mode: FRESH, unit: unit(SHELL) });
  }),
);

it.effect('refuses duplicate, unknown, or Shell entries in reviewed business membership', () =>
  Effect.gen(function* invalidReviewedSet() {
    for (const modules of [
      [{ appId: INVENTORY }, { appId: INVENTORY }],
      [{ appId: 'undeclared-owner' }],
      [{ appId: SHELL }],
    ]) {
      const failure = yield* selectApplicationReleaseUnits({ modules }, available, []).pipe(Effect.flip);
      expect(Schema.is(ApplicationReleaseIntentError)(failure)).toBe(true);
    }
  }),
);

it.effect('rejects duplicate or missing execution placements instead of silently dropping required slots', () =>
  Effect.gen(function* invalidExecutionPlacement() {
    for (const placements of [
      [...available, unit(INVENTORY)],
      available.filter(({ id }) => id !== INVENTORY),
      available.filter(({ id }) => id !== SHELL),
    ]) {
      const failure = yield* selectApplicationReleaseUnits({ modules: [{ appId: INVENTORY }] }, placements, []).pipe(
        Effect.flip,
      );
      expect(Schema.is(ApplicationReleaseIntentError)(failure)).toBe(true);
    }
  }),
);

it.effect('rejects duplicate or unknown impacted deployments including duplicate Shell impact', () =>
  Effect.gen(function* invalidBuildImpact() {
    for (const impacted of [
      [{ id: INVENTORY }, { id: INVENTORY }],
      [{ id: SHELL }, { id: SHELL }],
      [{ id: 'unknown-impact' }],
    ]) {
      const failure = yield* selectApplicationReleaseUnits({ modules: membership }, available, impacted).pipe(
        Effect.flip,
      );
      expect(Schema.is(ApplicationReleaseIntentError)(failure)).toBe(true);
    }
  }),
);

it.effect('rejects duplicate baseline deployment slots without manufacturing retained membership', () =>
  Effect.gen(function* duplicateBaseline() {
    const baseline = yield* makeApplicationCompositionSnapshotFixture([INVENTORY]);
    const duplicate = {
      ...baseline,
      composition: {
        ...baseline.composition,
        modules: [...baseline.composition.modules, ...baseline.composition.modules],
      },
    };
    const failure = yield* selectApplicationReleaseUnits({ modules: membership }, available, [], duplicate).pipe(
      Effect.flip,
    );
    expect(Schema.is(ApplicationReleaseIntentError)(failure)).toBe(true);
  }),
);

it.effect('rejects a malformed baseline rather than treating it as an approved first release', () =>
  Effect.gen(function* invalidBaseline() {
    const baseline = yield* makeApplicationCompositionSnapshotFixture([INVENTORY]);
    const malformed = { ...baseline, validUntil: baseline.observedAt };
    const failure = yield* selectApplicationReleaseUnits({ modules: membership }, available, [], malformed).pipe(
      Effect.flip,
    );
    expect(Schema.isSchemaError(failure)).toBe(true);
  }),
);

it.effect('preserves reviewed migration requirements independently of zero fresh builds or complete membership', () =>
  Effect.gen(function* separateMigrationRequirements() {
    const intent = yield* Schema.decodeUnknownEffect(ApplicationReleaseIntentSchema)({
      migrationRequirements: { mode: 'selected', owners: [{ migrate: false, ownerId: 'core-runtime', verify: true }] },
      modules: [{ appId: INVENTORY }],
    });
    const baseline = yield* makeApplicationCompositionSnapshotFixture([INVENTORY]);
    const selected = yield* selectApplicationReleaseUnits(intent, available, [], baseline);
    expect(selected.fresh).toEqual([]);
    expect(selected.complete).toEqual([unit(INVENTORY)]);
    expect(selected.migrationRequirements).toBe(intent.migrationRequirements);
  }),
);
