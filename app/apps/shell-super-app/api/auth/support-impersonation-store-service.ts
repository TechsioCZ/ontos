import { Context } from 'effect';
import type { Effect, Option, Redacted } from 'effect';
import type { supportImpersonationRecovery } from './db/schema.ts';
import type { SupportImpersonationUnavailableError } from './impersonation-service.ts';

export type SupportRecoveryRecord = Omit<
  typeof supportImpersonationRecovery.$inferSelect,
  'createdAt'
>;

export interface SupportImpersonationStore {
  readonly deleteRecovery: (
    impersonationSessionId: string,
  ) => Effect.Effect<void, SupportImpersonationUnavailableError>;
  readonly deleteSession: (
    sessionId: string,
  ) => Effect.Effect<void, SupportImpersonationUnavailableError>;
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
>()(
  '@app/shell-super-app/api/auth/support-impersonation-store-service/SupportImpersonationStoreService',
) {}
