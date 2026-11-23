#!/usr/bin/env node
/**
 * Live HTTP acceptance, not a seed. Importing this module does not perform I/O.
 * The parent supplies endpoint/env wiring and explicitly executes a runner to create scoped demo records.
 * No order placement, invoices, mail, database access, native services, or cleanup deletes are performed here.
 *
 * Public payload sources:
 * apps/shell-super-app/api/symmy/{products,customers,stock,price-lists-batch-upsert,
 * price-lists-prices-batch}-request-contract.ts and customer-groups-batch-request-contract.ts.
 * Receipt semantics: packages/shared-contracts/src/symmy/outcomes.ts and symmy/contract.ts.
 * Only the response fields used by this outside proof are decoded below. Importing the full server
 * schema graph would load unrelated server modules into this standalone operator command.
 */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { Option, Redacted, Schema } from 'effect';
import { SymmyProductsBatchRequestSchema } from '../../apps/shell-super-app/api/symmy/products-batch-request-contract.ts';
import { SymmyCustomersBatchRequestSchema } from '../../apps/shell-super-app/api/symmy/customers-batch-request-contract.ts';
import { SymmyCustomerGroupsBatchRequestSchema } from '../../apps/shell-super-app/api/symmy/customer-groups-batch-request-contract.ts';
import { SymmyGroupCustomersBatchRequestSchema } from '../../apps/shell-super-app/api/symmy/group-customers-batch-request-contract.ts';
import { SymmyStockBatchRequestSchema } from '../../apps/shell-super-app/api/symmy/stock-batch-request-contract.ts';
import { SymmyPriceListsBatchRequestSchema } from '../../apps/shell-super-app/api/symmy/price-lists-batch-upsert-request-contract.ts';
import { SymmyPriceListPricesBatchRequestSchema } from '../../apps/shell-super-app/api/symmy/price-lists-prices-batch-request-contract.ts';
import {
  SymmyDemoCategoriesBatchRequestSchema,
  SymmyDemoProductsBatchRequestSchema,
  SymmyDemoMediaUploadRequestSchema,
  SymmyDemoCatalogBatchResponseSchema,
  SymmyDemoCatalogRevisionResponseSchema,
} from '../../apps/shell-super-app/api/symmy/demo-catalog-contract.ts';
import { SkuLookupRequestSchema, SkuLookupResponseSchema } from '../../verticals/catalog/shared/apis/sku-lookup.ts';
import { CatalogPagePricesRequestSchema, CatalogPagePricesResponseSchema } from '@app/pricing-contracts/catalog-page-prices';
import {
  SourceStockPositionResolutionRequestSchema,
  SourceStockPositionResolutionResponseSchema,
} from '../../verticals/inventory/shared/apis/source-stock-position-resolution.ts';
import {
  CurrentStockEvidenceForAvailabilityRequestSchema,
  CurrentStockEvidenceForAvailabilityResponseSchema,
} from '../../verticals/inventory/shared/apis/current-stock-evidence-for-availability.ts';
import {
  SavedAddressListRequestSchema,
  SavedAddressListResponseSchema,
} from '../../verticals/commerce-customer-context/shared/apis/saved-address-list.ts';
import {
  EffectiveCustomerGroupMembershipsRequestSchema,
  EffectiveCustomerGroupMembershipsResponseSchema,
} from '../../verticals/commerce-customer-context/shared/apis/effective-customer-group-memberships.ts';
import {
  CustomerGroupDetailRequestSchema,
  CustomerGroupDetailResponseSchema,
} from '../../verticals/commerce-customer-context/shared/apis/customer-group-detail.ts';
import { RecordsRequestSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import { SymmyDemoOrderSchema } from '../../apps/shell-super-app/api/symmy/demo-orders-contract.ts';
import { fullOrderTotals, lineGrossMinor, orderLineVatMinor, vatInGrossMinor } from '../../verticals/merchandise/shared/domain/order-totals.ts';

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const uuid = Schema.String.check(Schema.isUUID());
const RefSchema = Schema.Struct({
  moduleId: text,
  resourceId: uuid,
  resourceType: text,
  tenantId: uuid,
});
export type ProofRef = typeof RefSchema.Type;
const accepted = Schema.Literals(['accepted_change', 'accepted_no_change']);
const EffectSchema = Schema.Union([
  Schema.Struct({ effectId: uuid, owner: text, status: accepted }),
  Schema.Struct({ effectId: uuid, originalStatus: accepted, owner: text, status: Schema.Literal('duplicate') }),
  Schema.Struct({
    effectId: Schema.optionalKey(uuid),
    owner: text,
    status: Schema.Literals([
      'waiting', 'executing', 'indeterminate', 'unsupported', 'stale', 'unresolved',
      'ambiguous', 'denied', 'conflict', 'unavailable', 'invalid',
    ]),
  }),
]);
const ItemSchema = Schema.Struct({
  effects: Schema.NonEmptyArray(EffectSchema),
  itemId: uuid,
  outcome: Schema.Literals(['accepted', 'partial', 'not_accepted']),
});
const ItemsSchema = Schema.Struct({ items: Schema.NonEmptyArray(ItemSchema) });
type Items = typeof ItemsSchema.Type;
const AdmissionSchema = Schema.Struct({ jobId: uuid, status: Schema.Literal('queued') });
const JobSchema = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(ItemSchema)),
  jobId: uuid,
  status: Schema.Literals([
    'queued', 'running', 'blocked', 'indeterminate', 'completed_all', 'completed_partial', 'completed_none',
  ]),
});
const ProductPageSchema = Schema.Struct({
  count: Schema.Int,
  products: Schema.Array(Schema.Struct({
    id: text,
    product: Schema.Struct({
      name: Schema.optionalKey(text),
      productRef: RefSchema,
      variants: Schema.Array(Schema.Struct({ variantId: uuid, variantRef: RefSchema })),
    }),
    sourceRecordId: text,
    variantSources: Schema.Array(Schema.Struct({ sourceRecordId: text, variantId: uuid })),
  })),
});
const PREFIX = '/api/symmy/v1';
const MAX_RESPONSE_BYTES = 2_000_000;
/** Published Akros stage example refs, not per-item grants or stock seeds. */
export const AKROS_STAGE_PROOF_INPUT = {
  commercialScope: { channelId: 'B2C', marketId: 'e57c614d-3911-5a52-941e-29168b1db5e4' },
  currencyCode: 'CZK',
  locationKey: 'AKROS-SKLAD-1',
  unitRef: {
    moduleId: 'commerce.catalog',
    resourceId: '43d5c797-2b36-4877-85ad-caac3a674d9c',
    resourceType: 'commerce.catalog.product-unit',
    tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
  },
} satisfies SymmyProofInput;

