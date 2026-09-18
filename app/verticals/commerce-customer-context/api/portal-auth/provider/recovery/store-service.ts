import { Context } from 'effect';

import type { Effect, Option, Redacted } from 'effect';

import type { CommercePortalAuthEmailVerificationTokenRegistration } from './contracts.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../../rate-limit-service.ts';
import type { CommercePortalAuthRecoveryUnavailable } from './unavailable.ts';

export interface CommercePortalAuthRecoveryStore {
  readonly consumeEmailVerification: (input: {
    readonly now: Date;
    readonly token: Redacted.Redacted;
  }) => Effect.Effect<Option.Option<string>, CommercePortalAuthRecoveryUnavailable>;
  /**
   * Spends one unit of the durable budget the key names, answering `false` once the rule's window
   * is exhausted. The counter lives in the deployment's own store, so concurrent replicas spend one
   * budget; a store that cannot answer fails instead of granting an uncounted request.
   */
  readonly consumeRateLimitBudget: (input: {
    readonly key: string;
    readonly rule: CommercePortalAuthRecoveryRateLimitRule;
  }) => Effect.Effect<boolean, CommercePortalAuthRecoveryUnavailable>;
  readonly registerEmailVerificationToken: (
    input: CommercePortalAuthEmailVerificationTokenRegistration & {
      readonly expiresAt: Date;
    },
  ) => Effect.Effect<boolean, CommercePortalAuthRecoveryUnavailable>;
  readonly reserveEmailVerificationSubject: (input: {
    readonly email: string;
    readonly providerSubjectId: string;
  }) => Effect.Effect<boolean, CommercePortalAuthRecoveryUnavailable>;
}

export class CommercePortalAuthRecoveryStoreService extends Context.Service<
  CommercePortalAuthRecoveryStoreService,
  CommercePortalAuthRecoveryStore
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/recovery/store-service/CommercePortalAuthRecoveryStoreService',
) {}
