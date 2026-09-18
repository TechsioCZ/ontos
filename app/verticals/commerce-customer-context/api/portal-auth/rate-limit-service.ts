import { Context } from 'effect';

import type { Effect } from 'effect';

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