export const SymmyProofInputSchema = Schema.Struct({
  commercialScope: Schema.Struct({
    channelId: Schema.Literals(['B2C', 'B2B']),
    marketId: text,
  }),
  currencyCode: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)),
  locationKey: text,
  unitRef: RefSchema,
});
export type SymmyProofInput = typeof SymmyProofInputSchema.Type;
const stockSourceFields = SourceStockPositionResolutionRequestSchema.fields;
export const SymmyProofStockSourceSchema = Schema.Struct({
  customerConfigurationId: stockSourceFields.customerConfigurationId,
  externalScope: stockSourceFields.externalScope,
  issuer: stockSourceFields.issuer,
  namespace: stockSourceFields.namespace,
});
/** Qualification published in docs/integrations/symmy-akros-operator.md; override with current operator facts if changed. */
export const AKROS_STAGE_STOCK_SOURCE = {
  customerConfigurationId: 'akros',
  externalScope: 'akros',
  issuer: { backendId: 'akros-erp', backendKind: 'external_business_system' },
  namespace: 'akros-erp',
};
export interface SymmyProofConfig {
  readonly origin: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly input: SymmyProofInput;
  readonly legalEntityId?: string;
  readonly stockSource?: typeof SymmyProofStockSourceSchema.Type;
  readonly operatorCookie?: Redacted.Redacted<string>;
  /** Whole-run budget; all fetches and polling share it. Defaults to ten minutes. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}
export type ProofBoundary =
  | 'configuration' | 'product-unseen' | 'product-import' | 'product-readback' | 'product-replay'
  | 'sku-readback' | 'base-price-readback' | 'stock-import' | 'stock-readback' | 'price-list-import'
  | 'price-list-readback' | 'list-price-import' | 'list-price-readback'
  | 'customer-import' | 'customer-readback' | 'customer-replay' | 'address-readback'
  | 'group-import' | 'group-assignment' | 'group-replay' | 'group-readback'
  | 'category-import' | 'category-readback' | 'image-import' | 'image-readback'
  | 'order-export' | 'full-proof';
type FailureCode =
  | 'input-contract' | 'schema' | 'network' | 'timeout' | 'response-too-large' | 'redirect'
  | 'http-status' | 'job-identity' | 'job-terminal' | 'item-count' | 'effect-count'
  | 'effect-outcome' | 'effect-owner' | 'replay-identity' | 'readback' | 'not-unseen'
  | 'missing-wiring' | 'unsafe-path' | 'unexpected'
  | 'lane-failed'
  | 'read-auth-required' | 'read-auth-scope' | 'read-permission' | 'read-auth-expired';
const SAFE_PROBLEM_TAGS = new Set([
  'GatewayAuthenticationRequiredProblem', 'GatewayForbiddenProblem', 'GatewayUnavailableProblem',
  'GatewayAudienceInvalidProblem', 'GatewayReloadRequiredProblem', 'GatewayRateLimitedProblem', 'GatewayInternalProblem',
  'SymmyInvalidProblem', 'SymmyUnavailableProblem', 'SymmyUnsupportedProblem', 'SymmyIdempotencyRequiredProblem',
  'SymmyFixtureIntentConflictProblem', 'SymmyFixtureJobNotFoundProblem', 'SymmyStockInputProblem',
  'SymmyStockDependencyNotReadyProblem', 'SymmyStockSourceUnavailableProblem', 'SymmyDemoOrderNotFoundProblem',
  ...[
    'ImportSourceCatalogAction', 'SkuLookup', 'SourceStockPositionResolution', 'CurrentStockEvidenceForAvailability',
    'SavedAddressList', 'EffectiveCustomerGroupMemberships', 'CustomerGroupDetail', 'CatalogPagePrices', 'Records',
  ].flatMap((prefix) => [
    'AuthenticationProblem', 'ForbiddenProblem', 'InvalidProblem', 'NotFoundProblem', 'ConflictProblem',
    'PolicyProblem', 'PolicyConflictProblem', 'IneligibleProblem', 'PreconditionProblem', 'UnavailableProblem',
    'InternalProblem', 'AlreadyCommittedProblem', 'CommitIndeterminateProblem',
  ].map((suffix) => `${prefix}${suffix}`)),
]);
// Only closed contract codes may leave the process. Never retain detail/title, response previews, IDs or arbitrary reasons.
const SAFE_PROBLEM_CODES = new Set([
  'LOCATION_NOT_ENROLLED', 'UNIT_NOT_ENROLLED', 'ITEM_NOT_PROVISIONED', 'POSITION_NOT_FOUND', 'POLICY_NOT_FOUND',
  'LOCATION_NOT_ALLOWED', 'ITEM_CORRELATION_AMBIGUOUS', 'OWNER_RESOLUTION_MISMATCH', 'TENANT_SCOPE_MISMATCH',
  'OWNER_UNAVAILABLE', 'projection_not_configured', 'filter_not_supported', 'owner_field_not_supported', 'search_too_broad',
  'action_approval_required', 'action_permission_denied', 'module_state_denied', 'operation_context_denied',
  'operation_context_invalid', 'merchandise_permission_denied', 'merchandise_scope_mismatch',
  'action_invocation_not_found', 'merchandise_not_found', 'action_request_hash_conflict',
  'action_invocation_state_invalid', 'merchandise_category_slug_taken', 'merchandise_lifecycle_conflict',
  'merchandise_offered_price_changed', 'merchandise_stock_reconciliation_required', 'merchandise_tier_base_price_required',
  'merchandise_variant_bulk_price_unsupported', 'merchandise_variant_sku_required', 'merchandise_revision_conflict',
  'action_policy_denied', 'merchandise_reference_ineligible', 'action_invocation_persistence_failed',
  'action_permission_check_failed', 'action_policy_evaluation_failed', 'action_transaction_failed',
  'module_state_check_unavailable', 'operation_context_unavailable', 'merchandise_persistence_unavailable',
  'action_already_committed', 'action_commit_indeterminate', 'action_invocation_already_committed',
  'read_handler_unavailable', 'key_provider_unavailable', 'issuer_unavailable', 'gateway_dispatch_failed',
]);
type EffectStatus = typeof EffectSchema.Type.status;
export type SymmySafeFailureBody =
  | { readonly kind: 'lanes'; readonly failed: readonly SymmyProofLaneName[] }
  | { readonly kind: 'non-json' | 'empty' | 'unrecognized-problem' }
  | {
      readonly kind: 'problem'; readonly tag?: string; readonly code?: string;
      readonly reason?: string; readonly retryable?: boolean;
    }
  | {
      readonly kind: 'effects' | 'job'; readonly status?: typeof JobSchema.Type.status;
      readonly items: number; readonly effects: Partial<Record<EffectStatus, number>>;
    };
const ProblemMetadataSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.Unknown), code: Schema.optionalKey(Schema.Unknown),
  reason: Schema.optionalKey(Schema.Unknown), retryable: Schema.optionalKey(Schema.Unknown),
});
export function sanitizeSymmyFailureBody(body: unknown, credential: Redacted.Redacted<string>): SymmySafeFailureBody {
  const metadata = Option.getOrUndefined(Schema.decodeUnknownOption(ProblemMetadataSchema)(body));
  if (metadata === undefined) return { kind: 'unrecognized-problem' };
  const allowed = (value: unknown, values: ReadonlySet<string>): value is string =>
    typeof value === 'string' && values.has(value) && !value.includes(Redacted.value(credential));
  const tag = allowed(metadata._tag, SAFE_PROBLEM_TAGS) ? metadata._tag : undefined;
  const code = allowed(metadata.code, SAFE_PROBLEM_CODES) ? metadata.code : undefined;
  const reason = allowed(metadata.reason, SAFE_PROBLEM_CODES) ? metadata.reason : undefined;
  if (tag === undefined && code === undefined && reason === undefined) return { kind: 'unrecognized-problem' };
  return {
    kind: 'problem',
    ...(tag === undefined ? {} : { tag }),
    ...(code === undefined ? {} : { code }),
    ...(reason === undefined ? {} : { reason }),
    ...(typeof metadata.retryable === 'boolean' ? { retryable: metadata.retryable } : {}),
  };
}
function effectDiagnostic(items: readonly typeof ItemSchema.Type[]): SymmySafeFailureBody {
  const counts: Partial<Record<EffectStatus, number>> = {};
  for (const item of items) for (const effect of item.effects) counts[effect.status] = (counts[effect.status] ?? 0) + 1;
  return { kind: 'effects', effects: counts, items: items.length };
}

/** Contains only fixed boundary/code strings and an optional numeric HTTP status, never a body or cause. */
export class SymmyProofFailure extends Error {
  readonly boundary: ProofBoundary;
  readonly code: FailureCode;
  readonly status: number | undefined;
  readonly safeBody: SymmySafeFailureBody | undefined;
  constructor(boundary: ProofBoundary, code: FailureCode, status?: number, safeBody?: SymmySafeFailureBody) {
    super(`FAIL ${boundary}:${code}${status === undefined ? '' : `:${status}`}` +
      (safeBody === undefined ? '' : ` body=${JSON.stringify(safeBody)}`));
    this.name = 'SymmyProofFailure';
    this.boundary = boundary;
    this.code = code;
    this.status = status;
    this.safeBody = safeBody;
  }
}
function ensure(
  condition: unknown, boundary: ProofBoundary, code: FailureCode, safeBody?: SymmySafeFailureBody,
): asserts condition {
  if (!condition) throw new SymmyProofFailure(boundary, code, undefined, safeBody);
}
function decode<A>(schema: Schema.ConstraintDecoder<A>, body: unknown, boundary: ProofBoundary): A {
  try {
    return Schema.decodeUnknownSync(schema)(body);
  } catch {
    throw new SymmyProofFailure(boundary, 'schema');
  }
}
function validatePayload(schema: Schema.ConstraintDecoder<unknown>, body: unknown, boundary: ProofBoundary): void {
  try {
    Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(body);
  } catch {
    throw new SymmyProofFailure(boundary, 'input-contract');
  }
}
export interface EffectExpectation {
  readonly itemsAtLeast: number;
  readonly effectsAtLeast: number;
  readonly owners: Readonly<Record<string, number>>;
}
export function assertAcceptedEffects(
  body: unknown,
  expected: EffectExpectation,
  boundary: ProofBoundary,
): Items {
  ensure(
    Number.isInteger(expected.itemsAtLeast) && expected.itemsAtLeast > 0 &&
    Number.isInteger(expected.effectsAtLeast) && expected.effectsAtLeast > 0 &&
    Object.keys(expected.owners).length > 0 &&
    Object.values(expected.owners).every((count) => Number.isInteger(count) && count > 0),
    boundary, 'input-contract',
  );
  const result = decode(ItemsSchema, body, boundary);
  const diagnostic = effectDiagnostic(result.items);
  ensure(result.items.length >= expected.itemsAtLeast, boundary, 'item-count', diagnostic);
  const effects = result.items.flatMap((item) => {
    ensure(item.outcome === 'accepted', boundary, 'effect-outcome', diagnostic);
    return item.effects;
  });
  ensure(effects.length >= expected.effectsAtLeast, boundary, 'effect-count', diagnostic);
  for (const effect of effects) {
    ensure(
      effect.status === 'accepted_change' || effect.status === 'accepted_no_change' || effect.status === 'duplicate',
      boundary, 'effect-outcome', diagnostic,
    );
  }
  for (const [owner, count] of Object.entries(expected.owners)) {
    ensure(effects.filter((effect) => effect.owner === owner).length >= count, boundary, 'effect-owner', diagnostic);
  }
  return result;
}
export function assertReplayIdentity(original: Items, replay: Items, boundary: ProofBoundary): void {
  const identity = (result: Items) => result.items.map((item) => ({
    effects: item.effects.map((effect) => ({
      effectId: effect.effectId, owner: effect.owner,
    })).toSorted((a, b) => (a.effectId ?? '').localeCompare(b.effectId ?? '')),
    itemId: item.itemId,
  })).toSorted((a, b) => a.itemId.localeCompare(b.itemId));
  ensure(isDeepStrictEqual(identity(original), identity(replay)), boundary, 'replay-identity');
}
export function makeSymmyProofNames() {
  const prefix = `SP_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  return {
    prefix,
    product: `${prefix}_PRODUCT`,
    variant: `${prefix}_VARIANT`,
    organization: `${prefix}_ORG`,
    person: `${prefix}_PERSON`,
    group: `${prefix}_GROUP`,
    list: `${prefix}_LIST`,
    category: `${prefix}_CATEGORY`,
    image: `${prefix}_IMAGE`,
  };
}
export type SymmyProofNames = ReturnType<typeof makeSymmyProofNames>;
export interface SymmyProductProof {
  readonly names: SymmyProofNames;
  readonly productRef: ProofRef;
  readonly variantRef: ProofRef;
  readonly baseAmount: string;
  readonly stockAmount: string;
  readonly listAmount: string;
  readonly effectiveFrom: string;
}
const PriceListsPageSchema = Schema.Struct({
  count: Schema.Int,
  priceLists: Schema.Array(Schema.Struct({
    code: text,
    name: text,
    priceGroupRef: RefSchema,
    prices: Schema.optionalKey(Schema.Struct({
      count: Schema.Int,
      prices: Schema.Array(Schema.Struct({ price: Schema.Unknown })),
    })),
  })),
});
const CurrentPriceSchema = Schema.Struct({
  definition: Schema.Struct({
    identityKey: Schema.Struct({
      catalogSelection: Schema.Struct({ productRef: RefSchema, variantRef: RefSchema }),
      commercialScope: Schema.Struct({ channelId: text, marketId: text }),
      priceGroupSelector: Schema.Struct({ kind: Schema.Literal('PRICE_GROUP'), priceGroupRef: RefSchema }),
      unitBasis: Schema.Struct({ quantity: text, unitRef: RefSchema }),
    }),
    priceRef: RefSchema,
    revision: Schema.Struct({
      effectiveFrom: text,
      monetaryAmount: Schema.Struct({ amount: text, currencyCode: text }),
      revision: Schema.Int,
      revisionId: uuid,
    }),
  }),
  outcome: Schema.Literal('PRICE_DEFINITION_CURRENT'),
});
export interface SymmyCommerceProof extends SymmyProductProof {
  readonly priceGroupRef: ProofRef;
}
const PRICE_EFFECTS = {
  effectsAtLeast: 1, itemsAtLeast: 1, owners: { 'commerce.pricing': 1 },
} satisfies EffectExpectation;
export async function proveSymmyProductStockList(
  config: SymmyProofConfig,
  client: SymmyProofClient = createSymmyProofClient(config),
): Promise<SymmyCommerceProof> {
  const proof = await proveSymmyProduct(config, client);
  const { input } = config;
  const stockBody = {
    stock: [{
      businessObservedAt: new Date().toISOString(),
      itemKey: proof.names.variant,
      locationKey: input.locationKey,
      quantity: { amount: proof.stockAmount, unitRef: input.unitRef },
      revision: '1',
      sourceReference: `${proof.names.prefix}:stock:1`,
    }],
  };
  validatePayload(SymmyStockBatchRequestSchema, stockBody, 'stock-import');
  const stockResult = await client.write(
    `${PREFIX}/inventory/stock/batch`, stockBody, `${proof.names.prefix}.stock`, 'stock-import',
  );
  await client.settle(stockResult, {
    effectsAtLeast: 1, itemsAtLeast: 1, owners: { 'commerce.inventory': 1 },
  }, 'stock-import');
  const stockKeys = decode(Schema.Struct({
    items: Schema.NonEmptyArray(Schema.Struct({ itemKey: text, locationKey: text })),
  }), stockResult.body, 'stock-import');
  ensure(
    stockKeys.items.length === 1 && stockKeys.items[0]?.itemKey === proof.names.variant &&
    stockKeys.items[0]?.locationKey === input.locationKey,
    'stock-import', 'readback',
  );
  // The Price Group owner requires creation in the future; do not reuse the product timestamp after a slow job.
  const startsAt = new Date(Date.now() + 120_000).toISOString();
  const listBody = {
    priceLists: [{
      businessCode: proof.names.list, code: proof.names.list,
      description: `${proof.names.prefix} acceptance price list`,
      effectiveFrom: startsAt, name: proof.names.list,
      purpose: `Scoped Symmy HTTP acceptance price list ${proof.names.prefix}`,
    }],
  };
  validatePayload(SymmyPriceListsBatchRequestSchema, listBody, 'price-list-import');
  await client.settle(await client.write(
    `${PREFIX}/price-lists/batch-upsert`, listBody, `${proof.names.prefix}.list`, 'price-list-import',
  ), { effectsAtLeast: 1, itemsAtLeast: 1, owners: { 'pricing.price-group-catalog': 1 } }, 'price-list-import');
  await client.waitUntil(startsAt, 'price-list-readback');
  const findList = async (boundary: 'price-list-readback' | 'list-price-readback') => {
    // Public GET /price-lists has no code/q filter. Bound the scan; never dump existing price/customer data.
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = decode(PriceListsPageSchema, await client.read(
        `${PREFIX}/price-lists?limit=100&offset=${offset}&priceLimit=100`, boundary,
      ), boundary);
      const matches = page.priceLists.filter((list) => list.code === proof.names.list);
      ensure(matches.length <= 1, boundary, 'readback');
      if (matches[0] !== undefined) return matches[0];
      if (offset + 100 >= page.count) break;
    }
    throw new SymmyProofFailure(boundary, 'readback');
  };
  const list = await findList('price-list-readback');
  ensure(
    list.name === proof.names.list && list.priceGroupRef.tenantId === proof.productRef.tenantId,
    'price-list-readback', 'readback',
  );
  const priceBody = {
    priceGroupRef: list.priceGroupRef,
    prices: [{
      amount: proof.listAmount, commercialScope: input.commercialScope, currencyCode: input.currencyCode,
      effectiveFrom: startsAt, operation: 'DEFINE', productRef: proof.productRef,
      unitBasis: { quantity: '1', unitRef: input.unitRef }, variantRef: proof.variantRef,
    }],
  };
  validatePayload(SymmyPriceListPricesBatchRequestSchema, priceBody, 'list-price-import');
  const key = `${proof.names.prefix}.list-price`;
  const original = await client.settle(await client.write(
    `${PREFIX}/price-lists/prices/batch`, priceBody, key, 'list-price-import',
  ), PRICE_EFFECTS, 'list-price-import');
  const readback = await findList('list-price-readback');
  ensure(
    readback.prices !== undefined && readback.prices.count === 1 && readback.prices.prices.length === 1,
    'list-price-readback', 'readback',
  );
  const stored = decode(CurrentPriceSchema, readback.prices.prices[0]?.price, 'list-price-readback');
  const identity = stored.definition.identityKey;
  ensure(
    isDeepStrictEqual(identity.catalogSelection, { productRef: proof.productRef, variantRef: proof.variantRef }) &&
    identity.priceGroupSelector.priceGroupRef.resourceId === list.priceGroupRef.resourceId &&
    identity.commercialScope.channelId === input.commercialScope.channelId &&
    identity.commercialScope.marketId === input.commercialScope.marketId &&
    isDeepStrictEqual(identity.unitBasis, { quantity: '1', unitRef: input.unitRef }) &&
    decimalEqual(stored.definition.revision.monetaryAmount.amount, proof.listAmount) &&
    stored.definition.revision.monetaryAmount.currencyCode === input.currencyCode &&
    stored.definition.revision.effectiveFrom === startsAt,
    'list-price-readback', 'readback',
  );
  const replay = await client.settle(await client.write(
    `${PREFIX}/price-lists/prices/batch`, priceBody, key, 'list-price-import',
  ), PRICE_EFFECTS, 'list-price-import');
  assertReplayIdentity(original, replay, 'list-price-import');
  const after = await findList('list-price-readback');
  ensure(
    after.prices !== undefined && after.prices.count === 1 && after.prices.prices.length === 1 &&
    isDeepStrictEqual(after.priceGroupRef, readback.priceGroupRef) &&
    isDeepStrictEqual(decode(CurrentPriceSchema, after.prices.prices[0]?.price, 'list-price-readback'), stored),
    'list-price-readback', 'readback',
  );
  return { ...proof, priceGroupRef: list.priceGroupRef };
}

/** Exact decimal comparison without binary floating point or accepting malformed decimal inputs. */
export function decimalEqual(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown) => {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return undefined;
    return value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value;
  };
  const a = canonical(left);
  return a !== undefined && a === canonical(right);
}

/**
 * Explicit adapter contract for worker endpoints not present in the original public Symmy surface.
 * The parent supplies documented paths and JSON pointers, not a boolean "passed" callback.
 * Each read must contain exactly one record matching ALL proof-owned expected fields.
 * `recordsPointer: ''` accepts a single root object or root array.
 */
export interface SymmyRecordRead<Field extends string> {
  readonly path: string;
  readonly recordsPointer: string;
  readonly fields: Readonly<Record<Field, string>>;
}
function atPointer(value: unknown, pointer: string, boundary: ProofBoundary): unknown {
  ensure(pointer === '' || /^\/(?:[^~]|~[01])*$/u.test(pointer), boundary, 'input-contract');
  let current = value;
  for (const part of pointer === '' ? [] : pointer.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    ensure(
      typeof current === 'object' && current !== null && Object.hasOwn(current, key),
      boundary, 'readback',
    );
    current = Reflect.get(current, key);
  }
  return current;
}
/** Pure assertion helper. Never includes the failed value/pointer in an exception. */
export function assertRecordReadback<Field extends string>(
  response: unknown,
  read: Pick<SymmyRecordRead<Field>, 'recordsPointer' | 'fields'>,
  expected: Readonly<Record<Field, unknown>>,
  boundary: ProofBoundary,
  decimalFields: readonly Field[] = [],
): void {
  const selected = atPointer(response, read.recordsPointer, boundary);
  const rows: readonly unknown[] = Array.isArray(selected) ? selected : [selected];
  const entries = Object.entries(expected);
  ensure(entries.length > 0, boundary, 'input-contract');
  const decimalNames = new Set<string>(decimalFields);
  let matches = 0;
  for (const row of rows) {
    let match = true;
    for (const [field, value] of entries) {
      const pointer: unknown = Reflect.get(read.fields, field);
      ensure(typeof pointer === 'string', boundary, 'input-contract');
      const observed = atPointer(row, pointer, boundary);
      if (!(decimalNames.has(field) ? decimalEqual(observed, value) : isDeepStrictEqual(observed, value))) match = false;
    }
    if (match) matches += 1;
  }
  ensure(matches === 1, boundary, 'readback');
}
const CustomerPageSchema = Schema.Struct({
  count: Schema.Int,
  customers: Schema.Array(Schema.Struct({
    sourceRecordId: text,
    partyRef: RefSchema,
    profile: Schema.Struct({ profileRef: Schema.Struct({
      ...RefSchema.fields, kind: Schema.Literals(['RETAIL', 'COUNTERPARTY']),
    }), subject: Schema.Union([
      Schema.Struct({ kind: Schema.Literal('RETAIL'), partyRef: RefSchema, sellingLegalEntityRef: RefSchema }),
      Schema.Struct({
        kind: Schema.Literal('COUNTERPARTY'), counterpartyRef: RefSchema,
        sellingLegalEntityRef: Schema.optionalKey(RefSchema),
      }),
    ]) }),
    party: Schema.Struct({
      outcome: Schema.Literal('AVAILABLE'),
      partyType: Schema.Literals(['PERSON', 'ORGANIZATION']),
      businessName: Schema.NullOr(Schema.String),
      firstName: Schema.NullOr(Schema.String),
      lastName: Schema.NullOr(Schema.String),
      contactPoints: Schema.Array(Schema.Struct({ type: text, normalizedValue: text })),
    }),
  })),
});
export interface SymmyCustomerProof {
  readonly customerId: string;
  readonly partyRef: ProofRef;
  readonly profileId: string;
  readonly profileRef: ProofRef;
  readonly subject: typeof CustomerPageSchema.Type.customers[number]['profile']['subject'];
  readonly kind: 'PERSON' | 'ORGANIZATION';
}
export interface SymmyCustomerFixture {
  readonly label: string;
  readonly postalAddress: {
    readonly addressLine1: string; readonly city: string; readonly postalCode: string; readonly countryCode: string;
  };
  readonly purposes: readonly ['BILLING', 'DELIVERY'];
}
export interface SymmyFullProofContext {
  readonly names: SymmyProofNames;
  readonly customers: readonly [SymmyCustomerProof, SymmyCustomerProof];
  readonly address: SymmyCustomerFixture;
}
export interface SymmyOrderExportWiring {
  readonly collectionPath: string;
  readonly detailPath: (id: string) => string;
  readonly expectedOrderIds: readonly [string, ...string[]];
}
const CUSTOMER_EFFECTS = {
  effectsAtLeast: 11, itemsAtLeast: 8, owners: { 'party.registry': 7, 'commerce.customer-context': 4 },
} satisfies EffectExpectation;
async function proveCustomers(
  config: SymmyProofConfig, client: SymmyProofClient, names: SymmyProofNames,
): Promise<SymmyFullProofContext> {
  const proof = { names };
  const address: SymmyCustomerFixture = {
    label: `${proof.names.prefix}_ADDRESS`,
    postalAddress: {
      addressLine1: 'Acceptance fixture 1', city: 'Test City', postalCode: '11000', countryCode: 'CZ',
    },
    purposes: ['BILLING', 'DELIVERY'],
  };
  const contacts = (id: string) => [
    { preferred: true, type: 'EMAIL', value: `${id.toLowerCase()}@example.invalid` },
    // NANP 202-555-0100..0199 is reserved for fictional use; no message/call is sent.
    { preferred: false, type: 'PHONE', value: '+12025550123' },
  ];
  const body = { customers: [
    {
      addresses: [address], businessName: proof.names.organization, contacts: contacts(proof.names.organization),
      customerId: proof.names.organization, kind: 'ORGANIZATION',
    },
    {
      addresses: [address], contacts: contacts(proof.names.person), customerId: proof.names.person,
      firstName: proof.names.prefix, kind: 'PERSON', lastName: 'Acceptance',
    },
  ] };
  validatePayload(SymmyCustomersBatchRequestSchema, body, 'customer-import');
  const key = `${proof.names.prefix}.customers`;
  const original = await client.settle(await client.write(
    `${PREFIX}/customers/batch`, body, key, 'customer-import',
  ), CUSTOMER_EFFECTS, 'customer-import');
  const read = async () => decode(CustomerPageSchema, await client.read(
    `${PREFIX}/admin/customers?q=${encodeURIComponent(proof.names.prefix)}&limit=100`, 'customer-readback',
  ), 'customer-readback');
  const page = await read();
  ensure(page.count === 2 && page.customers.length === 2, 'customer-readback', 'readback');
  const customer = (id: string, kind: 'PERSON' | 'ORGANIZATION'): SymmyCustomerProof => {
    const matches = page.customers.filter((item) => item.sourceRecordId === id);
    const [item] = matches;
    ensure(matches.length === 1 && item !== undefined, 'customer-readback', 'readback');
    ensure(
      item.party.partyType === kind && item.partyRef.tenantId === config.input.unitRef.tenantId &&
      item.profile.profileRef.kind === (kind === 'PERSON' ? 'RETAIL' : 'COUNTERPARTY') &&
      (kind === 'ORGANIZATION'
        ? item.party.businessName === proof.names.organization
        : item.party.firstName === proof.names.prefix && item.party.lastName === 'Acceptance'),
      'customer-readback', 'readback',
    );
    for (const contact of contacts(id)) {
      ensure(item.party.contactPoints.filter(
        (point) => point.type === contact.type && point.normalizedValue === contact.value,
      ).length === 1, 'customer-readback', 'readback');
    }
    const { kind: _profileKind, ...profileRef } = item.profile.profileRef;
    return {
      customerId: id, kind, partyRef: item.partyRef, profileId: profileRef.resourceId,
      profileRef, subject: item.profile.subject,
    };
  };
  const customers: SymmyFullProofContext['customers'] = [
    customer(proof.names.organization, 'ORGANIZATION'), customer(proof.names.person, 'PERSON'),
  ];
  const replay = await client.settle(await client.write(
    `${PREFIX}/customers/batch`, body, key, 'customer-replay',
  ), CUSTOMER_EFFECTS, 'customer-replay');
  assertReplayIdentity(original, replay, 'customer-replay');
  ensure(isDeepStrictEqual(page, await read()), 'customer-replay', 'readback');
  return { names, address, customers };
}
const orderFields = SymmyDemoOrderSchema.fields;
const lineFields = orderFields.lines.value.fields;
const OrderSchema = Schema.Struct({
  id: text, number: text, currencyCode: orderFields.currencyCode, pricesIncludeVat: orderFields.pricesIncludeVat,
  shipping: orderFields.shipping, totalMinor: orderFields.totalMinor, totalVatMinor: orderFields.totalVatMinor,
  totalNetMinor: orderFields.totalNetMinor,
  lines: Schema.NonEmptyArray(Schema.Struct({
    productId: text, sku: text, unitPriceMinor: lineFields.unitPriceMinor, vatRate: lineFields.vatRate,
    quantity: lineFields.quantity, totalMinor: lineFields.totalMinor, totalVatMinor: lineFields.totalVatMinor,
  })),
});
/** Pure check of persisted monetary snapshots; PII fields are deliberately not part of this decoder. */
export function assertOrderSnapshots(body: unknown): readonly typeof OrderSchema.Type[] {
  const orders = decode(Schema.Array(OrderSchema), body, 'order-export');
  ensure(orders.length > 0 && new Set(orders.map((order) => order.id)).size === orders.length, 'order-export', 'readback');
  for (const order of orders) {
    const totals = fullOrderTotals(order);
    ensure(
      order.totalMinor === totals.totalMinor && order.totalVatMinor === totals.totalVatMinor &&
      order.totalNetMinor === totals.totalMinor - totals.totalVatMinor &&
      order.lines.every((line) => {
        const gross = lineGrossMinor(line, order.pricesIncludeVat);
        const vat = order.pricesIncludeVat ? vatInGrossMinor(gross, line.vatRate) : orderLineVatMinor(line);
        return line.totalMinor === gross && line.totalVatMinor === vat;
      }),
      'order-export', 'readback',
    );
  }
  return orders;
}
export async function proveSymmyOrderExport(
  client: SymmyProofClient, wiring: SymmyOrderExportWiring,
): Promise<void> {
  ensure(
    wiring.expectedOrderIds.length > 0 &&
    wiring.expectedOrderIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 300),
    'order-export', 'input-contract',
  );
  const page = decode(Schema.Struct({ orders: Schema.Array(Schema.Unknown) }),
    await client.read(wiring.collectionPath, 'order-export'), 'order-export');
  const orders = assertOrderSnapshots(page.orders);
  for (const id of wiring.expectedOrderIds) {
    const matches = orders.filter((order) => order.id === id);
    ensure(matches.length === 1, 'order-export', 'readback');
    const detail = decode(Schema.Struct({ order: Schema.Unknown }),
      await client.read(wiring.detailPath(id), 'order-export'), 'order-export');
    const [order] = assertOrderSnapshots([detail.order]);
    ensure(isDeepStrictEqual(matches[0], order), 'order-export', 'readback');
  }
}

const PNG_ONE_PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const slugOf = (name: string) => name.toLowerCase().replaceAll('_', '-');
/** The real public demo contracts use native IDs and a revision fence, never engineered Catalog refs. */
export function symmyNativeCategoryPayload(names: SymmyProofNames, expectedRevision: number) {
  return {
    categories: [{ code: names.category, name: names.category, published: true, slug: slugOf(names.category) }],
    expectedRevision,
  };
}
export function symmyNativeProductPayload(names: SymmyProofNames, expectedRevision: number) {
  return {
    expectedRevision,
    products: [{
      active: true, category: names.category, categoryCode: names.category,
      description: `${names.prefix} scoped HTTP acceptance product`,
      lowStockThreshold: 0, name: names.product, priceMinor: 12345, published: true,
      sku: names.variant, slug: slugOf(names.product), stockTracked: false,
      taxClassificationCode: 'cz.vat.standard', unit: 'ks',
    }],
  };
}
export function symmyNativeMediaPayload(names: SymmyProofNames, productId: string, expectedRevision: number) {
  return {
    expectedRevision,
    image: { filename: `${names.image}.png`, full: { contentBase64: PNG_ONE_PIXEL, height: 1, width: 1 } },
    productId,
  };
}
export function assertNativeApplied(
  body: unknown,
  expected: { readonly tenantId: string; readonly legalEntityId: string; readonly previousRevision: number },
  boundary: ProofBoundary,
) {
  const result = decode(SymmyDemoCatalogBatchResponseSchema, body, boundary);
  const [item] = result.items;
  ensure(
    result.ownerModuleId === 'demo.merchandise' && result.tenantId === expected.tenantId &&
    result.legalEntityId === expected.legalEntityId && result.items.length === 1 &&
    item !== undefined && item.index === 0 && item.outcome === 'APPLIED' &&
    item.revision === result.revision && result.revision > expected.previousRevision,
    boundary, 'readback',
  );
  return { item, revision: result.revision };
}
const NativeCatalogReadSchema = Schema.Struct({
  categories: Schema.Array(Schema.Struct({ id: text, name: text, slug: text })),
  products: Schema.Array(Schema.Struct({
    active: Schema.Boolean, categoryId: text, currentPriceMinor: Schema.Int,
    id: text, images: Schema.optionalKey(Schema.Array(text)), name: text,
    published: Schema.Boolean, sku: text,
  })),
  revision: Schema.Int,
});
export async function proveNativeCatalog(
  config: SymmyProofConfig, client: SymmyProofClient, names: SymmyProofNames,
): Promise<SymmyNativeProofResult> {
  const tenantId = config.input.unitRef.tenantId;
  const legalEntityId = config.legalEntityId ?? STAGE_LEGAL_ENTITY;
  const initial = decode(SymmyDemoCatalogRevisionResponseSchema,
    await client.read(`${PREFIX}/catalog/revision`, 'category-import'), 'category-import');
  ensure(initial.tenantId === tenantId && initial.legalEntityId === legalEntityId, 'category-import', 'readback');
  const categoryBody = symmyNativeCategoryPayload(names, initial.revision);
  validatePayload(SymmyDemoCategoriesBatchRequestSchema, categoryBody, 'category-import');
  const categoryResult = await client.write(
    `${PREFIX}/categories/batch`, categoryBody, `${names.prefix}.native-category`, 'category-import',
  );
  ensure(categoryResult.status === 200, 'category-import', 'http-status');
  const category = assertNativeApplied(categoryResult.body, {
    tenantId, legalEntityId, previousRevision: initial.revision,
  }, 'category-import');
  const productBody = symmyNativeProductPayload(names, category.revision);
  validatePayload(SymmyDemoProductsBatchRequestSchema, productBody, 'product-import');
  const productResult = await client.write(
    `${PREFIX}/catalog/products/batch`, productBody, `${names.prefix}.native-product`, 'product-import',
  );
  ensure(productResult.status === 200, 'product-import', 'http-status');
  const product = assertNativeApplied(productResult.body, {
    tenantId, legalEntityId, previousRevision: category.revision,
  }, 'product-import');
  const mediaBody = symmyNativeMediaPayload(names, product.item.entityId, product.revision);
  validatePayload(SymmyDemoMediaUploadRequestSchema, mediaBody, 'image-import');
  const mediaResult = await client.write(
    `${PREFIX}/products/media`, mediaBody, `${names.prefix}.native-media`, 'image-import',
  );
  ensure(mediaResult.status === 200, 'image-import', 'http-status');
  const media = assertNativeApplied(mediaResult.body, {
    tenantId, legalEntityId, previousRevision: product.revision,
  }, 'image-import');
  ensure(
    media.item.entityId === product.item.entityId && media.item.image !== undefined &&
    /^media:[0-9a-f-]{36}$/u.test(media.item.image),
    'image-import', 'readback',
  );
  const state = decode(NativeCatalogReadSchema, await client.ownerRead('merchandise/records', {
    view: { includeCategories: true, limit: 1, ordersLimit: 0, productIds: [product.item.entityId] },
  }, 'image-readback'), 'image-readback');
  const [stored] = state.products;
  ensure(state.products.length === 1 && stored !== undefined, 'product-readback', 'readback');
  ensure(
    stored.id === product.item.entityId && stored.name === names.product && stored.sku === names.variant &&
    stored.currentPriceMinor === 12345 && stored.active && stored.published &&
    stored.categoryId === category.item.entityId && state.revision >= media.revision,
    'product-readback', 'readback',
  );
  ensure(state.categories.filter((entry) =>
    entry.id === category.item.entityId && entry.name === names.category && entry.slug === slugOf(names.category),
  ).length === 1, 'category-readback', 'readback');
  ensure(stored.images?.filter((image) => image === media.item.image).length === 1, 'image-readback', 'readback');
  return {
    sku: names.variant, productId: stored.id, slug: slugOf(names.product),
    categoryId: category.item.entityId, categorySlug: slugOf(names.category),
    imageId: media.item.image.slice('media:'.length),
  };
}
async function proveOwnerStock(
  config: SymmyProofConfig, client: SymmyProofClient, context: SymmyCommerceProof,
): Promise<void> {
  const source = decode(SymmyProofStockSourceSchema, config.stockSource ?? AKROS_STAGE_STOCK_SOURCE, 'configuration');
  const resolution = decode(SourceStockPositionResolutionResponseSchema, await client.ownerRead(
    'inventory/source-stock-position-resolution',
    { ...source, itemKey: context.names.variant, locationKey: config.input.locationKey },
    'stock-readback',
  ), 'stock-readback');
  ensure(resolution._tag === 'RESOLVED', 'stock-readback', 'readback');
  const { evidence } = decode(CurrentStockEvidenceForAvailabilityResponseSchema, await client.ownerRead(
    'inventory/current-stock-evidence-for-availability', { positionRef: resolution.positionRef }, 'stock-readback',
  ), 'stock-readback');
  const onHand = evidence.position.onHand;
  const sourceEvidence = evidence.sourceEvidence;
  ensure(
    evidence.position.lifecycle === 'CURRENT' &&
    isDeepStrictEqual(evidence.position.ref, resolution.positionRef) &&
    isDeepStrictEqual(evidence.binding.catalogSelection, {
      productRef: context.productRef, variantRef: context.variantRef,
    }) &&
    isDeepStrictEqual(evidence.position.scope.stockLocationRef, resolution.stockLocationRef) &&
    isDeepStrictEqual(evidence.position.scope.stockItemRef, resolution.stockItemRef) &&
    onHand._tag === 'CURRENT' && decimalEqual(onHand.quantity.amount, context.stockAmount) &&
    isDeepStrictEqual(onHand.quantity.unitRef, config.input.unitRef) &&
    sourceEvidence._tag === 'EXTERNAL_SOURCE_ASSERTION' && sourceEvidence.evaluation._tag === 'DETERMINATE' &&
    decimalEqual(sourceEvidence.evaluation.postEffectOnHand.amount, context.stockAmount),
    'stock-readback', 'readback',
  );
}
async function proveOwnerAddresses(client: SymmyProofClient, context: SymmyFullProofContext): Promise<void> {
  for (const customer of context.customers) {
    const profile = customer.subject.kind === 'COUNTERPARTY'
      ? { kind: 'COUNTERPARTY', counterpartyRef: customer.subject.counterpartyRef, profileRef: customer.profileRef }
      : { kind: 'RETAIL', profileRef: customer.profileRef };
    const { addresses } = decode(SavedAddressListResponseSchema, await client.ownerRead(
      'commerce-customer-context/saved-address-list', { profile }, 'address-readback',
    ), 'address-readback');
    const [address] = addresses;
    ensure(
      addresses.length === 1 && address !== undefined && address.label === context.address.label &&
      address.lifecycle === 'ACTIVE' && address.origin.kind === 'COMMERCE_ONLY' &&
      isDeepStrictEqual(address.origin.postalAddress, context.address.postalAddress) &&
      isDeepStrictEqual(address.purposes.toSorted(), [...context.address.purposes].toSorted()) &&
      isDeepStrictEqual(address.profile.profileRef, customer.profileRef),
      'address-readback', 'readback',
    );
  }
}
async function proveOwnerGroups(client: SymmyProofClient, context: SymmyFullProofContext): Promise<void> {
  const groupBody = { customerGroups: [{
    businessCode: context.names.group, code: context.names.group, name: context.names.group,
    description: `${context.names.prefix} acceptance group`, meaningKey: `${context.names.prefix}.customers`,
    membershipCriteria: 'Explicit ERP assignment of scoped acceptance customers',
    purpose: 'Scoped Symmy HTTP acceptance group',
  }] };
  validatePayload(SymmyCustomerGroupsBatchRequestSchema, groupBody, 'group-import');
  const groupExpected = { effectsAtLeast: 1, itemsAtLeast: 1, owners: { 'commerce.customer-context': 1 } };
  const groupKey = `${context.names.prefix}.group`;
  const group = await client.settle(await client.write(
    `${PREFIX}/customer-groups/batch`, groupBody, groupKey, 'group-import',
  ), groupExpected, 'group-import');
  const groupReplay = await client.settle(await client.write(
    `${PREFIX}/customer-groups/batch`, groupBody, groupKey, 'group-replay',
  ), groupExpected, 'group-replay');
  assertReplayIdentity(group, groupReplay, 'group-replay');
  const path = `${PREFIX}/customer-groups/${encodeURIComponent(context.names.group)}/customers/batch`;
  const body = { customers: context.customers.map(({ customerId }) => ({ customerId })) };
  validatePayload(SymmyGroupCustomersBatchRequestSchema, body, 'group-assignment');
  const expected = { effectsAtLeast: 2, itemsAtLeast: 2, owners: { 'commerce.customer-context': 2 } };
  const key = `${context.names.prefix}.assignment`;
  const original = await client.settle(await client.write(path, body, key, 'group-assignment'), expected, 'group-assignment');
  const readMemberships = async () => {
    const identities = [];
    for (const customer of context.customers) {
      const profile = {
        profileKind: customer.kind === 'PERSON' ? 'RETAIL' : 'COUNTERPARTY', profileRef: customer.profileRef,
      };
      const response = decode(EffectiveCustomerGroupMembershipsResponseSchema, await client.ownerRead(
        'commerce-customer-context/effective-customer-group-memberships',
        { asOf: new Date().toISOString(), profile }, 'group-readback',
      ), 'group-readback');
      const [membership] = response.items;
      ensure(
        response.items.length === 1 && membership !== undefined && membership.state === 'VALID' &&
        isDeepStrictEqual(membership.profile.profileRef, customer.profileRef),
        'group-readback', 'readback',
      );
      const { group: stored } = decode(CustomerGroupDetailResponseSchema, await client.ownerRead(
        'commerce-customer-context/customer-group-detail', { groupRef: membership.groupRef }, 'group-readback',
      ), 'group-readback');
      ensure(
        stored.businessCode === context.names.group && stored.currentDefinition.name === context.names.group &&
        stored.currentState === 'ACTIVE',
        'group-readback', 'readback',
      );
      identities.push({ membershipRef: membership.membershipRef, profileRef: customer.profileRef, groupRef: stored.groupRef });
    }
    return identities;
  };
  const before = await readMemberships();
  const replay = await client.settle(await client.write(path, body, key, 'group-replay'), expected, 'group-replay');
  assertReplayIdentity(original, replay, 'group-replay');
  ensure(isDeepStrictEqual(before, await readMemberships()), 'group-replay', 'readback');
  await client.settle(await client.write(path, body, `${key}.source-replay`, 'group-replay'), expected, 'group-replay');
  ensure(isDeepStrictEqual(before, await readMemberships()), 'group-replay', 'readback');
}
export interface SymmyStageProofOptions {
  /** Optional known existing order IDs; otherwise prove up to three actual IDs returned by the public list. */
  readonly expectedOrderIds?: readonly string[];
}
export type SymmyProofLaneName = 'commerce' | 'customers' | 'native-catalog' | 'orders';
export interface SymmyNativeProofResult {
  readonly sku: string;
  readonly productId: string;
  readonly slug: string;
  readonly categoryId: string;
  readonly categorySlug: string;
  readonly imageId: string;
}
export function symmyNativeResultLine(result: SymmyNativeProofResult): string {
  const safe = {
    sku: result.sku, productId: result.productId, slug: result.slug,
    categoryId: result.categoryId, categorySlug: result.categorySlug, imageId: result.imageId,
  };
  ensure(Object.values(safe).every((value) => /^[A-Za-z0-9._:-]{1,300}$/u.test(value)),
    'image-readback', 'readback');
  return `RESULT native-catalog ${JSON.stringify(safe)}`;
}
/** Starts every disjoint lane, reports each settlement, and never rejects while another lane is still running. */
export async function runSymmyProofLanes(
  lanes: readonly { readonly name: SymmyProofLaneName; readonly run: () => Promise<void> }[],
  report: (line: string) => void,
): Promise<void> {
  const settled = await Promise.allSettled(lanes.map(async (lane) => {
    try {
      await lane.run();
      report(`PASS lane:${lane.name}`);
    } catch (error) {
      report(`FAIL lane:${lane.name} ${symmyProofFailureLine(error)}`);
      throw error;
    }
  }));
  const failed = lanes.filter((_lane, index) => settled[index]?.status === 'rejected').map((lane) => lane.name);
  if (failed.length > 0) throw new SymmyProofFailure('full-proof', 'lane-failed', undefined, { kind: 'lanes', failed });
}
/** Complete executable stage proof: all writes use public Symmy bodies, all extra owner calls are registered Reads. */
export async function proveSymmyFullFunction(
  config: SymmyProofConfig,
  options: SymmyStageProofOptions = {},
  pass: (boundary: ProofBoundary) => void = (boundary) => { process.stdout.write(`PASS ${boundary}\n`); },
  report: (line: string) => void = (line) => { process.stdout.write(`${line}\n`); },
): Promise<void> {
  decode(SymmyProofInputSchema, config.input, 'configuration');
  decode(SymmyProofStockSourceSchema, config.stockSource ?? AKROS_STAGE_STOCK_SOURCE, 'configuration');
  const client = createSymmyProofClient(config);
  ensure(Redacted.isRedacted(config.operatorCookie), 'configuration', 'read-auth-required');
  // Verify the new endpoints, existing orders and staff read permission before the first test write.
  decode(SymmyDemoCatalogRevisionResponseSchema,
    await client.read(`${PREFIX}/catalog/revision`, 'category-import'), 'category-import');
  const orderPage = decode(Schema.Struct({ orders: Schema.Array(Schema.Unknown) }),
    await client.read(`${PREFIX}/orders?limit=100&offset=0`, 'order-export'), 'order-export');
  const actualOrders = assertOrderSnapshots(orderPage.orders);
  const ids = options.expectedOrderIds ?? actualOrders.slice(0, 3).map((order) => order.id);
  const [first, ...rest] = ids;
  ensure(first !== undefined, 'order-export', 'readback');
  const orderWiring: SymmyOrderExportWiring = {
    collectionPath: `${PREFIX}/orders?limit=100&offset=0`,
    detailPath: (id) => `${PREFIX}/orders/${encodeURIComponent(id)}`, expectedOrderIds: [first, ...rest],
  };
  await client.ownerRead('merchandise/records', {
    view: { limit: 0, ordersLimit: 0, summary: true },
  }, 'category-readback');
  await runSymmyProofLanes([
    { name: 'commerce', run: async () => {
        const commerce = await proveSymmyProductStockList(config, client);
        report(`RESULT commerce ${JSON.stringify({ sku: commerce.names.variant })}`);
        pass('product-replay');
        pass('list-price-readback');
        const sku = decode(SkuLookupResponseSchema, await client.ownerRead(
          'catalog/sku-lookup', { code: commerce.names.variant }, 'sku-readback',
        ), 'sku-readback');
        ensure(
          sku._tag === 'found' && sku.state === 'CURRENT' && sku.displayCode === commerce.names.variant &&
          sku.target.kind === 'VARIANT' && sku.target.variantId === commerce.variantRef.resourceId &&
          sku.target.tenantId === commerce.variantRef.tenantId,
          'sku-readback', 'readback',
        );
        pass('sku-readback');
        await proveOwnerStock(config, client, commerce);
        pass('stock-readback');
        // Catalog page pricing evaluates the owner's current instant; do not mistake a scheduled future Price for absence.
        await client.waitUntil(commerce.effectiveFrom, 'base-price-readback');
        const prices = decode(CatalogPagePricesResponseSchema, await client.ownerRead('pricing/catalog-page-prices', {
          ...config.input.commercialScope, currencyCode: config.input.currencyCode,
          items: [{
            catalogSelection: { productRef: commerce.productRef, variantRef: commerce.variantRef },
            unitBasis: { quantity: '1', unitRef: config.input.unitRef },
          }],
        }, 'base-price-readback'), 'base-price-readback');
        ensure(prices._tag === 'CATALOG_PAGE_PRICED' && prices.prices.length === 1, 'base-price-readback', 'readback');
        const [price] = prices.prices;
        ensure(
          price?._tag === 'PRICE_FOUND' && price.priceGroupSelector.kind === 'NO_GROUP' &&
          decimalEqual(price.priceRevision.monetaryAmount.amount, commerce.baseAmount) &&
          price.priceRevision.monetaryAmount.currencyCode === config.input.currencyCode &&
          isDeepStrictEqual(price.catalogSelection, { productRef: commerce.productRef, variantRef: commerce.variantRef }),
          'base-price-readback', 'readback',
        );
        pass('base-price-readback');
    } },
    { name: 'customers', run: async () => {
      const context = await proveCustomers(config, client, makeSymmyProofNames());
      pass('customer-replay');
      await proveOwnerAddresses(client, context);
      pass('address-readback');
      await proveOwnerGroups(client, context);
      pass('group-replay');
    } },
    { name: 'native-catalog', run: async () => {
      const result = await proveNativeCatalog(config, client, makeSymmyProofNames());
      const line = symmyNativeResultLine(result);
      ensure(!line.includes(Redacted.value(config.apiKey)) &&
        (config.operatorCookie === undefined || !line.includes(Redacted.value(config.operatorCookie))),
        'image-readback', 'readback');
      report(line);
      pass('category-readback');
      pass('image-readback');
    } },
    { name: 'orders', run: async () => {
      await proveSymmyOrderExport(client, orderWiring);
      pass('order-export');
    } },
  ], report);
  pass('full-proof');
}

const OPERATOR_SESSION_PATH = '/shell-super-app-api/auth/session';
const OPERATOR_COMPOSITION_PATH = '/shell-super-app-api/shell/composition';
const OPERATOR_GATEWAY_PATH = '/shell-super-app-api/auth/gateway-context';
const STAGE_LEGAL_ENTITY = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
const OWNER_READS = {
  'catalog/sku-lookup': { audience: 'catalog', readName: 'sku-lookup', request: SkuLookupRequestSchema },
  'pricing/catalog-page-prices': {
    audience: 'pricing', readName: 'catalog-page-prices', request: CatalogPagePricesRequestSchema,
  },
  'inventory/source-stock-position-resolution': {
    audience: 'inventory', readName: 'source-stock-position-resolution', request: SourceStockPositionResolutionRequestSchema,
  },
  'inventory/current-stock-evidence-for-availability': {
    audience: 'inventory', readName: 'current-stock-evidence-for-availability',
    request: CurrentStockEvidenceForAvailabilityRequestSchema,
  },
  'commerce-customer-context/saved-address-list': {
    audience: 'commerce-customer-context', readName: 'saved-address-list', request: SavedAddressListRequestSchema,
  },
  'commerce-customer-context/effective-customer-group-memberships': {
    audience: 'commerce-customer-context', readName: 'effective-customer-group-memberships',
    request: EffectiveCustomerGroupMembershipsRequestSchema,
  },
  'commerce-customer-context/customer-group-detail': {
    audience: 'commerce-customer-context', readName: 'customer-group-detail', request: CustomerGroupDetailRequestSchema,
  },
  'merchandise/records': { audience: 'merchandise', readName: 'records', request: RecordsRequestSchema },
};
export type SymmyOwnerRead = keyof typeof OWNER_READS;
/** Pure plan for registered owner Reads. The operator gateway, not the proof, admits operation scope. */
export function symmyOwnerReadEnvelope(
  operation: SymmyOwnerRead, query: unknown, legalEntityId: string, boundary: ProofBoundary,
) {
  ensure(Object.hasOwn(OWNER_READS, operation), boundary, 'input-contract');
  const read = OWNER_READS[operation];
  validatePayload(read.request, query, boundary);
  decode(uuid, legalEntityId, 'configuration');
  return {
    audience: read.audience,
    ...(operation === 'inventory/source-stock-position-resolution' ? {} : { legalEntityId }),
    readName: read.readName,
    query,
  };
}
type HttpResult = { readonly status: number; readonly body: unknown };
export interface SymmyProofClient {
  read(path: string, boundary: ProofBoundary): Promise<unknown>;
  ownerRead(operation: SymmyOwnerRead, query: unknown, boundary: ProofBoundary): Promise<unknown>;
  waitUntil(instant: string, boundary: ProofBoundary): Promise<void>;
  write(path: string, body: unknown, key: string, boundary: ProofBoundary): Promise<HttpResult>;
  settle(result: HttpResult, expected: EffectExpectation, boundary: ProofBoundary): Promise<Items>;
}
function checkedOrigin(origin: string): URL {
  try {
    const url = new URL(origin);
    ensure(
      url.protocol === 'https:' && url.username === '' && url.password === '' &&
      url.pathname === '/' && url.search === '' && url.hash === '',
      'configuration', 'input-contract',
    );
    return url;
  } catch {
    throw new SymmyProofFailure('configuration', 'input-contract');
  }
}
function checkedPath(path: string, origin: URL, boundary: ProofBoundary): URL {
  try {
    const url = new URL(path, origin);
    ensure(
      path.startsWith(`${PREFIX}/`) && url.origin === origin.origin && url.hash === '' &&
      url.pathname.startsWith(`${PREFIX}/`) && !url.pathname.includes('//'),
      boundary, 'unsafe-path',
    );
    return url;
  } catch {
    throw new SymmyProofFailure(boundary, 'unsafe-path');
  }
}
export function createSymmyProofClient(config: SymmyProofConfig): SymmyProofClient {
  const origin = checkedOrigin(config.origin);
  const budget = config.timeoutMs ?? 600_000;
  const pollMs = config.pollMs ?? 1000;
  ensure(
    Number.isInteger(budget) && budget >= 1000 && budget <= 900_000 &&
    Number.isInteger(pollMs) && pollMs >= 10 && pollMs <= 10_000 &&
    Redacted.isRedacted(config.apiKey) && Redacted.value(config.apiKey).trim().length > 0,
    'configuration', 'input-contract',
  );
  const deadline = Date.now() + budget;
  const remaining = (boundary: ProofBoundary) => {
    const ms = deadline - Date.now();
    ensure(ms > 0, boundary, 'timeout');
    return ms;
  };
  type Authentication =
    | { readonly kind: 'symmy' }
    | { readonly kind: 'operator' }
    | { readonly kind: 'owner'; readonly token: Redacted.Redacted<string>; readonly revision: string };
  const request = async (
    path: string, method: 'GET' | 'POST', body: unknown, key: string | undefined, boundary: ProofBoundary,
    authentication: Authentication = { kind: 'symmy' },
  ): Promise<HttpResult> => {
    let url: URL;
    if (authentication.kind === 'symmy') {
      url = checkedPath(path, origin, boundary);
    } else {
      ensure(path.startsWith('/') && !path.startsWith('//') && !path.includes('?') && !path.includes('#'),
        boundary, 'unsafe-path');
      url = new URL(path, origin);
      ensure(url.origin === origin.origin && !url.username && !url.password, boundary, 'unsafe-path');
      if (authentication.kind === 'operator') {
        ensure(
          (method === 'GET' && [OPERATOR_SESSION_PATH, OPERATOR_COMPOSITION_PATH].includes(path)) ||
          (method === 'POST' && path === OPERATOR_GATEWAY_PATH),
          boundary, 'unsafe-path',
        );
      } else {
        ensure(
          method === 'POST' && /^\/shell-super-app-api\/module-api\/[^?#]+\/reads\/[A-Za-z0-9._-]+$/u.test(path),
          boundary, 'unsafe-path',
        );
      }
    }
    let authenticationHeaders: Record<string, string>;
    const secrets = [config.apiKey];
    if (config.operatorCookie !== undefined) secrets.push(config.operatorCookie);
    if (authentication.kind === 'symmy') {
      authenticationHeaders = { 'x-api-key': Redacted.value(config.apiKey) };
    } else if (authentication.kind === 'operator') {
      ensure(config.operatorCookie !== undefined, boundary, 'read-auth-required');
      authenticationHeaders = { cookie: Redacted.value(config.operatorCookie), origin: origin.origin };
    } else {
      secrets.push(authentication.token);
      authenticationHeaders = {
        authorization: `Bearer ${Redacted.value(authentication.token)}`,
        'x-ontos-composition-revision': authentication.revision,
        'x-correlation-id': randomUUID(),
      };
    }
    try {
      const encoded = method === 'POST' ? JSON.stringify(body) : undefined;
      if (method === 'POST') ensure(encoded !== undefined, boundary, 'input-contract');
      const response = await fetch(url, {
        ...(encoded === undefined ? {} : { body: encoded }),
        headers: {
          accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...(key === undefined ? {} : { 'idempotency-key': key }),
          ...authenticationHeaders,
        },
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(20_000, remaining(boundary))),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new SymmyProofFailure(boundary, 'redirect');
      }
      const success = [200, 202].includes(response.status);
      const failure = (safeBody: SymmySafeFailureBody) => new SymmyProofFailure(
        boundary,
        authentication.kind !== 'symmy' && response.status === 401 ? 'read-auth-expired' :
          authentication.kind !== 'symmy' && response.status === 403 ? 'read-permission' : 'http-status',
        response.status, safeBody,
      );
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body === null) {
        if (!success) throw failure({ kind: 'empty' });
        throw new SymmyProofFailure(boundary, 'schema', response.status);
      }
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        ensure(size <= MAX_RESPONSE_BYTES, boundary, 'response-too-large');
        chunks.push(chunk);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        if (!success) throw failure({ kind: 'non-json' });
        throw new SymmyProofFailure(boundary, 'schema', response.status);
      }
      if (!success) {
        // Scrub against every credential held by this run, including temporary owner assertions.
        let safe = sanitizeSymmyFailureBody(parsed, config.apiKey);
        for (const secret of secrets) {
          if (JSON.stringify(safe).includes(Redacted.value(secret))) safe = { kind: 'unrecognized-problem' };
        }
        throw failure(safe);
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      if (error instanceof SymmyProofFailure) throw error;
      throw new SymmyProofFailure(
        boundary,
        Date.now() >= deadline || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
          ? 'timeout' : 'network',
      );
    }
  };
  let operatorRevision: string | undefined;
  const operatorState = async (boundary: ProofBoundary) => {
    ensure(config.operatorCookie !== undefined, boundary, 'read-auth-required');
    if (operatorRevision !== undefined) return operatorRevision;
    const session = decode(Schema.Struct({
      identity: Schema.Struct({ tenantId: uuid, legalEntityId: uuid }),
      state: Schema.Literal('authenticated'),
    }), (await request(OPERATOR_SESSION_PATH, 'GET', undefined, undefined, boundary, { kind: 'operator' })).body, boundary);
    ensure(
      session.identity.tenantId === config.input.unitRef.tenantId &&
      session.identity.legalEntityId === (config.legalEntityId ?? STAGE_LEGAL_ENTITY),
      boundary, 'read-auth-scope',
    );
    const composition = decode(Schema.Struct({
      compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      state: Schema.Literal('available'),
    }), (await request(OPERATOR_COMPOSITION_PATH, 'GET', undefined, undefined, boundary, { kind: 'operator' })).body, boundary);
    operatorRevision = composition.compositionRevision;
    return operatorRevision;
  };
  const client: SymmyProofClient = {
    async read(path, boundary) {
      const result = await request(path, 'GET', undefined, undefined, boundary);
      ensure(result.status === 200, boundary, 'http-status');
      return result.body;
    },
    async ownerRead(operation, query, boundary) {
      const envelope = symmyOwnerReadEnvelope(operation, query, config.legalEntityId ?? STAGE_LEGAL_ENTITY, boundary);
      const { query: ownerQuery, readName, ...scope } = envelope;
      const compositionRevision = await operatorState(boundary);
      const gateway = decode(Schema.Struct({
        apiBaseUrl: Schema.String,
        compositionRevision: Schema.String,
        token: Schema.RedactedFromValue(Schema.NonEmptyString),
      }), (await request(OPERATOR_GATEWAY_PATH, 'POST', {
        ...scope, compositionRevision,
      }, undefined, boundary, { kind: 'operator' })).body, boundary);
      ensure(
        gateway.compositionRevision === compositionRevision &&
        gateway.apiBaseUrl.startsWith('/shell-super-app-api/module-api/') &&
        !/[?#\\]|\/\.\.?\/|%/u.test(gateway.apiBaseUrl),
        boundary, 'read-auth-scope',
      );
      const result = await request(`${gateway.apiBaseUrl}/reads/${readName}`, 'POST', ownerQuery, undefined, boundary, {
        kind: 'owner', token: gateway.token, revision: compositionRevision,
      });
      ensure(result.status === 200, boundary, 'http-status');
      return result.body;
    },
    async waitUntil(instant, boundary) {
      const target = Date.parse(instant);
      ensure(Number.isFinite(target), boundary, 'input-contract');
      while (Date.now() < target) await sleep(Math.min(target - Date.now(), remaining(boundary)));
      remaining(boundary);
    },
    write: (path, body, key, boundary) => {
      ensure(/^[A-Za-z0-9._-]{1,200}$/u.test(key), boundary, 'input-contract');
      return request(path, 'POST', body, key, boundary);
    },
    async settle(result, expected, boundary) {
      if (result.status === 200) return assertAcceptedEffects(result.body, expected, boundary);
      const admission = decode(AdmissionSchema, result.body, boundary);
      let lastJob: SymmySafeFailureBody | undefined;
      while (true) {
        if (Date.now() >= deadline) throw new SymmyProofFailure(boundary, 'timeout', 200, lastJob);
        const job = decode(JobSchema, await client.read(`${PREFIX}/jobs/${admission.jobId}`, boundary), boundary);
        ensure(job.jobId === admission.jobId, boundary, 'job-identity');
        if (job.status === 'completed_all') return assertAcceptedEffects(job, expected, boundary);
        const counts = effectDiagnostic(job.items ?? []);
        ensure(counts.kind === 'effects', boundary, 'unexpected');
        lastJob = { ...counts, kind: 'job', status: job.status };
        if (job.status === 'completed_partial' || job.status === 'completed_none') {
          throw new SymmyProofFailure(boundary, 'job-terminal', 200, lastJob);
        }
        await sleep(Math.min(pollMs, remaining(boundary)));
      }
    },
  };
  return client;
}
const PRODUCT_EFFECTS = {
  effectsAtLeast: 3, itemsAtLeast: 1, owners: { 'commerce.catalog': 2, 'commerce.pricing': 1 },
} satisfies EffectExpectation;
export async function proveSymmyProduct(
  config: SymmyProofConfig,
  client: SymmyProofClient = createSymmyProofClient(config),
): Promise<SymmyProductProof> {
  const names = makeSymmyProofNames();
  const input = decode(SymmyProofInputSchema, config.input, 'configuration');
  const path = `${PREFIX}/admin/products?q=${encodeURIComponent(names.prefix)}&limit=100`;
  const before = decode(ProductPageSchema, await client.read(path, 'product-unseen'), 'product-unseen');
  ensure(before.count === 0 && before.products.length === 0, 'product-unseen', 'not-unseen');
  const effectiveFrom = new Date(Date.now() + 120_000).toISOString();
  const baseAmount = '123.45';
  const body = {
    products: [{
      identifier: { type: 'erpId', value: names.product },
      lifecycle: 'ACTIVE',
      name: names.product,
      variants: [{
        identifier: { type: 'variantId', value: names.variant },
        sku: names.variant,
        prices: [{ amount: baseAmount, currencyCode: input.currencyCode, effectiveFrom }],
      }],
    }],
  };
  validatePayload(SymmyProductsBatchRequestSchema, body, 'product-import');
  const key = `${names.prefix}.product`;
  const original = await client.settle(
    await client.write(`${PREFIX}/products/batch`, body, key, 'product-import'),
    PRODUCT_EFFECTS, 'product-import',
  );
  const page = decode(ProductPageSchema, await client.read(path, 'product-readback'), 'product-readback');
  ensure(page.count === 1 && page.products.length === 1, 'product-readback', 'readback');
  const [product] = page.products;
  ensure(product !== undefined, 'product-readback', 'readback');
  ensure(
    product.sourceRecordId === `product:erpId:${names.product}` && product.product.name === names.product,
    'product-readback', 'readback',
  );
  const [source] = product.variantSources;
  ensure(
    product.variantSources.length === 1 && source?.sourceRecordId === `variant:variantId:${names.variant}`,
    'product-readback', 'readback',
  );
  const variant = product.product.variants.find((item) => item.variantId === source.variantId);
  ensure(variant !== undefined && product.product.variants.length === 1, 'product-readback', 'readback');
  const replay = await client.settle(
    await client.write(`${PREFIX}/products/batch`, body, key, 'product-replay'),
    PRODUCT_EFFECTS, 'product-replay',
  );
  assertReplayIdentity(original, replay, 'product-replay');
  const afterReplay = decode(ProductPageSchema, await client.read(path, 'product-replay'), 'product-replay');
  ensure(isDeepStrictEqual(page, afterReplay), 'product-replay', 'readback');
  return {
    baseAmount, effectiveFrom, names, productRef: product.product.productRef,
    variantRef: variant.variantRef, stockAmount: '17', listAmount: '98.76',
  };
}

/** Environment values are consumed once; callers must not print config, fixtures, responses, or thrown causes. */
export function readSymmyProofConfig(env: NodeJS.ProcessEnv): SymmyProofConfig {
  try {
    const key = env['SYMMY_API_KEY'];
    const origin = env['SYMMY_PROOF_ORIGIN'] ?? 'https://ontos-stage.web-revolution.cz';
    const input: unknown = env['SYMMY_PROOF_INPUT_JSON'] === undefined
      ? AKROS_STAGE_PROOF_INPUT : JSON.parse(env['SYMMY_PROOF_INPUT_JSON']);
    const stockSource: unknown = env['SYMMY_PROOF_STOCK_SOURCE_JSON'] === undefined
      ? AKROS_STAGE_STOCK_SOURCE : JSON.parse(env['SYMMY_PROOF_STOCK_SOURCE_JSON']);
    ensure(key !== undefined && key.trim().length > 0 && origin !== undefined, 'configuration', 'input-contract');
    checkedOrigin(origin);
    return {
      apiKey: Redacted.make(key), input: decode(SymmyProofInputSchema, input, 'configuration'), origin,
      legalEntityId: decode(uuid, env['SYMMY_PROOF_LEGAL_ENTITY_ID'] ?? STAGE_LEGAL_ENTITY, 'configuration'),
      stockSource: decode(SymmyProofStockSourceSchema, stockSource, 'configuration'),
    };
  } catch {
    throw new SymmyProofFailure('configuration', 'input-contract');
  }
}

/** Parses a curl Netscape jar without exposing it. Only live, secure, same-origin Shell-wide cookies are selected. */
export function parseSymmyOperatorCookieJar(contents: string, origin: string, nowMs = Date.now()): Redacted.Redacted<string> {
  const host = checkedOrigin(origin).hostname;
  const selected: string[] = [];
  for (let line of contents.split(/\r?\n/u)) {
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#') || line.trim().length === 0) continue;
    const fields = line.split('\t');
    ensure(fields.length === 7, 'configuration', 'input-contract');
    const [domain, subdomains, path, secure, expires, name, value] = fields;
    ensure(
      domain !== undefined && subdomains !== undefined && path !== undefined && secure !== undefined &&
      expires !== undefined && name !== undefined && value !== undefined,
      'configuration', 'input-contract',
    );
    const normalizedDomain = domain.replace(/^\./u, '').toLowerCase();
    const domainMatches = host === normalizedDomain || (subdomains === 'TRUE' && host.endsWith(`.${normalizedDomain}`));
    const expiry = Number(expires);
    ensure(Number.isFinite(expiry) && expiry >= 0, 'configuration', 'input-contract');
    if (!domainMatches || (expiry !== 0 && expiry * 1000 <= nowMs)) continue;
    // The same operator session is used for auth/session, shell/composition and auth/gateway-context.
    if (!(path === '/' || path === '/shell-super-app-api' || path === '/shell-super-app-api/')) continue;
    ensure(
      (secure === 'TRUE' || secure === 'FALSE') &&
      /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/u.test(name) && value.length > 0 &&
      !/[\u0000-\u0020;\u007f]/u.test(value),
      'configuration', 'input-contract',
    );
    selected.push(`${name}=${value}`);
  }
  ensure(selected.length > 0, 'configuration', 'read-auth-required');
  return Redacted.make(selected.join('; '));
}

/** The secret file is read only when the parent explicitly executes this loader/CLI. Never at module import. */
export async function loadSymmyProofConfig(
  env: NodeJS.ProcessEnv, options: { readonly operatorReadback: boolean } = { operatorReadback: false },
): Promise<SymmyProofConfig> {
  ensure(!(env['SYMMY_API_KEY'] && env['SYMMY_API_KEY_FILE']), 'configuration', 'input-contract');
  let config: SymmyProofConfig;
  try {
    config = env['SYMMY_API_KEY_FILE'] === undefined ? readSymmyProofConfig(env) : readSymmyProofConfig({
      ...env, SYMMY_API_KEY: (await readFile(env['SYMMY_API_KEY_FILE'], 'utf8')).trim(),
    });
  } catch {
    throw new SymmyProofFailure('configuration', 'input-contract');
  }
  if (!options.operatorReadback) return config;
  const file = env['SYMMY_PROOF_OPERATOR_COOKIE_FILE'];
  ensure(file !== undefined && file.length > 0, 'configuration', 'read-auth-required');
  try {
    return { ...config, operatorCookie: parseSymmyOperatorCookieJar(await readFile(file, 'utf8'), config.origin) };
  } catch (error) {
    if (error instanceof SymmyProofFailure) throw error;
    throw new SymmyProofFailure('configuration', 'read-auth-required');
  }
}

export function symmyProofFailureLine(error: unknown): string {
  return error instanceof SymmyProofFailure ? error.message : 'FAIL full-proof:unexpected';
}

// Explicit opt-in: `SYMMY_API_KEY_FILE=... node <this file> --full` (or --commerce for the first-stage helper).
if (import.meta.main) {
  try {
    const mode = process.argv[2];
    ensure(
      process.argv.length === 3 && (mode === '--commerce' || mode === '--full' || mode === '--help'),
      'configuration', 'input-contract',
    );
    if (mode === '--help') {
      process.stdout.write(
        'Usage: SYMMY_API_KEY_FILE=<private-key-file> node stage-symmy-full-function-proof.mts --full|--commerce\n' +
        'Alternative credential: SYMMY_API_KEY. Never supply both.\n' +
        '--full requires SYMMY_PROOF_OPERATOR_COOKIE_FILE for operator-only readbacks; no integration grants are broadened.\n' +
        'Optional: SYMMY_PROOF_ORIGIN, SYMMY_PROOF_INPUT_JSON, SYMMY_PROOF_LEGAL_ENTITY_ID,\n' +
        'SYMMY_PROOF_STOCK_SOURCE_JSON (current Inventory qualification), SYMMY_PROOF_ORDER_IDS_JSON.\n',
      );
    } else {
      const config = await loadSymmyProofConfig(process.env, { operatorReadback: mode === '--full' });
      if (mode === '--commerce') {
        await proveSymmyProductStockList(config);
        process.stdout.write('PASS product-stock-list:effects-and-list-readback\n');
      } else {
        let options: SymmyStageProofOptions = {};
        if (process.env['SYMMY_PROOF_ORDER_IDS_JSON'] !== undefined) {
          try {
            const ids: unknown = JSON.parse(process.env['SYMMY_PROOF_ORDER_IDS_JSON']);
            options = { expectedOrderIds: decode(Schema.NonEmptyArray(text), ids, 'configuration') };
          } catch {
            throw new SymmyProofFailure('configuration', 'input-contract');
          }
        }
        await proveSymmyFullFunction(config, options);
      }
    }
  } catch (error) {
    process.stderr.write(`${symmyProofFailureLine(error)}\n`);
    process.exitCode = 1;
  }
}
