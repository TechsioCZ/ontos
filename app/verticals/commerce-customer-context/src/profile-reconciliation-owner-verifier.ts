import { Context, Effect, Layer } from 'effect';

import type {
  ProfileReconciliationOwnerVerification,
  ProfileReconciliationOwnerVerificationRequest,
} from '../shared/actions/resolve-profile-reconciliation.ts';
import type { ReconciliationOwner } from '../shared/domain/profile-contracts.ts';
import { ProfileReconciliationOwnerVerificationFailure } from './profile-reconciliation-owner-verifier-error.ts';

export { ProfileReconciliationOwnerVerificationFailure } from './profile-reconciliation-owner-verifier-error.ts';

export interface ProfileReconciliationOwnerVerificationContext {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: string;
  readonly legalEntityId: string;
  readonly tenantId: string;
}

export interface ProfileReconciliationOwnerEvidenceVerifier {
  readonly owner: ReconciliationOwner;
  readonly verify: (
    request: ProfileReconciliationOwnerVerificationRequest,
    context: ProfileReconciliationOwnerVerificationContext,
  ) => Effect.Effect<
    ProfileReconciliationOwnerVerification,
    ProfileReconciliationOwnerVerificationFailure
  >;
}

export interface ProfileReconciliationOwnerVerifierService {
  readonly verify: ProfileReconciliationOwnerEvidenceVerifier['verify'];
}

export class ProfileReconciliationOwnerVerifier extends Context.Service<
  ProfileReconciliationOwnerVerifier,
  ProfileReconciliationOwnerVerifierService
>()(
  '@app/commerce-customer-context/profile-reconciliation-owner-verifier/ProfileReconciliationOwnerVerifier',
) {}

export type ProfileReconciliationOwnerVerifierCatalog = Readonly<
  Record<ReconciliationOwner, ProfileReconciliationOwnerEvidenceVerifier>
>;

export const makeProfileReconciliationOwnerVerifier = (
  catalog: ProfileReconciliationOwnerVerifierCatalog,
): ProfileReconciliationOwnerVerifierService => ({
  verify: (request, context) => {
    const verifier = catalog[request.desiredOutcome.owner];
    if (verifier === undefined || verifier.owner !== request.desiredOutcome.owner) {
      return Effect.fail(
        new ProfileReconciliationOwnerVerificationFailure({
          code: 'OUTCOME_INDETERMINATE',
          owner: request.desiredOutcome.owner,
          reason: 'The reconciliation verifier catalog is inconsistent',
          retryable: false,
        }),
      );
    }
    return verifier.verify(request, context);
  },
});

export const unavailableProfileReconciliationOwnerEvidenceVerifier = (
  owner: ReconciliationOwner,
  reason: string,
): ProfileReconciliationOwnerEvidenceVerifier => ({
  owner,
  verify: () =>
    Effect.fail(
      new ProfileReconciliationOwnerVerificationFailure({
        code: 'OWNER_UNAVAILABLE',
        owner,
        reason,
        retryable: true,
      }),
    ),
});

export const profileReconciliationOwnerVerifierUnavailable = Object.freeze({
  verify: (request: ProfileReconciliationOwnerVerificationRequest) =>
    Effect.succeed({
      _tag: 'UNAVAILABLE' as const,
      owner: request.desiredOutcome.owner,
      reason: 'Profile reconciliation owner verification is not configured',
    }),
}) satisfies ProfileReconciliationOwnerVerifierService;

export const ProfileReconciliationOwnerVerifierUnavailableLive = Layer.succeed(
  ProfileReconciliationOwnerVerifier,
  profileReconciliationOwnerVerifierUnavailable,
);
