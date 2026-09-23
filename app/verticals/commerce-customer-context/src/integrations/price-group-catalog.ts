import type { PriceGroupCompatibilityDecision } from '@app/price-group-catalog-contracts';
import { ValidatePriceGroupCompatibilityRequestSchema } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import type { ValidatePriceGroupCompatibilityRequest } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import {
  executeValidatePriceGroupCompatibility,
  executeValidatePriceGroupCompatibilityWithAuthorization,
} from '@app/price-group-catalog-contracts/validate-price-group-compatibility/client';
import type { ValidatePriceGroupCompatibilityClientOptions } from '@app/price-group-catalog-contracts/validate-price-group-compatibility/client';
import { Config, Effect, Match, Option, Redacted, Schema } from 'effect';

import type {
  PriceGroupCatalogOutcome,
  PriceGroupCompatibilityEvidence,
  PriceGroupInstant,
  PriceGroupRef,
} from '../../shared/domain/price-group-contracts.ts';
import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';
import { CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT } from '../../shared/domain/price-group-ports.ts';
import type { PriceGroupCatalogPort } from '../../shared/domain/price-group-ports.ts';
import {
  PriceGroupCatalogGatewayCredentialService,
  unavailablePriceGroupCatalogGatewayCredentialIssuer,
} from '../../shared/domain/price-group-catalog-gateway-credential.ts';
import type { PriceGroupCatalogGatewayCredentialIssuer } from '../../shared/domain/price-group-catalog-gateway-credential.ts';

export { PriceGroupCatalogGatewayCredentialService } from '../../shared/domain/price-group-catalog-gateway-credential.ts';

const compatibilityContractVersion = 1 as const;
const providerHttpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Price Group Catalog URL must be an HTTP(S) URL without credentials, query, or fragment',
  ),
);
const providerBaseUrl = Config.schema(providerHttpUrl, 'ONTOS_PRICE_GROUP_CATALOG_BASE_URL');

type CompatibilityClientError =
  ReturnType<typeof executeValidatePriceGroupCompatibility> extends Effect.Effect<unknown, infer Failure, unknown>
    ? Failure
    : never;

export type PriceGroupCompatibilityExecutor = (
  payload: ValidatePriceGroupCompatibilityRequest,
  requestCorrelation: string,
) => Effect.Effect<PriceGroupCompatibilityDecision, CompatibilityClientError | CustomerPriceGroupCatalogUnavailable>;

type AuthorizedPriceGroupCompatibilityExecutor = (
  payload: ValidatePriceGroupCompatibilityRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: ValidatePriceGroupCompatibilityClientOptions,
) => Effect.Effect<PriceGroupCompatibilityDecision, CompatibilityClientError | CustomerPriceGroupCatalogUnavailable>;

const executeAuthorizedCompatibility: AuthorizedPriceGroupCompatibilityExecutor = (
  payload,
  credential,
  requestCorrelation,
  options,
) =>
  executeValidatePriceGroupCompatibilityWithAuthorization(
    payload,
    Redacted.value(credential),
    requestCorrelation,
    options,
  );

