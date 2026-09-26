import { executeQuantityPreparationWithAuthorization } from '@app/catalog/api/quantity-preparation-client';
import { Effect, Option, Redacted, Schema } from 'effect';

import {
  CatalogQuantityGatewayCredentialService,
  unavailableCatalogQuantityGatewayCredentialIssuer,
} from '../../shared/domain/catalog-quantity-gateway-credential.ts';
import type { CatalogQuantityGatewayCredentialIssuer } from '../../shared/domain/catalog-quantity-gateway-credential.ts';
import type {
  CommerceQuantityCatalogLineRequest,
  CommerceQuantityCatalogPortService,
  CommerceQuantityCatalogUnavailable,
  CurrentCommerceQuantityCatalogLine,
} from '../../shared/domain/commerce-quantity-catalog-port.ts';
import { ExactPositiveCommerceQuantitySchema } from '../../shared/domain/customer-commerce-policy.ts';

type QuantityPreparationRequest = Parameters<typeof executeQuantityPreparationWithAuthorization>[0];
type QuantityPreparationEffect = ReturnType<typeof executeQuantityPreparationWithAuthorization>;
type QuantityPreparationResponse =
  QuantityPreparationEffect extends Effect.Effect<infer Success, unknown, unknown> ? Success : never;
type QuantityPreparationFailure =
  QuantityPreparationEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type QuantityPreparationExecutor = (
  payload: QuantityPreparationRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL },
) => Effect.Effect<QuantityPreparationResponse, QuantityPreparationFailure>;

const executeQuantityPreparation: QuantityPreparationExecutor = (payload, credential, requestCorrelation, options) =>
  executeQuantityPreparationWithAuthorization(payload, Redacted.value(credential), requestCorrelation, options);

const unavailable = (
  code: CommerceQuantityCatalogUnavailable['code'],
  reason: string,
  cause?: unknown,
): CommerceQuantityCatalogUnavailable => {
  const failure: CommerceQuantityCatalogUnavailable = {
    _tag: 'CommerceQuantityCatalogUnavailable',
    code,
    reason,
    retryable: true,
  };
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const failureFor = (result: Exclude<QuantityPreparationResponse, { readonly status: 'READY' }>) => {
  let code: CommerceQuantityCatalogUnavailable['code'];
  if (result.status === 'INVALID') {
    code = 'catalog_selection_invalid';
  } else if (result.status === 'STALE') {
    code = 'catalog_selection_stale';
  } else {
    code = 'catalog_selection_unverifiable';
  }
  return unavailable(code, result.reason);
};

const decodeOwnerQuantity = (value: string) =>
  Schema.decodeEffect(ExactPositiveCommerceQuantitySchema)(value).pipe(
    Effect.mapError((cause) =>
      unavailable('catalog_selection_invalid', 'Catalog returned invalid Quantity evidence', cause),
    ),
  );

const resolveCurrentSelection = (
  line: CommerceQuantityCatalogLineRequest,
  credential: Redacted.Redacted,
  context: { readonly requestCorrelation: string },
  baseUrl: URL,
  execute: QuantityPreparationExecutor,
): Effect.Effect<CurrentCommerceQuantityCatalogLine, CommerceQuantityCatalogUnavailable> =>
  execute(
    {
      amount: line.requestedQuantity,
      purpose: 'PURCHASE_ACCEPTANCE',
      selection: line.selection,
    },
    credential,
    context.requestCorrelation,
    { baseUrl },
  ).pipe(
    Effect.mapError((cause) =>
      unavailable('catalog_selection_unavailable', 'Catalog Quantity preparation is unavailable', cause),
    ),
    Effect.flatMap((result) => {
      if (result.status !== 'READY') {
        return Effect.fail(failureFor(result));
      }
      return Effect.all(
        {
          normalizedQuantity: decodeOwnerQuantity(result.quantity.resulting),
          physicalMultiple: decodeOwnerQuantity(result.quantity.step),
          requestedQuantity: decodeOwnerQuantity(result.quantity.requested),
        },
        { concurrency: 3 },
      ).pipe(
        Effect.map((quantity) => ({
          lineId: line.lineId,
          selection: {
            basis: result.quantityBasis,
            catalogSelection: result.selection,
            completeness: result.completeness,
            divisible: result.divisible,
            equivalentSelectionKey: result.equivalentSelectionKey,
            hierarchyRevision: result.hierarchyRevision,
            normalizedQuantity: quantity.normalizedQuantity,
            ownerRevision: result.ownerRevision,
            physicalMultiple: quantity.physicalMultiple,
            requestedQuantity: quantity.requestedQuantity,
          },
        })),
      );
    }),
  );

const makeCatalogQuantityPort = (dependencies: {
  readonly context: { readonly legalEntityId: string; readonly requestCorrelation: string };
  readonly execute: QuantityPreparationExecutor;
  readonly issuer: CatalogQuantityGatewayCredentialIssuer;
}): CommerceQuantityCatalogPortService => ({
  resolveCurrentSelections: ({ lines, tenantId }) =>
    dependencies.issuer
      .issue({
        audience: 'catalog',
        legalEntityId: dependencies.context.legalEntityId,
        requestCorrelation: dependencies.context.requestCorrelation,
      })
      .pipe(
        Effect.flatMap(({ baseUrl, credential }) =>
          Effect.forEach(
            lines,
            (line) => resolveCurrentSelection(line, credential, dependencies.context, baseUrl, dependencies.execute),
            { concurrency: 8 },
          ),
        ),
        Effect.filterOrFail(
          (resolved) => resolved.every(({ selection }) => selection.catalogSelection.productRef.tenantId === tenantId),
          () => unavailable('catalog_selection_invalid', 'Catalog returned a selection outside the trusted Tenant'),
        ),
      ),
});

export const catalogQuantityPortFromEnvironment = (
  context: { readonly legalEntityId: string; readonly requestCorrelation: string },
  execute: QuantityPreparationExecutor = executeQuantityPreparation,
): Effect.Effect<CommerceQuantityCatalogPortService> =>
  Effect.serviceOption(CatalogQuantityGatewayCredentialService).pipe(
    Effect.map((issuerOption) =>
      makeCatalogQuantityPort({
        context,
        execute,
        issuer: Option.isSome(issuerOption) ? issuerOption.value : unavailableCatalogQuantityGatewayCredentialIssuer,
      }),
    ),
  );
