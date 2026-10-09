import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ApplicationReleaseIntentError, selectApplicationReleaseUnits } from '../application-release-intent.mts';
import type { ApplicationReleaseDeploymentUnit } from '../application-release-intent.mts';

const CATALOG = 'commerce-market-catalog';
const INVENTORY = 'inventory';
const PARTY = 'party-registry';
const SHELL = 'shell-super-app';
const unit = (id: string): ApplicationReleaseDeploymentUnit => ({
  id,
  packageName: `@app/${id}`,
  path: id === SHELL ? `apps/${id}` : `verticals/${id}`,
  workerName: `ontos-${id}`,
});
const available = [unit(CATALOG), unit(INVENTORY), unit(PARTY), unit(SHELL)];

it.effect('rebuilds the exact full reviewed module set even when the impact planner names different modules', () =>
  Effect.gen(function* fullReviewedSet() {
    const selected = yield* selectApplicationReleaseUnits(
      { modules: [{ appId: INVENTORY }, { appId: CATALOG }] },
      available,
      [{ id: PARTY }],
    );
    expect(selected).toEqual([unit(INVENTORY), unit(CATALOG)]);
    expect(selected.map(({ id }) => id)).not.toContain(PARTY);
    expect(selected.map(({ id }) => id)).not.toContain(SHELL);
  }),
);

it.effect('adds the changed Shell once while leaving an unchanged Shell deployment out of the release build', () =>
  Effect.gen(function* changedShellOnly() {
    const intent = { modules: [{ appId: INVENTORY }] };
    const unchanged = yield* selectApplicationReleaseUnits(intent, available, []);
    const changed = yield* selectApplicationReleaseUnits(intent, available, [{ id: SHELL }, { id: SHELL }]);
    expect(unchanged).toEqual([unit(INVENTORY)]);
    expect(changed).toEqual([unit(INVENTORY), unit(SHELL)]);
  }),
);

it.effect('never infers module membership from all available installations or impacted units', () =>
  Effect.gen(function* explicitMembershipOnly() {
    const selected = yield* selectApplicationReleaseUnits({ modules: [] }, available, [
      { id: INVENTORY },
      { id: CATALOG },
      { id: PARTY },
    ]);
    expect(selected).toEqual([]);
  }),
);

it.effect('refuses duplicate, unknown, or Shell entries in the reviewed business module selection', () =>
  Effect.gen(function* invalidReviewedSet() {
    const invalidModules = [
      [{ appId: INVENTORY }, { appId: INVENTORY }],
      [{ appId: 'undeclared-owner' }],
      [{ appId: SHELL }],
    ];
    for (const modules of invalidModules) {
      const failure = yield* selectApplicationReleaseUnits({ modules }, available, []).pipe(Effect.flip);
      expect(Schema.is(ApplicationReleaseIntentError)(failure)).toBe(true);
    }
  }),
);

it.effect('refuses a changed Shell that has no executable placement', () =>
  Effect.gen(function* missingShellPlacement() {
    const failure = yield* selectApplicationReleaseUnits(
      { modules: [{ appId: INVENTORY }] },
      available.filter(({ id }) => id !== SHELL),
      [{ id: SHELL }],
    ).pipe(Effect.flip);
    expect(Schema.is(ApplicationReleaseIntentError)(failure)).toBe(true);
  }),
);

it.effect('rejects ambiguous execution placement instead of silently choosing a duplicate owner', () =>
  Effect.gen(function* duplicateExecutionPlacement() {
    const failure = yield* selectApplicationReleaseUnits(
      { modules: [{ appId: INVENTORY }] },
      [...available, { ...unit(INVENTORY), packageName: '@app/other-inventory', path: 'verticals/other-inventory' }],
      [],
    ).pipe(Effect.flip);
    expect(Schema.is(ApplicationReleaseIntentError)(failure)).toBe(true);
  }),
);