const unavailable = (cause: unknown): CustomerPriceGroupCatalogUnavailable => {
  const failure = new CustomerPriceGroupCatalogUnavailable({
    code: 'customer_price_group_catalog_unavailable',
    reason: 'The Price Group Catalog compatibility decision could not be resolved',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const unavailableEvidence = (): CustomerPriceGroupCatalogUnavailable =>
  new CustomerPriceGroupCatalogUnavailable({
    code: 'customer_price_group_catalog_unavailable',
    reason: 'The Price Group Catalog returned mismatched compatibility evidence',
  });

const unavailableProviderConfiguration = (cause: unknown): CustomerPriceGroupCatalogUnavailable => {
  const failure = new CustomerPriceGroupCatalogUnavailable({
    code: 'customer_price_group_catalog_unavailable',
    reason: 'No server-owned Price Group Catalog destination is configured',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const sameReference = (left: PriceGroupRef, right: PriceGroupRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const expectedCurrent = (expected: PriceGroupCompatibilityEvidence | undefined) =>
  expected === undefined
    ? undefined
    : {
        catalogRevision: expected.catalogRevision,
        definitionRevisionId: expected.definitionRevisionId,
        definitionRevisionNumber: expected.definitionRevisionNumber,
        meaningFingerprint: expected.meaningFingerprint,
        priceGroupRef: expected.priceGroupRef,
      };

const matchesExpectedCurrent = (
  expected: PriceGroupCompatibilityEvidence | undefined,
  decision: PriceGroupCompatibilityDecision,
): boolean => {
  if (expected === undefined) {
    return true;
  }
  return Match.value(decision).pipe(
    Match.discriminatorsExhaustive('kind')({
      // oxlint-disable-next-line sonarjs/function-name -- Match key preserves the canonical owner outcome vocabulary.
      INCOMPATIBLE: ({ evidence }) =>
        evidence.evaluatedCatalogRevision === expected.catalogRevision &&
        evidence.definitionRevisionId === expected.definitionRevisionId &&
        evidence.definitionRevisionNumber === expected.definitionRevisionNumber &&
        evidence.meaningFingerprint === expected.meaningFingerprint,
      // oxlint-disable-next-line sonarjs/function-name -- Match key preserves the canonical owner outcome vocabulary.
      MISSING: () => true,
      // oxlint-disable-next-line sonarjs/function-name -- Match key preserves the canonical owner outcome vocabulary.
      RETIRED: () => true,
      // oxlint-disable-next-line sonarjs/function-name -- Match key preserves the canonical owner outcome vocabulary.
      USABLE: ({ evidence }) =>
        evidence.catalogRevision === expected.catalogRevision &&
        evidence.definitionRevisionId === expected.definitionRevisionId &&
        evidence.definitionRevisionNumber === expected.definitionRevisionNumber &&
        evidence.meaningFingerprint === expected.meaningFingerprint,
    }),
  );
};

const validateDecision = (
  requestedRef: PriceGroupRef,
  trustedOperationAt: PriceGroupInstant,
  expected: PriceGroupCompatibilityEvidence | undefined,
  decision: PriceGroupCompatibilityDecision,
): Effect.Effect<PriceGroupCompatibilityDecision, CustomerPriceGroupCatalogUnavailable> => {
  const evidence = decision.kind === 'MISSING' ? decision.catalogObservation : decision.evidence;
  const responseRef = decision.kind === 'MISSING' ? decision.priceGroupRef : decision.evidence.priceGroupRef;
  const exactRequest = sameReference(requestedRef, responseRef) && evidence.trustedOperationAt === trustedOperationAt;
  const exactContract =
    decision.kind !== 'USABLE' && decision.kind !== 'INCOMPATIBLE'
      ? true
      : decision.evidence.requiredContract.contractId === CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT &&
        decision.evidence.requiredContract.version === compatibilityContractVersion;

  return exactRequest && exactContract && matchesExpectedCurrent(expected, decision)
    ? Effect.succeed(decision)
    : Effect.fail(unavailableEvidence());
};

const toCommerceOutcome = (decision: PriceGroupCompatibilityDecision): PriceGroupCatalogOutcome =>
  Match.value(decision).pipe(
    Match.discriminatorsExhaustive('kind')({
      // oxlint-disable-next-line sonarjs/function-name -- Match key preserves the canonical owner outcome vocabulary.
      INCOMPATIBLE: ({ evidence }) => ({
        _tag: 'INCOMPATIBLE' as const,
        catalogRevision: evidence.evaluatedCatalogRevision,
        contractId: evidence.requiredContract.contractId,
      }),
      // oxlint-disable-next-line sonarjs/function-name -- Match key preserves the canonical owner outcome vocabulary.
      MISSING: () => ({ _tag: 'MISSING' as const }),
      // oxlint-disable-next-line sonarjs/function-name -- Match key preserves the canonical owner outcome vocabulary.
      RETIRED: ({ evidence }) => ({
        _tag: 'RETIRED' as const,
        catalogRevision: evidence.acceptedCatalogRevision,
      }),
      // oxlint-disable-next-line sonarjs/function-name -- Match key preserves the canonical owner outcome vocabulary.
      USABLE: ({ evidence }) => ({
        _tag: 'USABLE' as const,
        compatibility: evidence,
        priceGroupRef: evidence.priceGroupRef,
      }),
    }),
  );

const requestPayload = (
  priceGroupRef: PriceGroupRef,
  requiredContractId: typeof CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
  trustedOperationAt: PriceGroupInstant,
  expected: PriceGroupCompatibilityEvidence | undefined,
): Effect.Effect<ValidatePriceGroupCompatibilityRequest, CustomerPriceGroupCatalogUnavailable> =>
  expected !== undefined &&
  (!sameReference(priceGroupRef, expected.priceGroupRef) ||
    expected.requiredContract.contractId !== requiredContractId ||
    expected.requiredContract.version !== compatibilityContractVersion)
    ? Effect.fail(unavailableEvidence())
    : Schema.decodeUnknownEffect(ValidatePriceGroupCompatibilityRequestSchema)(
        expected === undefined
          ? {
              priceGroupRef,
              requiredContract: { contractId: requiredContractId, version: compatibilityContractVersion },
              trustedOperationAt,
            }
          : {
              expectedCurrent: expectedCurrent(expected),
              priceGroupRef,
              requiredContract: { contractId: requiredContractId, version: compatibilityContractVersion },
              trustedOperationAt,
            },
      ).pipe(Effect.mapError(unavailable));

export const priceGroupCatalogPort = (
  requestCorrelation: string,
  execute: PriceGroupCompatibilityExecutor = executeValidatePriceGroupCompatibility,
): PriceGroupCatalogPort => ({
  resolveCurrent: (priceGroupRef, requiredContractId, trustedOperationAt, expected) =>
    requestPayload(priceGroupRef, requiredContractId, trustedOperationAt, expected).pipe(
      Effect.flatMap((payload) => execute(payload, requestCorrelation)),
      Effect.mapError(unavailable),
      Effect.flatMap((decision) => validateDecision(priceGroupRef, trustedOperationAt, expected, decision)),
      Effect.map(toCommerceOutcome),
    ),
});

const authorizedExecutor =
  (
    issuer: PriceGroupCatalogGatewayCredentialIssuer,
    baseUrl: URL,
    execute: AuthorizedPriceGroupCompatibilityExecutor,
  ): PriceGroupCompatibilityExecutor =>
  (payload, correlation) =>
    issuer
      .issue({
        audience: 'price-group-catalog',
        requestCorrelation: correlation,
      })
      .pipe(Effect.flatMap((credential) => execute(payload, credential, correlation, { baseUrl })));

export const priceGroupCatalogPortFromEnvironment = (
  context: {
    readonly requestCorrelation: string;
  },
  execute: AuthorizedPriceGroupCompatibilityExecutor = executeAuthorizedCompatibility,
): Effect.Effect<PriceGroupCatalogPort> =>
  Effect.serviceOption(PriceGroupCatalogGatewayCredentialService).pipe(
    Effect.flatMap((issuerOption) =>
      providerBaseUrl.pipe(
        Effect.match({
          onFailure: (cause) =>
            priceGroupCatalogPort(context.requestCorrelation, () =>
              Effect.fail(unavailableProviderConfiguration(cause)),
            ),
          onSuccess: (baseUrl) => {
            const issuer = Option.isSome(issuerOption)
              ? issuerOption.value
              : unavailablePriceGroupCatalogGatewayCredentialIssuer;
            return priceGroupCatalogPort(context.requestCorrelation, authorizedExecutor(issuer, baseUrl, execute));
          },
        }),
      ),
    ),
  );
