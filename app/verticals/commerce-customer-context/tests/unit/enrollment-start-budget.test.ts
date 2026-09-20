import { randomUUID } from 'node:crypto';

import { Effect, Ref } from 'effect';
import { expect, it } from 'effect-rstest';

import { commercePortalAuthEnrollmentBudget } from '../../api/portal-auth/enrollment/http.ts';
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
const ROUTE_BUDGET = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.default.max;
const RATE_LIMITED_STATUS = 429;
const ALLOWED = 'ALLOWED';

const allowances = (length: number): readonly string[] => Array.from({ length }, () => ALLOWED);

/**
 * The durable counter store's own contract, without PostgreSQL: one budget per key, shared by every
 * holder of the store, answering `false` once the rule's allowance for that key is spent.
 */
const makeBudgetFixture = Effect.fnUntraced(function* makeBudgetFixture() {
  const configuration = yield* parseCommercePortalAuthConfig(CONFIGURATION_ENVIRONMENT).pipe(Effect.orDie);
  const counts = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const budget: CommercePortalAuthRecoveryRateLimit = {
    consume: (key, rule) =>
      Ref.modify(counts, (recorded) => {
        const spent = (recorded.get(key) ?? 0) + 1;
        return [spent <= rule.max, new Map([...recorded, [key, spent]])] as const;
      }),
  };
  return {
    /** Every key this store was ever asked to charge, which is what a refusal must not add to. */
    keys: Ref.get(counts).pipe(Effect.map((recorded) => [...recorded.keys()])),
    start: (principalId: string, email: string) =>
      commercePortalAuthEnrollmentBudget(principalId, email).pipe(
        Effect.match({ onFailure: (problem) => String(problem.status), onSuccess: () => ALLOWED }),
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
      () => fixture.start(enroller, email),
      { concurrency: 1 },
    );
    expect(spent).toStrictEqual(allowances(ADDRESS_BUDGET));

    // The per-address rule is kept for the Principal that spent it: the caller that already made
    // this address' starts gets no more of them.
    expect(yield* fixture.start(enroller, email)).toBe(String(RATE_LIMITED_STATUS));

    // A different Principal enrolling the very same address is untouched by that. Keyed by the
    // transport's unattributable client instead of the verified Principal, this start is refused
    // too — and then any holder of any valid assertion can lock any address out of account creation
    // for the window, replaying one assertion, because the gate above the budget only reads it.
    expect(yield* fixture.start(randomUUID(), email)).toBe(ALLOWED);
  }),
);

it.effect('stops a Principal walking fresh addresses, and charges the address it was stopped on nothing', () =>
  Effect.gen(function* routeBudgetIsPerPrincipal() {
    const fixture = yield* makeBudgetFixture();
    const enroller = randomUUID();
    const run = randomUUID();

    const spent = yield* Effect.forEach(
      Array.from({ length: ROUTE_BUDGET }, (_unused, index) => index),
      (index) => fixture.start(enroller, `enrollment-${index}-${run}@example.test`),
      { concurrency: 1 },
    );
    expect(spent).toStrictEqual(allowances(ROUTE_BUDGET));

    // One route-wide key for the Principal, and one narrow key per address it named.
    expect(yield* fixture.keys).toHaveLength(ROUTE_BUDGET + 1);

    // A never-before-seen address buys this Principal no further start. The per-address rule alone
    // bounds only (Principal, address) pairs, so without a route-wide one a caller's own total is
    // unbounded: it need only name a new address each time.
    expect(yield* fixture.start(enroller, `enrollment-past-${run}@example.test`)).toBe(String(RATE_LIMITED_STATUS));

    // The address it was refused on was charged nothing, so a caller out of starts cannot take an
    // address it never enrolled down with it: the store holds no key for that address at all.
    expect(yield* fixture.keys).toHaveLength(ROUTE_BUDGET + 1);
  }),
);
