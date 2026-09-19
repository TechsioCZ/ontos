import { Context, Effect } from 'effect';

import type { CommercePortalAuthRecoveryProviderFailure } from './provider/recovery/provider-failure.ts';

export interface CommercePortalAuthRecoveryRateLimitRule {
  readonly max: number;
  readonly windowSeconds: number;
}

/**
 * The deployment's one durable portal-auth budget, spent by every portal-auth group: Better Auth
 * applies its configured `rateLimit` rules only inside `auth.handler`'s router, which no portal-auth
 * transport mounts, so the owner re-applies them here against the same `rate_limit` rows the
 * provider itself wrote.
 *
 * Answers `false` once the budget for the key is spent. A store failure is a provider failure, so a
 * caller that cannot read the budget refuses the request instead of serving it uncounted.
 */
export interface CommercePortalAuthRecoveryRateLimit {
  readonly consume: (
    key: string,
    rule: CommercePortalAuthRecoveryRateLimitRule,
  ) => Effect.Effect<boolean, CommercePortalAuthRecoveryProviderFailure>;
}

export class CommercePortalAuthRecoveryRateLimitService extends Context.Service<
  CommercePortalAuthRecoveryRateLimitService,
  CommercePortalAuthRecoveryRateLimit
>()('@app/commerce-customer-context/api/portal-auth/rate-limit-service/CommercePortalAuthRecoveryRateLimitService') {}

/**
 * Every portal-auth group spends its budget the same way: consume the key against the rule, and if
 * the durable store itself fails, log the classified failure against the route and answer the
 * group's own unavailable problem instead of serving the request uncounted. What differs per group
 * is the key, the rule, the route label on the log, and the unavailable problem to raise.
 */
export const consumeRateLimitBudget = Effect.fn('RateLimitService.consumeRateLimitBudget')(
  function* consumeRateLimitBudgetEffect<UnavailableProblem>(
    key: string,
    rule: CommercePortalAuthRecoveryRateLimitRule,
    options: {
      readonly route: string;
      readonly unavailable: (failure: CommercePortalAuthRecoveryProviderFailure) => UnavailableProblem;
    },
  ) {
    const budget = yield* CommercePortalAuthRecoveryRateLimitService;
    return yield* budget.consume(key, rule).pipe(
      Effect.catchTag('CommercePortalAuthRecoveryProviderFailure', (failure) =>
        Effect.annotateLogs(Effect.logError('Commerce portal rate limit budget could not be spent', failure), {
          operation: failure.operation,
          route: options.route,
        }).pipe(Effect.andThen(Effect.fail(options.unavailable(failure)))),
      ),
    );
  },
);
