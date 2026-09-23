import { PartyDetailResponseSchema, executePartyDetail } from '@app/party-registry/api/client';
import type { PartyDetailResponse } from '@app/party-registry/api/client';
import { LegalEntityRefSchema } from '@app/core-runtime/resources/legal-entity';
import type { LegalEntityRef } from '@app/core-runtime/resources/legal-entity';
import { legalEntityDetailRead } from '@app/core-runtime';
import type { OperationalScope, ReadRuntimeService } from '@app/core-runtime';
import { Effect, Option, Predicate, Schema } from 'effect';

import type { ManufacturerTarget } from '../../shared/domain/manufacturer-relation.ts';
import { ManufacturerTargetAbsent } from './manufacturer-target-absent.ts';
import { ManufacturerTargetForbidden } from './manufacturer-target-forbidden.ts';
import { ManufacturerTargetInvalid } from './manufacturer-target-invalid.ts';
import { ManufacturerTargetUnavailable } from './manufacturer-target-unavailable.ts';

export { ManufacturerTargetAbsent } from './manufacturer-target-absent.ts';
export { ManufacturerTargetForbidden } from './manufacturer-target-forbidden.ts';
export { ManufacturerTargetInvalid } from './manufacturer-target-invalid.ts';
export { ManufacturerTargetUnavailable } from './manufacturer-target-unavailable.ts';

/** The tenant and request identity are supplied by the server's revalidated operation scope. */
export interface ManufacturerTargetResolutionScope {
  readonly requestId: string;
  readonly tenantId: string;
}

export type ResolvedManufacturerTarget =
  | {
      readonly canonicalTarget: Extract<ManufacturerTarget, { readonly kind: 'PARTY' }>;
      readonly kind: 'PARTY';
      readonly ownerRevision: number;
      readonly requestedTarget: Extract<ManufacturerTarget, { readonly kind: 'PARTY' }>;
      readonly state: 'CURRENT' | 'ALIAS' | 'ARCHIVED';
    }
  | {
      readonly canonicalTarget: Extract<ManufacturerTarget, { readonly kind: 'LEGAL_ENTITY' }>;
      readonly kind: 'LEGAL_ENTITY';
      readonly lifecycleStatus: 'active' | 'suspended' | 'archived';
      readonly requestedTarget: Extract<ManufacturerTarget, { readonly kind: 'LEGAL_ENTITY' }>;
      readonly state: 'CURRENT' | 'SUSPENDED' | 'ARCHIVED';
    };

interface PartyReadFailure {
  readonly _tag: string;
}

interface ManagedLegalEntityDetail {
  readonly legalEntityRef: LegalEntityRef;
  readonly status: 'active' | 'suspended' | 'archived';
}

export interface ManufacturerTargetResolverPorts {
  /** Bind to Core's governed Legal Entity detail Read at the Action service seam. */
  readonly readManagedLegalEntity?: (payload: {
    readonly legalEntityRef: LegalEntityRef;
  }) => Effect.Effect<ManagedLegalEntityDetail, PartyReadFailure>;
  readonly readPartyDetail: (
    payload: Parameters<typeof executePartyDetail>[0],
    requestId: string,
  ) => Effect.Effect<PartyDetailResponse, PartyReadFailure>;
}

const legalEntityReadFailure = (failure: PartyReadFailure) => {
  if (Predicate.isTagged(failure, 'ReadHandlerNotFound')) {
    return new ManufacturerTargetAbsent();
  }
  if (
    Predicate.isTagged(failure, 'ReadPermissionDenied') ||
    Predicate.isTagged(failure, 'ReadPolicyDenied') ||
    Predicate.isTagged(failure, 'OperationContextDenied') ||
    Predicate.isTagged(failure, 'OperationAuthenticationRequired')
  ) {
    return new ManufacturerTargetForbidden();
  }
  return new ManufacturerTargetUnavailable();
};

const ManagedLegalEntityDetailSchema = Schema.Struct({
  legalEntityRef: LegalEntityRefSchema,
  status: Schema.Literals(['active', 'suspended', 'archived']),
});

const partyReadFailure = (failure: PartyReadFailure) => {
  if (Predicate.isTagged(failure, 'PartyDetailNotFoundProblem')) {
    return new ManufacturerTargetAbsent();
  }
  if (
    Predicate.isTagged(failure, 'PartyDetailForbiddenProblem') ||
    Predicate.isTagged(failure, 'PartyDetailAuthenticationProblem')
  ) {
    return new ManufacturerTargetForbidden();
  }
  return new ManufacturerTargetUnavailable();
};

