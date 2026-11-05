import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { OWNER_REMOVAL_ROUTES, guardOwnerRemoval, ownerRemovalBlocked } from '../../src/access/lifecycle/owners.ts';
import { clockDates, ids, ownerRecord } from './access-lifecycle-support.ts';

const soleOwner = ownerRecord({ principalId: ids.principal(1) });
const otherOwner = ownerRecord({ principalId: ids.principal(2) });
const routesWithoutSuccessor = OWNER_REMOVAL_ROUTES.filter((route) => route !== 'transfer');

it.effect('refuses to end the last owner through every removal route', () =>
  Effect.gen(function* lastOwnerIsNeverRemoved() {
    for (const route of routesWithoutSuccessor) {
      const failure = yield* Effect.flip(guardOwnerRemoval({ owners: [soleOwner], removing: ids.principal(1), route }));
      expect(failure.code).toBe('last_owner_removal');
    }
  }),
);

it.effect('treats a transfer as an addition of the successor in the same operation', () =>
  Effect.gen(function* transferNeedsSuccessor() {
    const withoutSuccessor = yield* Effect.flip(
      guardOwnerRemoval({ owners: [soleOwner], removing: ids.principal(1), route: 'transfer' }),
    );
    expect(withoutSuccessor.code).toBe('owner_transfer_without_successor');

    const transfer = yield* guardOwnerRemoval({
      adding: [otherOwner],
      owners: [soleOwner],
      removing: ids.principal(1),
      route: 'transfer',
    });
    expect(transfer.liveOwnerIds).toEqual([ids.principal(2)]);
  }),
);

it.effect('allows a removal while another owner can still administer, and reports the next expiry', () =>
  Effect.gen(function* removalKeepsAnAdministrator() {
    const { future } = yield* clockDates;
    const outcome = yield* guardOwnerRemoval({
      owners: [soleOwner, ownerRecord({ membershipValidUntil: future, principalId: ids.principal(2) })],
      removing: ids.principal(1),
      route: 'member_removal',
    });
    expect(outcome.liveOwnerIds).toEqual([ids.principal(2)]);
    expect(Option.getOrUndefined(outcome.nextOwnerEndsAt)).toBe(future);
  }),
);

it.effect('does not count a suspended owner or an owner whose membership already ended', () =>
  Effect.gen(function* inactiveOwnersDoNotCount() {
    const { past } = yield* clockDates;
    for (const inactive of [
      ownerRecord({ principalId: ids.principal(2), status: 'suspended' }),
      ownerRecord({ membershipValidUntil: past, principalId: ids.principal(2) }),
    ]) {
      const failure = yield* Effect.flip(
        guardOwnerRemoval({ owners: [soleOwner, inactive], removing: ids.principal(1), route: 'demotion' }),
      );
      expect(failure.code).toBe('last_owner_removal');
    }
  }),
);

it.effect('blocks the removal in the editor preview exactly when the guard refuses it', () =>
  Effect.gen(function* previewAgreesWithTheGuard() {
    const { now } = yield* clockDates;
    expect(ownerRemovalBlocked({ owners: [soleOwner], removing: ids.principal(1), route: 'departure' }, now)).toBe(
      true,
    );
    expect(
      ownerRemovalBlocked({ owners: [soleOwner, otherOwner], removing: ids.principal(1), route: 'departure' }, now),
    ).toBe(false);
    const refused = yield* Effect.flip(
      guardOwnerRemoval({ owners: [soleOwner], removing: ids.principal(1), route: 'departure' }),
    );
    expect(refused.code).toBe('last_owner_removal');
  }),
);
