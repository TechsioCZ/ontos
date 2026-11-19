import {
  executeCurrentPaymentTerms,
  executeCurrentPaymentTermsWithAuthorization,
} from '@app/payment-term-catalog-contracts/current-payment-terms/client';
import type {
  CurrentPaymentTermsRequest,
  CurrentPaymentTermsResponse,
} from '@app/payment-term-catalog-contracts/current-payment-terms';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { callAnswer } from '@app/core-runtime/sdk';
import type { CallOutcome } from '@app/core-runtime/sdk';
import { Crypto, Effect, Redacted } from 'effect';

import { isPaymentTermDefinitionSupported } from '../../shared/domain/payment-term-contracts.ts';
import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import type { PaymentTermCatalogPort, PaymentTermDefinitionRequest } from '../persistence/payment-term-persistence.ts';

type DelegatedGatewayAcquisition = typeof acquireDelegatedGatewayContext;

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

/** The port over one source of Catalog answers: one request per instant and batch, one after another. */
const catalogPortOver = <Failure>(
  fetch: (payload: CurrentPaymentTermsRequest) => Effect.Effect<CurrentPaymentTermsResponse, Failure>,
): PaymentTermCatalogPort => ({
  resolveDefinitions: (requests) =>
    Effect.forEach(
      groupedByInstant(requests),
      (batch) => {
        const [first, ...rest] = batch;
        return first === undefined
          ? Effect.succeed([])
          : fetch(requestPayload([first, ...rest])).pipe(
              Effect.mapError(unavailable),
              Effect.flatMap(catalogDefinitions),
            );
      },
      { concurrency: 1 },
    ).pipe(Effect.map((definitions) => definitions.flat())),
});

export const paymentTermCatalogPort = (
  requestCorrelation: string,
  execute: CurrentPaymentTermsExecutor = executeCurrentPaymentTerms,
): PaymentTermCatalogPort => catalogPortOver((payload) => execute(payload, requestCorrelation));

/**
 * The port over Core's `call` to the Catalog (a `{ run }` read). Core owns the credential, the route and
 * the decoding; every outcome other than the Catalog's answer is unavailable, never an empty catalog.
 */
export const paymentTermCatalogPortFromCall = (
  call: (payload: CurrentPaymentTermsRequest) => Effect.Effect<CallOutcome<CurrentPaymentTermsResponse>>,
): PaymentTermCatalogPort =>
  catalogPortOver((payload) =>
    call(payload).pipe(Effect.flatMap((outcome) => Effect.fromOption(callAnswer(outcome), () => outcome))),
  );

export const paymentTermCatalogPortFromEnvironment = Effect.fn('PaymentTermCatalog.portFromEnvironment')(
  function* paymentTermCatalogPortFromEnvironment(
    context: {
      readonly legalEntityId: string;
      readonly requestCorrelation: string;
      readonly subject: GatewayDelegationSubject;
    },
    execute: AuthorizedCurrentPaymentTermsExecutor = executeAuthorizedCurrentPaymentTerms,
    acquire: DelegatedGatewayAcquisition = acquireDelegatedGatewayContext,
  ) {
    const crypto = yield* Crypto.Crypto;
    return paymentTermCatalogPort(context.requestCorrelation, (payload, correlation) =>
      acquire(
        {
          audience: 'payment-term-catalog',
          legalEntityScope: 'subject',
          requestCorrelation: correlation,
          subject: context.subject,
        },
        crypto,
      ).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((issued) =>
          execute(payload, Redacted.make(issued.authorization), correlation, {
            baseUrl: new URL(issued.apiBaseUrl),
            compositionRevision: issued.compositionRevision,
          }),
        ),
      ),
    );
  },
);
