import {
  executeCurrentPaymentTerms,
  executeCurrentPaymentTermsWithAuthorization,
} from '@app/payment-term-catalog-contracts/current-payment-terms/client';
import type {
  CurrentPaymentTermsRequest,
  CurrentPaymentTermsResponse,
} from '@app/payment-term-catalog-contracts/current-payment-terms';
import { Effect, Option, Redacted } from 'effect';

import { isPaymentTermDefinitionSupported } from '../../shared/domain/payment-term-contracts.ts';
import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import {
  PaymentTermCatalogGatewayCredentialService,
  unavailablePaymentTermCatalogGatewayCredentialIssuer,
} from '../../shared/domain/payment-term-catalog-gateway-credential.ts';
import type { PaymentTermCatalogPort, PaymentTermDefinitionRequest } from '../persistence/payment-term-persistence.ts';

export { PaymentTermCatalogGatewayCredentialService } from '../../shared/domain/payment-term-catalog-gateway-credential.ts';

const maximumReferencesPerRequest = 200;

type CurrentPaymentTermsClientError =
  ReturnType<typeof executeCurrentPaymentTerms> extends Effect.Effect<unknown, infer Failure, unknown>
    ? Failure
    : never;
type CurrentPaymentTermsExecutor = (
  payload: CurrentPaymentTermsRequest,
  requestCorrelation: string,
) => Effect.Effect<CurrentPaymentTermsResponse, CurrentPaymentTermsClientError | PaymentTermsDependencyUnavailable>;
type AuthorizedCurrentPaymentTermsExecutor = (
  payload: CurrentPaymentTermsRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<CurrentPaymentTermsResponse, CurrentPaymentTermsClientError | PaymentTermsDependencyUnavailable>;
const executeAuthorizedCurrentPaymentTerms: AuthorizedCurrentPaymentTermsExecutor = (
  payload,
  credential,
  requestCorrelation,
  options,
) => executeCurrentPaymentTermsWithAuthorization(payload, Redacted.value(credential), requestCorrelation, options);

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
          paymentTermRef: request.paymentTermRef,
        }
      : {
          expectedSemanticRevisionId: request.expectedSemanticRevisionId,
          paymentTermRef: request.paymentTermRef,
        },
  ),
});

const catalogDefinitions = Effect.fn('PaymentTermCatalog.catalogDefinitions')(function* projectCatalogDefinitions(
  response: CurrentPaymentTermsResponse,
): Effect.fn.Return<CurrentPaymentTermsResponse['current'], PaymentTermsDependencyUnavailable> {
  const definitions: CurrentPaymentTermsResponse['current'][number][] = [];
  for (const outcome of response.referenceOutcomes) {
    if (outcome.kind === 'MISSING') {
      continue;
    }
    let kind: 'INCOMPATIBLE' | 'BROKEN' | 'UNSUPPORTED_SEMANTICS' | undefined;
    if (outcome.kind === 'INCOMPATIBLE' || outcome.kind === 'BROKEN') {
      ({ kind } = outcome);
    } else if (
      outcome.definition.paymentTermRef.resourceId !== outcome.requestedPaymentTermRef.resourceId ||
      outcome.definition.paymentTermRef.tenantId !== outcome.requestedPaymentTermRef.tenantId
    ) {
      kind = 'BROKEN';
    } else if (!isPaymentTermDefinitionSupported(outcome.definition)) {
      kind = 'UNSUPPORTED_SEMANTICS';
    }
    if (kind !== undefined) {
      return yield* new PaymentTermsDependencyUnavailable({
        catalogRejection: { kind, paymentTermRef: outcome.requestedPaymentTermRef },
        code: 'payment_terms_dependency_unavailable',
        dependency: 'PAYMENT_TERM_CATALOG',
        reason: `Payment Term catalog rejected the reference: ${kind}`,
      });
    }
    if (outcome.kind === 'USABLE' || outcome.kind === 'RETIRED') {
      definitions.push(outcome.definition);
    }
  }
  return definitions;
});

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
              Effect.flatMap(catalogDefinitions),
            );
      },
      { concurrency: 1 },
    ).pipe(Effect.map((definitions) => definitions.flat())),
});

export const paymentTermCatalogPortFromEnvironment = (
  context: {
    readonly compositionRevision: string;
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
            compositionRevision: context.compositionRevision,
            legalEntityId: context.legalEntityId,
            requestCorrelation: correlation,
          })
          .pipe(
            Effect.flatMap(({ baseUrl, credential }) =>
              execute(payload, credential, correlation, { baseUrl, compositionRevision: context.compositionRevision }),
            ),
          ),
      );
    }),
  );