const validPartyDetail = (
  detail: PartyDetailResponse,
  target: Extract<ManufacturerTarget, { readonly kind: 'PARTY' }>,
  tenantId: string,
): boolean => {
  const { party, resolution } = detail;
  return (
    resolution.requestedPartyRef.tenantId === tenantId &&
    resolution.requestedPartyRef.resourceId === target.partyRef.resourceId &&
    resolution.canonicalPartyRef.tenantId === tenantId &&
    party.partyRef.tenantId === tenantId &&
    party.partyRef.resourceId === resolution.canonicalPartyRef.resourceId &&
    Number.isInteger(party.revision) &&
    party.revision > 0 &&
    (resolution.kind === 'ALIAS' || resolution.kind === 'DIRECT')
  );
};

const partyState = (detail: PartyDetailResponse): 'CURRENT' | 'ALIAS' | 'ARCHIVED' => {
  if (Option.isSome(detail.party.archivedAt)) {
    return 'ARCHIVED';
  }
  return detail.resolution.kind === 'ALIAS' ? 'ALIAS' : 'CURRENT';
};

const managedState = (status: ManagedLegalEntityDetail['status']): 'CURRENT' | 'SUSPENDED' | 'ARCHIVED' => {
  if (status === 'active') {
    return 'CURRENT';
  }
  return status === 'suspended' ? 'SUSPENDED' : 'ARCHIVED';
};

/** Read-only owner evidence; it never creates an identity or changes the Catalog relation. */
export const makeManufacturerTargetResolver = (configuredPorts?: ManufacturerTargetResolverPorts) => {
  const ports: ManufacturerTargetResolverPorts = configuredPorts ?? { readPartyDetail: executePartyDetail };
  return {
    resolve: (
      target: ManufacturerTarget,
      scope: ManufacturerTargetResolutionScope,
    ): Effect.Effect<
      ResolvedManufacturerTarget,
      ManufacturerTargetInvalid | ManufacturerTargetAbsent | ManufacturerTargetForbidden | ManufacturerTargetUnavailable
    > => {
      if (
        scope.tenantId.length === 0 ||
        scope.requestId.length === 0 ||
        (target.kind === 'PARTY' && target.partyRef.tenantId !== scope.tenantId) ||
        (target.kind === 'LEGAL_ENTITY' && target.legalEntityRef.tenantId !== scope.tenantId)
      ) {
        return Effect.fail(
          new ManufacturerTargetInvalid({ reason: 'A trusted matching Tenant and request identity are required' }),
        );
      }
      if (target.kind === 'LEGAL_ENTITY') {
        if (ports.readManagedLegalEntity === undefined) {
          return Effect.fail(new ManufacturerTargetUnavailable());
        }
        return ports.readManagedLegalEntity({ legalEntityRef: target.legalEntityRef }).pipe(
          Effect.mapError(legalEntityReadFailure),
          Effect.filterOrFail(Schema.is(ManagedLegalEntityDetailSchema), () => new ManufacturerTargetUnavailable()),
          Effect.filterOrFail(
            (detail) =>
              detail.legalEntityRef.tenantId === scope.tenantId &&
              detail.legalEntityRef.resourceId === target.legalEntityRef.resourceId,
            () => new ManufacturerTargetUnavailable(),
          ),
          Effect.map((detail) => ({
            canonicalTarget: target,
            kind: 'LEGAL_ENTITY' as const,
            lifecycleStatus: detail.status,
            requestedTarget: target,
            state: managedState(detail.status),
          })),
        );
      }
      return ports.readPartyDetail({ partyRef: target.partyRef }, scope.requestId).pipe(
        Effect.mapError(partyReadFailure),
        Effect.filterOrFail(Schema.is(PartyDetailResponseSchema), () => new ManufacturerTargetUnavailable()),
        Effect.filterOrFail(
          (detail) => validPartyDetail(detail, target, scope.tenantId),
          () => new ManufacturerTargetUnavailable(),
        ),
        Effect.map((detail) => ({
          canonicalTarget: { kind: 'PARTY' as const, partyRef: detail.resolution.canonicalPartyRef },
          kind: 'PARTY' as const,
          ownerRevision: detail.party.revision,
          requestedTarget: target,
          state: partyState(detail),
        })),
      );
    },
  };
};

export const manufacturerTargetResolver = makeManufacturerTargetResolver();

/** Carry the original, provenance-bearing principal into Core's governed Read lifecycle. */
// oxlint-disable-next-line effect-native/no-dependency-parameters -- Action factory resolves ReadRuntime from Context and binds it here to the target resolver's owner-read port.
export const manufacturerTargetResolverForCoreRead = (readRuntime: ReadRuntimeService, scope: OperationalScope) =>
  makeManufacturerTargetResolver({
    readManagedLegalEntity: ({ legalEntityRef }) =>
      readRuntime.runRead({
        input: { legalEntityRef },
        principal: scope,
        registration: legalEntityDetailRead,
        transport: { correlationId: scope.correlationId },
      }),
    readPartyDetail: executePartyDetail,
  });
