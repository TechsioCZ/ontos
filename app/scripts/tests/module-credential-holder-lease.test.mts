import { Effect, Ref } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { holdModuleCredentialLeaseOnce, initialModuleCredentialLeaseWatch } from '../zerops/app-host.mts';

const OWN_BOOT = '70000000-0000-4000-8000-000000000001';
const PEER_BOOT = '70000000-0000-4000-8000-000000000002';
const LATE_PEER_BOOT = '70000000-0000-4000-8000-000000000003';

/** One host's lease steps against a lease table the test controls. */
const leaseHarness = Effect.gen(function* makeLeaseHarness() {
  const live = yield* Ref.make<readonly string[] | undefined>([OWN_BOOT]);
  const holding = yield* Ref.make(true);
  const renewals = yield* Ref.make<'fail' | 'ok'>('ok');
  const retirements = yield* Ref.make(0);
  const watch = yield* Ref.make(initialModuleCredentialLeaseWatch);
  const step = holdModuleCredentialLeaseOnce(
    {
      bootId: OWN_BOOT,
      hold: Effect.flatMap(Ref.get(renewals), (renewal) =>
        renewal === 'ok' ? Effect.void : Effect.fail('the lease table refused'),
      ),
      holding: Ref.get(holding),
      liveBoots: Effect.flatMap(Ref.get(live), (boots) =>
        boots === undefined ? Effect.fail('unreadable') : Effect.succeed(new Set(boots)),
      ),
      retire: Ref.update(retirements, (count) => count + 1),
    },
    watch,
  );
  return { holding, live, renewals, retirements, step };
});

describe("a boot's module credential holder lease", () => {
  it.effect('retires nothing while peers of the release boot and keep renewing', () =>
    Effect.gen(function* peersBoot() {
      const lease = yield* leaseHarness;
      yield* lease.step;
      yield* Ref.set(lease.live, [OWN_BOOT, PEER_BOOT]);
      yield* lease.step;
      yield* Ref.set(lease.live, [OWN_BOOT, PEER_BOOT, LATE_PEER_BOOT]);
      yield* lease.step;
      yield* lease.step;
      expect(yield* Ref.get(lease.retirements)).toBe(0);
    }),
  );

  it.effect("runs the retirement once, at the first step after a peer's lease ended", () =>
    Effect.gen(function* peerDies() {
      const lease = yield* leaseHarness;
      yield* Ref.set(lease.live, [OWN_BOOT, PEER_BOOT]);
      yield* lease.step;
      yield* Ref.set(lease.live, [OWN_BOOT]);
      yield* lease.step;
      expect(yield* Ref.get(lease.retirements)).toBe(1);
      yield* lease.step;
      expect(yield* Ref.get(lease.retirements)).toBe(1);
    }),
  );

  it.effect('waits for the authority before retiring, and an unreadable table is no evidence', () =>
    Effect.gen(function* notHolding() {
      const lease = yield* leaseHarness;
      yield* Ref.set(lease.holding, false);
      yield* Ref.set(lease.live, [OWN_BOOT, PEER_BOOT]);
      yield* lease.step;
      yield* Ref.set(lease.live, undefined);
      yield* lease.step;
      expect(yield* Ref.get(lease.retirements)).toBe(0);
      // The peer ended while this host did not hold the authority: it retires once it does.
      yield* Ref.set(lease.live, [OWN_BOOT]);
      yield* lease.step;
      expect(yield* Ref.get(lease.retirements)).toBe(0);
      yield* Ref.set(lease.holding, true);
      yield* lease.step;
      expect(yield* Ref.get(lease.retirements)).toBe(1);
    }),
  );

  it.effect('never treats the end of its own lease as a peer that died', () =>
    Effect.gen(function* ownLeaseFails() {
      const lease = yield* leaseHarness;
      yield* lease.step;
      yield* Ref.set(lease.renewals, 'fail');
      yield* Ref.set(lease.live, []);
      yield* lease.step;
      expect(yield* Ref.get(lease.retirements)).toBe(0);
    }),
  );
});
