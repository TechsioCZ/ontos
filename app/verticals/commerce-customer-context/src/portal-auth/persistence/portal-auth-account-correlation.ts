import { Effect, Layer } from 'effect';

import { CommercePortalAuthAccountCreationUnavailable } from '../../../api/portal-auth/provider/account-creation-unavailable.ts';
import { CommercePortalAuthAccountCreationCorrelationService } from '../../../api/portal-auth/provider/account-correlation-service.ts';
import type { CommercePortalAuthAccountCreationCorrelation } from '../../../api/portal-auth/provider/account-correlation-service.ts';
import { withCause } from '../../../api/portal-auth/problems-support.ts';
import { CommercePortalAuthDatabase } from './portal-auth-database.ts';
import type { CommercePortalAuthDatabaseExecutor } from './portal-auth-database-types.ts';
import { accountCreationCorrelation } from './portal-auth-tables.ts';

const correlationUnavailable = (cause: unknown): CommercePortalAuthAccountCreationUnavailable =>
  withCause(
    new CommercePortalAuthAccountCreationUnavailable({
      reason: 'The Commerce portal account creation correlation could not be recorded',
    }),
    cause,
  );

/**
 * One plain insert, deliberately without an upsert. Both keys are unique, so a second committed
 * account for the same governed invocation — or a second invocation claiming an account that is
 * already correlated — raises the violation here instead of being absorbed: either would be a
 * duplicate account for one Attempt, which is the outcome this correlation exists to prevent. The
 * replay of an invocation that already succeeded never reaches the provider at all; the private
 * account-creation port answers it from this very row.
 */
export const makeCommercePortalAuthAccountCreationCorrelation = (
  database: CommercePortalAuthDatabaseExecutor,
): CommercePortalAuthAccountCreationCorrelation => ({
  record: ({ ownerInvocationId, portalEnrollmentAttemptId, providerSubjectId, tenantId }) =>
    database
      .insert(accountCreationCorrelation)
      .values({ ownerInvocationId, portalEnrollmentAttemptId, providerSubjectId, tenantId })
      .pipe(Effect.mapError(correlationUnavailable), Effect.asVoid),
});

export const CommercePortalAuthAccountCreationCorrelationLive = Layer.effect(
  CommercePortalAuthAccountCreationCorrelationService,
  Effect.gen(function* makeCommercePortalAuthAccountCreationCorrelationLayer() {
    const database = yield* CommercePortalAuthDatabase;
    return makeCommercePortalAuthAccountCreationCorrelation(database.executor);
  }),
);
