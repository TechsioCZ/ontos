import type { OperationalScope } from '@app/core-runtime';
import { executeCustomerPriceGroupResolutionWithAuthorization } from '@app/commerce-customer-context/api/customer-price-group-resolution/client';
import {
  PriceGroupAssignmentResolutionRequestSchema,
  PriceGroupAssignmentResolutionResponseSchema,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import type {
  PriceGroupAssignmentResolutionRequest,
  PriceGroupAssignmentResolutionResponse,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import { Effect, Redacted, Schema, Crypto } from 'effect';

import { PriceGroupInterpretationDependencyFailure } from '../services/price-group-interpretation.service.ts';
import type { CommercePriceGroupResolutionPort } from '../services/price-group-interpretation.service.ts';
import { acquireOwnerGatewayConnection } from './owner-gateway-connection.ts';
import type { OwnerGatewayConnectionAcquire } from './owner-gateway-connection.ts';

type CommerceResolutionClientEffect = ReturnType<typeof executeCustomerPriceGroupResolutionWithAuthorization>;
type CommerceResolutionClientFailure =
  CommerceResolutionClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type CommerceResolutionExecutor = (
  payload: PriceGroupAssignmentResolutionRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<unknown, CommerceResolutionClientFailure>;

export const executeAuthorizedCommerceResolution: CommerceResolutionExecutor = (
  payload,
  credential,
  requestCorrelation,
  options,
) =>
  executeCustomerPriceGroupResolutionWithAuthorization(
    payload,
    Redacted.value(credential),
    requestCorrelation,
    options,
  );

const failure = (
  kind: 'UNAVAILABLE' | 'UNVERIFIABLE',
  reason: string,
  cause?: unknown,
): PriceGroupInterpretationDependencyFailure => {
  const result = new PriceGroupInterpretationDependencyFailure({ kind, owner: 'COMMERCE_ASSIGNMENT', reason });
  return cause === undefined ? result : Object.defineProperty(result, 'cause', { configurable: true, value: cause });
};

const sameProfile = (
  left: PriceGroupAssignmentResolutionRequest['profile'],
  right: PriceGroupAssignmentResolutionResponse['profile'],
): boolean =>
  left.kind === right.kind &&
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

export const makeCommerceResolutionPort = (dependencies: {
  readonly acquire: OwnerGatewayConnectionAcquire;
  readonly context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
    readonly scope: OperationalScope;
    readonly tenantId: string;
  };
  readonly execute: CommerceResolutionExecutor;
}): CommercePriceGroupResolutionPort => ({
  resolve: Effect.fn('CommercePriceGroupResolutionPort.resolve')(function* resolve(input) {
    if (input.sellingLegalEntityId !== dependencies.context.legalEntityId) {
      return yield* failure('UNVERIFIABLE', 'Commerce assignment evidence is outside the trusted Selling Legal Entity');
    }
    const { request } = input;
    const payload = yield* Schema.decodeEffect(PriceGroupAssignmentResolutionRequestSchema)(request).pipe(
      Effect.mapError((cause) => failure('UNVERIFIABLE', 'Commerce assignment request is invalid', cause)),
    );
    if (payload.profile.tenantId !== dependencies.context.tenantId) {
      return yield* failure('UNVERIFIABLE', 'Commerce assignment request is outside the trusted Tenant');
    }
    const { baseUrl, credential } = yield* dependencies
      .acquire({
        audience: 'commerce-customer-context',
        compositionRevision: dependencies.context.compositionRevision,
        legalEntityScope: 'subject',
        requestCorrelation: dependencies.context.requestCorrelation,
        scope: dependencies.context.scope,
      })
      .pipe(
        Effect.mapError((cause) =>
          failure('UNAVAILABLE', 'Commerce Customer Price Group resolution is unavailable', cause),
        ),
      );
    const ownerResponse = yield* dependencies
      .execute(payload, credential, dependencies.context.requestCorrelation, {
        baseUrl,
        compositionRevision: dependencies.context.compositionRevision,
      })
      .pipe(
        Effect.mapError((cause) =>
          failure('UNAVAILABLE', 'Commerce Customer Price Group resolution is unavailable', cause),
        ),
      );
    const response = yield* Schema.decodeUnknownEffect(PriceGroupAssignmentResolutionResponseSchema)(
      ownerResponse,
    ).pipe(
      Effect.mapError((cause) =>
        failure('UNVERIFIABLE', 'Commerce returned unverifiable Customer Price Group evidence', cause),
      ),
    );
    if (!sameProfile(payload.profile, response.profile)) {
      return yield* failure('UNVERIFIABLE', 'Commerce returned Customer Price Group evidence for another profile');
    }
    if (response.effectiveAt !== payload.effectiveAt) {
      return yield* failure(
        'UNVERIFIABLE',
        'Commerce returned Customer Price Group evidence for another evaluation instant',
      );
    }
    return response;
  }),
});

export const commercePriceGroupResolutionPortFromEnvironment = Effect.fn(
  'commercePriceGroupResolutionPortFromEnvironment',
)(function* commercePriceGroupResolutionPortFromEnvironment(
  context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
    readonly scope: OperationalScope;
    readonly tenantId: string;
  },
  execute: CommerceResolutionExecutor = executeAuthorizedCommerceResolution,
): Effect.fn.Return<CommercePriceGroupResolutionPort, never, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto;
  return makeCommerceResolutionPort({
    acquire: (input) => acquireOwnerGatewayConnection(input, crypto),
    context,
    execute,
  });
});
