import { randomUUID } from 'node:crypto';

import { Clock, Effect, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import {
  commercePortalAuthEnrollmentAddressBudget,
  commercePortalAuthEnrollmentPrincipalBudget,
} from '../../api/portal-auth/enrollment/http.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY, parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimit } from '../../api/portal-auth/rate-limit-service.ts';

/**
 * What one enrollment start may spend, and whose budget it spends.
 *
 * The start route decides this before it has redeemed anything: the gate above the budget verifies
 * the gateway assertion rather than redeeming it, so the same assertion can be presented again.
 * Whatever the budget is keyed by is therefore what one caller can exhaust, and the only caller
 * identity established that early is the Principal that verification named.
 */

const CONFIGURATION_ENVIRONMENT = {
  COMMERCE_PORTAL_AUTH_DATABASE_URL: 'postgresql://commerce:secret@example.test/commerce_auth',
  COMMERCE_PORTAL_AUTH_SECRET: 'd'.repeat(64),
  COMMERCE_PORTAL_AUTH_URL: 'https://portal.example.test',
};

const ADDRESS_BUDGET = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.accountCreation.max;
const PRINCIPAL_BUDGET = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.enrollmentStart.max;
const PRINCIPAL_WINDOW_SECONDS = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.enrollmentStart.windowSeconds;
const RATE_LIMITED_STATUS = 429;
const ALLOWED = 'ALLOWED';

const allowances = (length: number): readonly string[] => Array.from({ length }, () => ALLOWED);

/**
 * The durable counter store's own contract, without PostgreSQL: one budget per key, shared by every
 * holder of the store, answering `false` once the rule's allowance for that key is spent within its
 * window. A window is real here — the count for a key resets once `windowSeconds` has elapsed since
 * that key's first charge — so a fixture that never modelled expiry could not catch a route reusing
 * the wrong policy's window.
 */
const makeBudgetFixture = Effect.fnUntraced(function* makeBudgetFixture() {
  const configuration = yield* parseCommercePortalAuthConfig(CONFIGURATION_ENVIRONMENT).pipe(Effect.orDie);
  const counts = yield* Ref.make<ReadonlyMap<string, { readonly count: number; readonly windowStartMillis: number }>>(
    new Map(),
  );
  const budget: CommercePortalAuthRecoveryRateLimit = {
    consume: (key, rule) =>
      Effect.gen(function* consumeEffect() {
        const now = yield* Clock.currentTimeMillis;
        const recorded = yield* Ref.get(counts);
        const existing = recorded.get(key);
        const windowElapsed = existing === undefined || now - existing.windowStartMillis >= rule.windowSeconds * 1000;
        const windowStartMillis = windowElapsed ? now : existing.windowStartMillis;
        const spent = (windowElapsed ? 0 : existing.count) + 1;
        yield* Ref.set(counts, new Map([...recorded, [key, { count: spent, windowStartMillis }]]));
        return spent <= rule.max;
      }),
  };
  return {
    /** Every key this store was ever asked to charge, which is what a refusal must not add to. */
    keys: Ref.get(counts).pipe(Effect.map((recorded) => [...recorded.keys()])),
    startAddress: (principalId: string, email: string) =>
      commercePortalAuthEnrollmentAddressBudget(principalId, email).pipe(
        Effect.match({ onFailure: (problem) => String(problem.status), onSuccess: () => ALLOWED }),
        Effect.provideService(CommercePortalAuthRecoveryRateLimitService, budget),
        Effect.provideService(CommercePortalAuthConfig, configuration),
      ),
    startPrincipal: (principalId: string) =>
      commercePortalAuthEnrollmentPrincipalBudget(principalId).pipe(
        Effect.match({
          onFailure: (problem) => ({
            retryAfterSeconds: 'retryAfterSeconds' in problem ? problem.retryAfterSeconds : null,
            status: String(problem.status),
          }),
          onSuccess: () => ({ retryAfterSeconds: null, status: ALLOWED }),
        }),
        Effect.provideService(CommercePortalAuthRecoveryRateLimitService, budget),
        Effect.provideService(CommercePortalAuthConfig, configuration),
      ),
  };
});

it.effect('leaves a second Principal the whole address budget the first one exhausted', () =>
  Effect.gen(function* addressBudgetIsPerPrincipal() {
    const fixture = yield* makeBudgetFixture();
    const email = `enrollment-${randomUUID()}@example.test`;
    const enroller = randomUUID();

    const spent = yield* Effect.forEach(
      Array.from({ length: ADDRESS_BUDGET }, (_unused, index) => index),
      () => fixture.startAddress(enroller, email),
      { concurrency: 1 },
    );
    expect(spent).toStrictEqual(allowances(ADDRESS_BUDGET));

    // The per-address rule is kept for the Principal that spent it: the caller that already made
    // this address' starts gets no more of them.
    expect(yield* fixture.startAddress(enroller, email)).toBe(String(RATE_LIMITED_STATUS));

    // A different Principal enrolling the very same address is untouched by that.
    expect(yield* fixture.startAddress(randomUUID(), email)).toBe(ALLOWED);
  }),
);

it.effect(
  'stops a Principal walking fresh addresses inside the enrollment-start window, independent of the address budget',
  () =>
    Effect.gen(function* routeBudgetIsPerPrincipal() {
      const fixture = yield* makeBudgetFixture();
      const enroller = randomUUID();

      const spent = yield* Effect.forEach(
        Array.from({ length: PRINCIPAL_BUDGET }, (_unused, index) => index),
        () => fixture.startPrincipal(enroller),
        { concurrency: 1 },
      );
      expect(spent.map((answer) => answer.status)).toStrictEqual(allowances(PRINCIPAL_BUDGET));

      // One route-wide key for the Principal.
      expect(yield* fixture.keys).toHaveLength(1);

      // The Principal is out of starts for the rest of the enrollment-start window, regardless of
      // which address a further start would name — the route spends this budget before it ever
      // reads or names an address.
      const refused = yield* fixture.startPrincipal(enroller);
      expect(refused.status).toBe(String(RATE_LIMITED_STATUS));

      // The refusal reports the window of the rule that actually refused it: the enrollment-start
      // policy's hourly window, not the narrower per-address `accountCreation` window.
      expect(refused.retryAfterSeconds).toBe(PRINCIPAL_WINDOW_SECONDS);
    }),
);

it.effect('cannot be walked past by waiting out a window shorter than the enrollment-start hour', () =>
  Effect.gen(function* principalBudgetSurvivesAShortWait() {
    const fixture = yield* makeBudgetFixture();
    const enroller = randomUUID();

    const spent = yield* Effect.forEach(
      Array.from({ length: PRINCIPAL_BUDGET }, (_unused, index) => index),
      () => fixture.startPrincipal(enroller),
      { concurrency: 1 },
    );
    expect(spent.map((answer) => answer.status)).toStrictEqual(allowances(PRINCIPAL_BUDGET));

    // A window far shorter than the enrollment-start hour — the `rateLimit.default` window this
    // route used to reuse by mistake — must not reset the Principal's budget.
    yield* TestClock.adjust('60 seconds');
    expect((yield* fixture.startPrincipal(enroller)).status).toBe(String(RATE_LIMITED_STATUS));

    // Only once the full enrollment-start window has elapsed does the Principal buy a fresh start.
    yield* TestClock.adjust(`${PRINCIPAL_WINDOW_SECONDS - 60} seconds`);
    expect((yield* fixture.startPrincipal(enroller)).status).toBe(ALLOWED);
  }),
);
