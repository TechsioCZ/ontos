import type { OperationalScope } from '@app/core-runtime';
import { PriceGroupCompatibilityDecisionSchema } from '@app/price-group-catalog-contracts/price-group';
import type {
  PriceGroupCompatibilityDecision,
  StablePriceGroupRef,
} from '@app/price-group-catalog-contracts/price-group';
import { ValidatePriceGroupCompatibilityRequestSchema } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import type { ValidatePriceGroupCompatibilityRequest } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import { executeValidatePriceGroupCompatibilityWithAuthorization } from '@app/price-group-catalog-contracts/validate-price-group-compatibility/client';
import { Effect, Redacted, Schema, Crypto } from 'effect';

import { PriceGroupInterpretationDependencyFailure } from '../services/price-group-interpretation.service.ts';
import type { PriceGroupCompatibilityPort } from '../services/price-group-interpretation.service.ts';
import { acquireOwnerGatewayConnection } from './owner-gateway-connection.ts';
import type { OwnerGatewayConnectionAcquire } from './owner-gateway-connection.ts';

type CompatibilityClientEffect = ReturnType<typeof executeValidatePriceGroupCompatibilityWithAuthorization>;
type CompatibilityClientFailure =
  CompatibilityClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type CompatibilityExecutor = (
  payload: ValidatePriceGroupCompatibilityRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<PriceGroupCompatibilityDecision, CompatibilityClientFailure>;

const executeAuthorizedCompatibility: CompatibilityExecutor = (payload, credential, requestCorrelation, options) =>
  executeValidatePriceGroupCompatibilityWithAuthorization(
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
  const result = new PriceGroupInterpretationDependencyFailure({
    kind,
    owner: 'PRICE_GROUP_COMPATIBILITY',
    reason,
  });
  return cause === undefined ? result : Object.defineProperty(result, 'cause', { configurable: true, value: cause });
};

const sameReference = (left: StablePriceGroupRef, right: StablePriceGroupRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const responseBindsRequest = (
  response: PriceGroupCompatibilityDecision,
  request: ValidatePriceGroupCompatibilityRequest,
): boolean => {
  if (response.kind === 'MISSING') {
    return (
      sameReference(response.priceGroupRef, request.priceGroupRef) &&
      response.catalogObservation.trustedOperationAt === request.trustedOperationAt
    );
  }
  const { evidence } = response;
  if (
    !sameReference(evidence.priceGroupRef, request.priceGroupRef) ||
    evidence.trustedOperationAt !== request.trustedOperationAt
  ) {
    return false;
  }
  return response.kind === 'RETIRED'
    ? true
    : response.evidence.requiredContract.contractId === request.requiredContract.contractId &&
        response.evidence.requiredContract.version === request.requiredContract.version;
};

export const makePriceGroupCompatibilityPort = (dependencies: {
  readonly acquire: OwnerGatewayConnectionAcquire;
  readonly context: {
    readonly compositionRevision: string;
    readonly requestCorrelation: string;
    readonly scope: OperationalScope;
    readonly tenantId: string;
  };
  readonly execute: CompatibilityExecutor;
}): PriceGroupCompatibilityPort => ({
  validate: Effect.fn('PriceGroupCompatibilityPort.validate')(function* validate(request) {
    const payload = yield* Schema.decodeEffect(ValidatePriceGroupCompatibilityRequestSchema)(request).pipe(
      Effect.mapError((cause) => failure('UNVERIFIABLE', 'Price Group compatibility request is invalid', cause)),
    );
    if (payload.priceGroupRef.tenantId !== dependencies.context.tenantId) {
      return yield* failure('UNVERIFIABLE', 'Price Group compatibility request is outside the trusted Tenant');
    }
    const { baseUrl, credential } = yield* dependencies
      .acquire({
        audience: 'price-group-catalog',
        compositionRevision: dependencies.context.compositionRevision,
        legalEntityScope: 'tenant',
        requestCorrelation: dependencies.context.requestCorrelation,
        scope: dependencies.context.scope,
      })
      .pipe(
        Effect.mapError((cause) =>
          failure('UNAVAILABLE', 'Price Group Catalog compatibility validation is unavailable', cause),
        ),
      );
    const ownerResponse = yield* dependencies
      .execute(payload, credential, dependencies.context.requestCorrelation, {
        baseUrl,
        compositionRevision: dependencies.context.compositionRevision,
      })
      .pipe(
        Effect.mapError((cause) =>
          failure('UNAVAILABLE', 'Price Group Catalog compatibility validation is unavailable', cause),
        ),
      );
    const response = yield* Schema.decodeEffect(PriceGroupCompatibilityDecisionSchema)(ownerResponse).pipe(
      Effect.mapError((cause) =>
        failure('UNVERIFIABLE', 'Price Group Catalog returned unverifiable compatibility evidence', cause),
      ),
    );
    if (!responseBindsRequest(response, payload)) {
      return yield* failure('UNVERIFIABLE', 'Price Group Catalog evidence does not bind the exact request');
    }
    return response;
  }),
});

export const priceGroupCompatibilityPortFromEnvironment = Effect.fn('priceGroupCompatibilityPortFromEnvironment')(
  function* priceGroupCompatibilityPortFromEnvironment(
    context: {
      readonly compositionRevision: string;
      readonly requestCorrelation: string;
      readonly scope: OperationalScope;
      readonly tenantId: string;
    },
    execute: CompatibilityExecutor = executeAuthorizedCompatibility,
  ): Effect.fn.Return<PriceGroupCompatibilityPort, never, Crypto.Crypto> {
    const crypto = yield* Crypto.Crypto;
    return makePriceGroupCompatibilityPort({
      acquire: (input) => acquireOwnerGatewayConnection(input, crypto),
      context,
      execute,
    });
  },
);
