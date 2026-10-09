import {
  EffectiveCustomerGroupMembershipSetV1RequestSchema,
  EffectiveCustomerGroupMembershipSetV1ResponseSchema,
} from '@app/commerce-customer-context/api/effective-customer-group-membership-set-v1';
import type {
  EffectiveCustomerGroupMembershipSetV1Request,
  EffectiveCustomerGroupMembershipSetV1Response,
} from '@app/commerce-customer-context/api/effective-customer-group-membership-set-v1';
import {
  VerifyEffectiveCustomerGroupMembershipSetV1RequestSchema,
  VerifyEffectiveCustomerGroupMembershipSetV1ResponseSchema,
} from '@app/commerce-customer-context/api/verify-effective-customer-group-membership-set-v1';
import type { VerifyEffectiveCustomerGroupMembershipSetV1Request } from '@app/commerce-customer-context/api/verify-effective-customer-group-membership-set-v1';
import { DateTime, Effect, Schema } from 'effect';

import {
  AssortmentDependencyFailureError,
  AssortmentOwnerModuleIdSchema,
} from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentCommerceMembershipPredicate,
  AssortmentCommerceMembershipScopeTokenJsonSchema,
  AssortmentCustomerGroupMembershipRequestSchema,
  AssortmentCustomerGroupMembershipSetSchema,
  AssortmentSetCompletenessRequestSchema,
  AssortmentSetCompletenessResultSchema,
} from '../../shared/domain/ports/owner-evidence.ts';
import type { AssortmentOwnerEvidencePort } from '../../shared/domain/ports/owner-evidence.ts';

const ownerModuleId = AssortmentOwnerModuleIdSchema.make('commerce.customer-context');
const predicate = AssortmentCommerceMembershipPredicate;
const ScopeTokenJsonSchema = AssortmentCommerceMembershipScopeTokenJsonSchema;

export { AssortmentCommerceMembershipScopeTokenSchema as CommerceMembershipScopeTokenSchema } from '../../shared/domain/ports/owner-evidence.ts';

export type CommerceCustomerGroupMembershipExecutor<Failure = unknown> = (
  request: EffectiveCustomerGroupMembershipSetV1Request,
  requestCorrelation: string,
) => Effect.Effect<unknown, Failure>;
export type CommerceCustomerGroupMembershipVerifier<Failure = unknown> = (
  request: VerifyEffectiveCustomerGroupMembershipSetV1Request,
  requestCorrelation: string,
) => Effect.Effect<unknown, Failure>;

export interface CommerceCustomerGroupMembershipAdapterOptions<ObserveFailure, VerifyFailure> {
  readonly observe: CommerceCustomerGroupMembershipExecutor<ObserveFailure>;
  readonly requestCorrelation: string;
  readonly trustedLegalEntityId: string;
  readonly trustedTenantId: string;
  readonly verify: CommerceCustomerGroupMembershipVerifier<VerifyFailure>;
}

const dependencyFailure = () =>
  new AssortmentDependencyFailureError({
    code: 'DEPENDENCY_FAILURE',
    ownerModuleId,
    retryable: true,
    safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
  });
interface ReferenceIdentity {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}
const sameReference = (left: ReferenceIdentity, right: ReferenceIdentity) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const ownerProfile = (profileRef: ReferenceIdentity) => {
  if (profileRef.resourceType === 'commerce.customer-context.retail-customer-profile') {
    return { profileKind: 'RETAIL', profileRef };
  }
  if (profileRef.resourceType === 'commerce.customer-context.counterparty-purchasing-profile') {
    return { profileKind: 'COUNTERPARTY', profileRef };
  }
  return null;
};
const instantMillis = (instant: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(instant));
const rowsAreEffective = (response: EffectiveCustomerGroupMembershipSetV1Response) => {
  const at = instantMillis(response.asOf);
  const identities = new Set(response.memberships.map((row) => row.membershipRef.resourceId));
  return (
    identities.size === response.memberships.length &&
    response.proof.itemCount === response.memberships.length &&
    response.memberships.every(
      (row) =>
        row.state === 'VALID' &&
        row.profile.profileKind === response.profile.profileKind &&
        sameReference(row.profile.profileRef, response.profile.profileRef) &&
        row.groupRef.tenantId === response.profile.profileRef.tenantId &&
        row.membershipRef.tenantId === response.profile.profileRef.tenantId &&
        instantMillis(row.effectiveFrom) <= at &&
        (row.effectiveTo === null || at < instantMillis(row.effectiveTo)),
    )
  );
};

