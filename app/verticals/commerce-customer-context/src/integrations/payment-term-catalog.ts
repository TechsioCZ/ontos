import {
  executeCurrentPaymentTerms,
  executeCurrentPaymentTermsWithAuthorization,
} from '@app/payment-term-catalog-contracts/current-payment-terms/client';
import type {
  CurrentPaymentTermsRequest,
  CurrentPaymentTermsResponse,
} from '@app/payment-term-catalog-contracts/current-payment-terms';
import { Effect, Option, Redacted } from 'effect';

import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import {
  PaymentTermCatalogGatewayCredentialService,
  unavailablePaymentTermCatalogGatewayCredentialIssuer,
} from '../../shared/domain/payment-term-catalog-gateway-credential.ts';
import type {
  PaymentTermCatalogPort,
  PaymentTermDefinitionRequest,
} from '../persistence/payment-term-persistence.ts';

export {
  PaymentTermCatalogGatewayCredentialService,
  unavailablePaymentTermCatalogGatewayCredentialIssuer,
} from '../../shared/domain/payment-term-catalog-gateway-credential.ts';
export type { PaymentTermCatalogGatewayCredentialIssuer } from '../../shared/domain/payment-term-catalog-gateway-credential.ts';

const maximumReferencesPerRequest = 200;
const consumerCompatibility = 'customer-payment-terms.v1' as const;

type CurrentPaymentTermsClientError =
  ReturnType<typeof executeCurrentPaymentTerms> extends Effect.Effect<
    unknown,
    infer Failure,
    unknown
  >
    ? Failure
    : never;
type CurrentPaymentTermsExecutor = (
  payload: CurrentPaymentTermsRequest,
  requestCorrelation: string,
) => Effect.Effect<
  CurrentPaymentTermsResponse,
  CurrentPaymentTermsClientError | PaymentTermsDependencyUnavailable
>;
type AuthorizedCurrentPaymentTermsExecutor = (
  payload: CurrentPaymentTermsRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
) => Effect.Effect<
  CurrentPaymentTermsResponse,
  CurrentPaymentTermsClientError | PaymentTermsDependencyUnavailable
>;
const executeAuthorizedCurrentPaymentTerms: AuthorizedCurrentPaymentTermsExecutor = (
  payload,
  credential,
  requestCorrelation,
) =>
  executeCurrentPaymentTermsWithAuthorization(
    payload,
    Redacted.value(credential),
    requestCorrelation,
  );

const unavailable = (cause: unknown): PaymentTermsDependencyUnavailable => {
  const failure = new PaymentTermsDependencyUnavailable({
    code: 'payment_terms_dependency_unavailable',
    dependency: 'PAYMENT_TERM_CATALOG',
    reason: 'The Current Payment Term catalog could not be resolved',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const groupedByInstant = (
  requests: readonly PaymentTermDefinitionRequest[],
): readonly (readonly PaymentTermDefinitionRequest[])[] => {
  const groups = new Map<string, PaymentTermDefinitionRequest[]>();
  for (const request of requests) {
    const group = groups.get(request.at);
    if (group === undefined) {
      groups.set(request.at, [request]);
    } else {
      group.push(request);
    }
  }
  return [...groups.values()].flatMap((group) => {
    const batches: PaymentTermDefinitionRequest[][] = [];
    for (let start = 0; start < group.length; start += maximumReferencesPerRequest) {
      batches.push(group.slice(start, start + maximumReferencesPerRequest));
    }
    return batches;
  });
};

const requestPayload = (
  requests: readonly [PaymentTermDefinitionRequest, ...PaymentTermDefinitionRequest[]],
): CurrentPaymentTermsRequest => ({
  at: requests[0].at,
  limit: requests.length,
  references: requests.map((request) =>
    request.expectedSemanticRevisionId === undefined
      ? {
          expectedConsumerCompatibility: consumerCompatibility,
          paymentTermRef: request.paymentTermRef,
        }
      : {
          expectedConsumerCompatibility: consumerCompatibility,
          expectedSemanticRevisionId: request.expectedSemanticRevisionId,
          paymentTermRef: request.paymentTermRef,
        },
  ),
});

const catalogDefinitions = (
  response: CurrentPaymentTermsResponse,
): CurrentPaymentTermsResponse['current'] =>
  response.referenceOutcomes.flatMap((outcome) =>
    outcome.kind === 'USABLE' || outcome.kind === 'RETIRED'
      ? [
          {
            ...outcome.definition,
            paymentTermRef: outcome.requestedPaymentTermRef,
          },
        ]
      : [],
  );

export const paymentTermCatalogPort = (
  requestCorrelation: string,
  execute: CurrentPaymentTermsExecutor = executeCurrentPaymentTerms,
): PaymentTermCatalogPort => ({
  resolveDefinitions: (requests) =>
    Effect.forEach(
      groupedByInstant(requests),
      (batch) => {
        const [first, ...rest] = batch;
        return first === undefined
          ? Effect.succeed([])
          : execute(requestPayload([first, ...rest]), requestCorrelation).pipe(
              Effect.mapError(unavailable),
              Effect.map(catalogDefinitions),
            );
      },
      { concurrency: 1 },
    ).pipe(Effect.map((definitions) => definitions.flat())),
});

export const paymentTermCatalogPortFromEnvironment = (
  context: {
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  },
  execute: AuthorizedCurrentPaymentTermsExecutor = executeAuthorizedCurrentPaymentTerms,
): Effect.Effect<PaymentTermCatalogPort> =>
  Effect.serviceOption(PaymentTermCatalogGatewayCredentialService).pipe(
    Effect.map((issuerOption) => {
      if (Option.isNone(issuerOption)) {
        return {
          resolveDefinitions: () =>
            unavailablePaymentTermCatalogGatewayCredentialIssuer
              .issue({ audience: 'payment-term-catalog', ...context })
              .pipe(Effect.as([] as const)),
        };
      }
      return paymentTermCatalogPort(context.requestCorrelation, (payload, correlation) =>
        issuerOption.value
          .issue({
            audience: 'payment-term-catalog',
            legalEntityId: context.legalEntityId,
            requestCorrelation: correlation,
          })
          .pipe(Effect.flatMap((credential) => execute(payload, credential, correlation))),
      );
    }),
  );
