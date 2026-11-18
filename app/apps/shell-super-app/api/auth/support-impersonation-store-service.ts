import { Context, Schema } from 'effect';
import type { Effect, Option, Redacted } from 'effect';

import type { supportImpersonationRecovery } from './db/schema.ts';
import type { SupportImpersonationUnavailableError } from './impersonation-service.ts';

export type SupportRecoveryRecord = Omit<typeof supportImpersonationRecovery.$inferSelect, 'createdAt'>;

/** The Core idempotency scope of one support impersonation start: Tenant, support principal and start key. */
export interface SupportImpersonationStartKey {
  readonly actionId: string;
  readonly originalPrincipalId: string;
  readonly tenantId: string;
}

/**
 * `claimed`: this request inserted the start claim and is the only one that asks the provider for a session.
 * `held`: another request claimed the key within the claim lease and may still be creating its session.
 * `lapsed`: another request claimed the key before the lease; it created its session or never will.
 */
export const SupportImpersonationStartClaimSchema = Schema.Literals(['claimed', 'held', 'lapsed']);
export type SupportImpersonationStartClaim = typeof SupportImpersonationStartClaimSchema.Type;

export interface SupportImpersonationStore {
  /** Claims a start key before the provider call; at most one request ever claims a key. */
  readonly claimStart: (
    key: SupportImpersonationStartKey,
  ) => Effect.Effect<SupportImpersonationStartClaim, SupportImpersonationUnavailableError>;
  readonly deleteRecovery: (
    impersonationSessionId: string,
  ) => Effect.Effect<void, SupportImpersonationUnavailableError>;
  readonly deleteSession: (sessionId: string) => Effect.Effect<void, SupportImpersonationUnavailableError>;
  readonly insertRecovery: (
    recovery: SupportRecoveryRecord,
  ) => Effect.Effect<void, SupportImpersonationUnavailableError>;
  readonly loadExpiredRecovery: (
    sessionToken: Redacted.Redacted,
  ) => Effect.Effect<Option.Option<SupportRecoveryRecord>, SupportImpersonationUnavailableError>;
  readonly loadOriginalSession: (
    sessionToken: Redacted.Redacted,
  ) => Effect.Effect<
    Option.Option<{ readonly expiresAt: Date; readonly id: string }>,
    SupportImpersonationUnavailableError
  >;
  readonly loadRecoveries: (
    originalSessionId: string,
  ) => Effect.Effect<readonly SupportRecoveryRecord[], SupportImpersonationUnavailableError>;
  /** The provider session with this id: its token, expiry and the support user impersonating through it. */
  readonly loadSession: (sessionId: string) => Effect.Effect<
    Option.Option<{
      readonly expiresAt: Date;
      readonly id: string;
      readonly impersonatedBy: null | string;
      readonly token: Redacted.Redacted;
    }>,
    SupportImpersonationUnavailableError
  >;
  /** Withdraws this request's claim after the provider refused it and created no session. */
  readonly releaseStart: (
    key: SupportImpersonationStartKey,
  ) => Effect.Effect<void, SupportImpersonationUnavailableError>;
  readonly updateImpersonationSession: (
    sessionId: string,
    metadata: {
      readonly actionId: string;
      readonly originalAuthBindingId: string;
      readonly originalPrincipalId: string;
      readonly originalSessionId: string;
      readonly reason: string;
      readonly targetPrincipalId: string;
      readonly tenantId: string;
    },
  ) => Effect.Effect<void, SupportImpersonationUnavailableError>;
}

export class SupportImpersonationStoreService extends Context.Service<
  SupportImpersonationStoreService,
  SupportImpersonationStore
>()('@app/shell-super-app/api/auth/support-impersonation-store-service/SupportImpersonationStoreService') {}