/** Executors must supply authenticated owner-audience transport for this trusted operation scope. */
export const adaptCommerceCustomerGroupMemberships = <ObserveFailure, VerifyFailure>(
  options: CommerceCustomerGroupMembershipAdapterOptions<ObserveFailure, VerifyFailure>,
): Pick<AssortmentOwnerEvidencePort, 'resolveCustomerGroupMemberships' | 'verifySetCompleteness'> => {
  const correlationIsValid =
    options.requestCorrelation.trim().length > 0 && options.requestCorrelation === options.requestCorrelation.trim();
  const resolveCustomerGroupMemberships: AssortmentOwnerEvidencePort['resolveCustomerGroupMemberships'] = Effect.fn(
    'CommerceMembershipAdapter.resolveCustomerGroupMemberships',
  )(
    function* observeMemberships(
      request: Parameters<AssortmentOwnerEvidencePort['resolveCustomerGroupMemberships']>[0],
    ) {
      const encoded = yield* Schema.encodeUnknownEffect(AssortmentCustomerGroupMembershipRequestSchema)(request);
      if (!correlationIsValid || encoded.tenantId !== options.trustedTenantId) {
        return yield* dependencyFailure();
      }
      const input = yield* Schema.decodeUnknownEffect(EffectiveCustomerGroupMembershipSetV1RequestSchema)({
        asOf: encoded.asOf,
        profile: ownerProfile(encoded.profileRef),
      });
      const response = yield* options
        .observe(input, options.requestCorrelation)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(EffectiveCustomerGroupMembershipSetV1ResponseSchema)));
      if (
        response.legalEntityId !== options.trustedLegalEntityId ||
        response.asOf !== input.asOf ||
        response.profile.profileKind !== input.profile.profileKind ||
        !sameReference(response.profile.profileRef, input.profile.profileRef) ||
        !rowsAreEffective(response)
      ) {
        return yield* dependencyFailure();
      }
      const scope = yield* Schema.encodeEffect(ScopeTokenJsonSchema)({
        legalEntityId: response.legalEntityId,
        proof: response.proof,
        version: 1,
      });
      return yield* Schema.decodeEffect(AssortmentCustomerGroupMembershipSetSchema)({
        asOf: response.asOf,
        completeness: {
          predicate: response.predicateRef,
          proof: { evidenceRef: response.profile.profileRef, ownerModuleId },
          scope,
          state: 'COMPLETE',
        },
        items: response.memberships.map((row) => ({
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo,
          groupRef: row.groupRef,
          membershipRef: row.membershipRef,
          profileRef: row.profile.profileRef,
          revision: String(row.revision),
          state: row.state,
        })),
        profileRef: response.profile.profileRef,
      });
    },
    Effect.mapError((cause) =>
      Object.defineProperty(dependencyFailure(), 'cause', { configurable: true, value: cause }),
    ),
  );
  const verifySetCompleteness: AssortmentOwnerEvidencePort['verifySetCompleteness'] = Effect.fn(
    'CommerceMembershipAdapter.verifySetCompleteness',
  )(
    function* verifyMemberships(request: Parameters<AssortmentOwnerEvidencePort['verifySetCompleteness']>[0]) {
      const encoded = yield* Schema.encodeUnknownEffect(AssortmentSetCompletenessRequestSchema)(request);
      if (!correlationIsValid || encoded.tenantId !== options.trustedTenantId || encoded.predicate !== predicate) {
        return yield* dependencyFailure();
      }
      const token = yield* Schema.decodeEffect(ScopeTokenJsonSchema, { onExcessProperty: 'error' })(encoded.scope);
      const canonicalScope = yield* Schema.encodeEffect(ScopeTokenJsonSchema)(token);
      if (token.legalEntityId !== options.trustedLegalEntityId || canonicalScope !== encoded.scope) {
        return yield* dependencyFailure();
      }
      const input = yield* Schema.decodeUnknownEffect(VerifyEffectiveCustomerGroupMembershipSetV1RequestSchema)({
        asOf: encoded.asOf,
        membershipSetSha256: token.proof.membershipSetSha256,
        profile: ownerProfile(encoded.scopeRef),
        proofItemCount: token.proof.itemCount,
      });
      const response = yield* options
        .verify(input, options.requestCorrelation)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(VerifyEffectiveCustomerGroupMembershipSetV1ResponseSchema)));
      if (
        response.legalEntityId !== options.trustedLegalEntityId ||
        response.asOf !== input.asOf ||
        response.profile.profileKind !== input.profile.profileKind ||
        !sameReference(response.profile.profileRef, input.profile.profileRef) ||
        (response.status === 'CURRENT' &&
          (response.itemCount !== input.proofItemCount || response.membershipSetSha256 !== input.membershipSetSha256))
      ) {
        return yield* dependencyFailure();
      }
      return yield* Schema.decodeEffect(AssortmentSetCompletenessResultSchema)({
        evidence: {
          predicate: response.predicateRef,
          proof: { evidenceRef: response.profile.profileRef, ownerModuleId },
          scope: encoded.scope,
          state: response.status === 'CURRENT' ? 'COMPLETE' : 'STALE',
        },
      });
    },
    Effect.mapError((cause) =>
      Object.defineProperty(dependencyFailure(), 'cause', { configurable: true, value: cause }),
    ),
  );
  return { resolveCustomerGroupMemberships, verifySetCompleteness };
};
