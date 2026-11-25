import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';

import {
  Array as EffectArray,
  Cause,
  Clock,
  Config,
  ConfigProvider,
  Console,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Match,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
  Stream,
} from 'effect';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Command, Flag } from 'effect/cli';
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
import {
  CatalogPagePricesRequestSchema,
  CatalogPagePricesResponseSchema,
} from '@app/pricing-contracts/catalog-page-prices';
import { SourceStockPositionResolutionRequestSchema } from '../../verticals/inventory/shared/apis/source-stock-position-resolution.ts';
import {
  CatalogVariantOnHandPageRequestSchema,
  CatalogVariantOnHandPageResponseSchema,
} from '../../verticals/inventory/shared/apis/catalog-variant-on-hand-page.ts';
import {
  CurrentStockEvidenceForAvailabilityRequestSchema,
  CurrentStockEvidenceForAvailabilityResponseSchema,
} from '../../verticals/inventory/shared/apis/current-stock-evidence-for-availability.ts';
import { ActiveSavedAddressSchema } from '../../verticals/commerce-customer-context/shared/domain/address-book.ts';
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
import {
  fullOrderTotals,
  lineGrossMinor,
  orderLineVatMinor,
  vatInGrossMinor,
} from '../../verticals/merchandise/shared/domain/order-totals.ts';

const proofBoundaries = {
  addressReadback: 'address-readback',
  basePriceReadback: 'base-price-readback',
  categoryImport: 'category-import',
  categoryReadback: 'category-readback',
  configuration: 'configuration',
  customerImport: 'customer-import',
  customerReadback: 'customer-readback',
  customerReplay: 'customer-replay',
  fullProof: 'full-proof',
  groupAssignment: 'group-assignment',
  groupImport: 'group-import',
  groupReadback: 'group-readback',
  groupReplay: 'group-replay',
  imageImport: 'image-import',
  imageReadback: 'image-readback',
  listPriceImport: 'list-price-import',
  listPriceReadback: 'list-price-readback',
  orderExport: 'order-export',
  priceListImport: 'price-list-import',
  priceListReadback: 'price-list-readback',
  productImport: 'product-import',
  productReadback: 'product-readback',
  productReplay: 'product-replay',
  productUnseen: 'product-unseen',
  skuReadback: 'sku-readback',
  stockImport: 'stock-import',
  stockReadback: 'stock-readback',
} as const;
const failureCodes = {
  effectCount: 'effect-count',
  effectOutcome: 'effect-outcome',
  effectOwner: 'effect-owner',
  httpStatus: 'http-status',
  inputContract: 'input-contract',
  itemCount: 'item-count',
  jobIdentity: 'job-identity',
  jobTerminal: 'job-terminal',
  laneFailed: 'lane-failed',
  missingWiring: 'missing-wiring',
  network: 'network',
  notUnseen: 'not-unseen',
  readAuthExpired: 'read-auth-expired',
  readAuthRequired: 'read-auth-required',
  readAuthScope: 'read-auth-scope',
  readback: 'readback',
  readPermission: 'read-permission',
  redirect: 'redirect',
  replayIdentity: 'replay-identity',
  responseTooLarge: 'response-too-large',
  schema: 'schema',
  timeout: 'timeout',
  unexpected: 'unexpected',
  unsafePath: 'unsafe-path',
} as const;
const UNRECOGNIZED_PROBLEM = 'unrecognized-problem';

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const uuid = Schema.String.check(Schema.isUUID());
const moduleIdSchema = text.pipe(Schema.brand('ModuleKey'));
const resourceIdSchema = uuid.pipe(Schema.brand('ResourceId'));
const tenantIdSchema = uuid.pipe(Schema.brand('TenantId'));
const effectIdSchema = uuid.pipe(Schema.brand('SymmyEffectId'));
const itemIdSchema = uuid.pipe(Schema.brand('SymmyItemId'));
const jobIdSchema = uuid.pipe(Schema.brand('SymmyJobId'));
const variantIdSchema = uuid.pipe(Schema.brand('CatalogVariantId'));
const sourceRecordIdSchema = text.pipe(Schema.brand('SymmySourceRecordId'));
const marketIdSchema = text.pipe(Schema.brand('MarketId'));
const channelIdSchema = text.pipe(Schema.brand('ChannelId'));
const locationKeySchema = text.pipe(Schema.brand('SymmyLocationKey'));
const revisionIdSchema = uuid.pipe(Schema.brand('PriceRevisionId'));
const itemKeySchema = text.pipe(Schema.brand('SymmyItemKey'));
const productIdSchema = text.pipe(Schema.brand('NativeProductId'));
const categoryIdSchema = text.pipe(Schema.brand('NativeCategoryId'));
const legalEntityIdSchema = uuid.pipe(Schema.brand('LegalEntityId'));
const RefSchema = Schema.Struct({
  moduleId: moduleIdSchema,
  resourceId: resourceIdSchema,
  resourceType: text,
  tenantId: tenantIdSchema,
});
export type ProofRef = typeof RefSchema.Encoded;
const accepted = Schema.Literals(['accepted_change', 'accepted_no_change']);
const EffectSchema = Schema.Union([
  Schema.Struct({ effectId: effectIdSchema, owner: text, status: accepted }),
  Schema.Struct({
    effectId: effectIdSchema,
    originalStatus: accepted,
    owner: text,
    status: Schema.Literal('duplicate'),
  }),
  Schema.Struct({
    effectId: Schema.optionalKey(effectIdSchema),
    owner: text,
    status: Schema.Literals([
      'waiting',
      'executing',
      'indeterminate',
      'unsupported',
      'stale',
      'unresolved',
      'ambiguous',
      'denied',
      'conflict',
      'unavailable',
      'invalid',
    ]),
  }),
]);
const ItemSchema = Schema.Struct({
  effects: Schema.NonEmptyArray(EffectSchema),
  itemId: itemIdSchema,
  outcome: Schema.Literals(['accepted', 'partial', 'not_accepted']),
});
const ItemsSchema = Schema.Struct({ items: Schema.NonEmptyArray(ItemSchema) });
type Items = typeof ItemsSchema.Type;
const AdmissionSchema = Schema.Struct({ jobId: jobIdSchema, status: Schema.Literal('queued') });
const JobSchema = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(ItemSchema)),
  jobId: jobIdSchema,
  status: Schema.Literals([
    'queued',
    'running',
    'blocked',
    'indeterminate',
    'completed_all',
    'completed_partial',
    'completed_none',
  ]),
});
const ProductPageSchema = Schema.Struct({
  count: Schema.Int,
  products: Schema.Array(
    Schema.Struct({
      id: text,
      product: Schema.Struct({
        name: Schema.optionalKey(text),
        productRef: RefSchema,
        variants: Schema.Array(Schema.Struct({ variantId: variantIdSchema, variantRef: RefSchema })),
      }),
      sourceRecordId: sourceRecordIdSchema,
      variantSources: Schema.Array(Schema.Struct({ sourceRecordId: sourceRecordIdSchema, variantId: variantIdSchema })),
    }),
  ),
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
    marketId: marketIdSchema,
  }),
  currencyCode: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)),
  locationKey: locationKeySchema,
  unitRef: RefSchema,
});
export type SymmyProofInput = typeof SymmyProofInputSchema.Encoded;
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
  readonly apiKey: Redacted.Redacted;
  readonly input: SymmyProofInput;
  readonly legalEntityId?: string;
  readonly operatorCookie?: Redacted.Redacted;
  readonly origin: string;
  readonly pollMs?: number;
  readonly stockSource?: typeof SymmyProofStockSourceSchema.Type;
  /** Whole-run budget; all fetches and polling share it. Defaults to ten minutes. */
  readonly timeoutMs?: number;
}
export const ProofBoundarySchema = Schema.Literals(Object.values(proofBoundaries));
export type ProofBoundary = typeof ProofBoundarySchema.Type;
const FailureCodeSchema = Schema.Literals(Object.values(failureCodes));
type FailureCode = typeof FailureCodeSchema.Type;
const SAFE_PROBLEM_TAGS = new Set([
  'GatewayAuthenticationRequiredProblem',
  'GatewayForbiddenProblem',
  'GatewayUnavailableProblem',
  'GatewayAudienceInvalidProblem',
  'GatewayReloadRequiredProblem',
  'GatewayRateLimitedProblem',
  'GatewayInternalProblem',
  'SymmyInvalidProblem',
  'SymmyUnavailableProblem',
  'SymmyUnsupportedProblem',
  'SymmyIdempotencyRequiredProblem',
  'SymmyFixtureIntentConflictProblem',
  'SymmyFixtureJobNotFoundProblem',
  'SymmyStockInputProblem',
  'SymmyStockDependencyNotReadyProblem',
  'SymmyStockSourceUnavailableProblem',
  'SymmyDemoOrderNotFoundProblem',
  ...[
    'ImportSourceCatalogAction',
    'SkuLookup',
    'SourceStockPositionResolution',
    'CurrentStockEvidenceForAvailability',
    'SavedAddressList',
    'EffectiveCustomerGroupMemberships',
    'CustomerGroupDetail',
    'CatalogPagePrices',
    'Records',
  ].flatMap((prefix) =>
    [
      'AuthenticationProblem',
      'ForbiddenProblem',
      'InvalidProblem',
      'NotFoundProblem',
      'ConflictProblem',
      'PolicyProblem',
      'PolicyConflictProblem',
      'IneligibleProblem',
      'PreconditionProblem',
      'UnavailableProblem',
      'InternalProblem',
      'AlreadyCommittedProblem',
      'CommitIndeterminateProblem',
    ].map((suffix) => `${prefix}${suffix}`),
  ),
]);
// Only closed contract codes may leave the process. Never retain detail/title, response previews, IDs or arbitrary reasons.
const SAFE_PROBLEM_CODES = new Set([
  'LOCATION_NOT_ENROLLED',
  'UNIT_NOT_ENROLLED',
  'ITEM_NOT_PROVISIONED',
  'POSITION_NOT_FOUND',
  'POLICY_NOT_FOUND',
  'LOCATION_NOT_ALLOWED',
  'ITEM_CORRELATION_AMBIGUOUS',
  'OWNER_RESOLUTION_MISMATCH',
  'TENANT_SCOPE_MISMATCH',
  'OWNER_UNAVAILABLE',
  'projection_not_configured',
  'filter_not_supported',
  'owner_field_not_supported',
  'search_too_broad',
  'action_approval_required',
  'action_permission_denied',
  'module_state_denied',
  'operation_context_denied',
  'operation_context_invalid',
  'merchandise_permission_denied',
  'merchandise_scope_mismatch',
  'action_invocation_not_found',
  'merchandise_not_found',
  'action_request_hash_conflict',
  'action_invocation_state_invalid',
  'merchandise_category_slug_taken',
  'merchandise_lifecycle_conflict',
  'merchandise_offered_price_changed',
  'merchandise_stock_reconciliation_required',
  'merchandise_tier_base_price_required',
  'merchandise_variant_bulk_price_unsupported',
  'merchandise_variant_sku_required',
  'merchandise_revision_conflict',
  'action_policy_denied',
  'merchandise_reference_ineligible',
  'action_invocation_persistence_failed',
  'action_permission_check_failed',
  'action_policy_evaluation_failed',
  'action_transaction_failed',
  'module_state_check_unavailable',
  'operation_context_unavailable',
  'merchandise_persistence_unavailable',
  'action_already_committed',
  'action_commit_indeterminate',
  'action_invocation_already_committed',
  'read_handler_unavailable',
  'key_provider_unavailable',
  'issuer_unavailable',
  'gateway_dispatch_failed',
]);
export const SymmyProofLaneNameSchema = Schema.Literals(['commerce', 'customers', 'native-catalog', 'orders']);
export type SymmyProofLaneName = typeof SymmyProofLaneNameSchema.Type;

type EffectStatus = typeof EffectSchema.Type.status;
const EffectStatusSchema = Schema.Literals([
  'accepted_change',
  'accepted_no_change',
  'duplicate',
  'waiting',
  'executing',
  'indeterminate',
  'unsupported',
  'stale',
  'unresolved',
  'ambiguous',
  'denied',
  'conflict',
  'unavailable',
  'invalid',
]);
const EffectCountsSchema = Schema.Record(EffectStatusSchema, Schema.optionalKey(Schema.Int));
export const SymmySafeFailureBodySchema = Schema.Union([
  Schema.Struct({ failed: Schema.Array(SymmyProofLaneNameSchema), kind: Schema.Literal('lanes') }),
  Schema.Struct({ kind: Schema.Literals(['non-json', 'empty', UNRECOGNIZED_PROBLEM]) }),
  Schema.Struct({
    code: Schema.optionalKey(Schema.String.check(Schema.makeFilter((value) => SAFE_PROBLEM_CODES.has(value)))),
    kind: Schema.Literal('problem'),
    reason: Schema.optionalKey(Schema.String.check(Schema.makeFilter((value) => SAFE_PROBLEM_CODES.has(value)))),
    retryable: Schema.optionalKey(Schema.Boolean),
    tag: Schema.optionalKey(Schema.String.check(Schema.makeFilter((value) => SAFE_PROBLEM_TAGS.has(value)))),
  }),
  Schema.Struct({
    effects: EffectCountsSchema,
    items: Schema.Int,
    kind: Schema.Literals(['effects', 'job']),
    status: Schema.optionalKey(JobSchema.fields.status),
  }),
]);
export type SymmySafeFailureBody = typeof SymmySafeFailureBodySchema.Type;
const SafeFailureJsonSchema = Schema.fromJsonString(SymmySafeFailureBodySchema);
type SafeProblem = Extract<SymmySafeFailureBody, { readonly kind: 'problem' }>;
type MutableSafeProblem = { -readonly [K in keyof SafeProblem]: SafeProblem[K] };
const ProblemMetadataSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.Unknown),
  code: Schema.optionalKey(Schema.Unknown),
  reason: Schema.optionalKey(Schema.Unknown),
  retryable: Schema.optionalKey(Schema.Unknown),
});
export const sanitizeSymmyFailureBody = <Input,>(body: Input, credential: Redacted.Redacted): SymmySafeFailureBody => {
  const metadata = Option.getOrUndefined(Schema.decodeUnknownOption(ProblemMetadataSchema)(body));
  if (metadata === undefined) {
    return { kind: UNRECOGNIZED_PROBLEM };
  }
  const allowed = (values: ReadonlySet<string>) =>
    Schema.String.check(Schema.makeFilter((value) => values.has(value) && !value.includes(Redacted.value(credential))));
  const tag = Option.getOrUndefined(Schema.decodeUnknownOption(allowed(SAFE_PROBLEM_TAGS))(metadata._tag));
  const code = Option.getOrUndefined(Schema.decodeUnknownOption(allowed(SAFE_PROBLEM_CODES))(metadata.code));
  const reason = Option.getOrUndefined(Schema.decodeUnknownOption(allowed(SAFE_PROBLEM_CODES))(metadata.reason));
  if (tag === undefined && code === undefined && reason === undefined) {
    return { kind: UNRECOGNIZED_PROBLEM };
  }
  const safe: MutableSafeProblem = { kind: 'problem' };
  if (tag !== undefined) {
    safe.tag = tag;
  }
  if (code !== undefined) {
    safe.code = code;
  }
  if (reason !== undefined) {
    safe.reason = reason;
  }
  if (Schema.is(Schema.Boolean)(metadata.retryable)) {
    safe.retryable = metadata.retryable;
  }
  return safe;
};
const effectDiagnostic = (items: readonly (typeof ItemSchema.Type)[]): SymmySafeFailureBody => {
  const counts: Partial<Record<EffectStatus, number>> = {};
  for (const item of items) {
    for (const effect of item.effects) {
      counts[effect.status] = (counts[effect.status] ?? 0) + 1;
    }
  }
  return { effects: counts, items: items.length, kind: 'effects' };
};

/** Public diagnostics are closed metadata; foreign causes are retained only as Redacted values. */
export class SymmyProofFailure extends Schema.TaggedError<SymmyProofFailure>()('SymmyProofFailure', {
  boundary: ProofBoundarySchema,
  code: FailureCodeSchema,
  privateCause: Schema.optional(Schema.Redacted(Schema.Unknown)),
  safeBody: Schema.optional(SymmySafeFailureBodySchema),
  status: Schema.optional(Schema.Int),
}) {
  constructor(
    boundary: ProofBoundary,
    code: FailureCode,
    status?: number,
    safeBody?: SymmySafeFailureBody,
    privateCause?: Redacted.Redacted<unknown>,
  ) {
    super({ boundary, code, privateCause, safeBody, status });
  }
  override get message(): string {
    const status = this.status === undefined ? '' : `:${this.status}`;
    const body =
      this.safeBody === undefined
        ? ''
        : ` body=${Result.getOrThrow(Schema.encodeResult(SafeFailureJsonSchema)(this.safeBody))}`;
    return `FAIL ${this.boundary}:${this.code}${status}${body}`;
  }
}

const decode = <A, Input>(
  schema: Schema.ConstraintDecoder<A>,
  body: Input,
  boundary: ProofBoundary,
): Result.Result<A, SymmyProofFailure> =>
  Schema.decodeUnknownResult(schema)(body).pipe(
    Result.mapError(
      (cause) => new SymmyProofFailure(boundary, failureCodes.schema, undefined, undefined, Redacted.make(cause)),
    ),
  );
const validatePayload = <Input,>(schema: Schema.ConstraintDecoder<unknown>, body: Input, boundary: ProofBoundary) =>
  Schema.decodeUnknownResult(schema, { onExcessProperty: 'error' })(body).pipe(
    Result.mapError(
      (cause) =>
        new SymmyProofFailure(boundary, failureCodes.inputContract, undefined, undefined, Redacted.make(cause)),
    ),
  );
export interface EffectExpectation {
  readonly effectsAtLeast: number;
  readonly itemsAtLeast: number;
  readonly owners: Readonly<Record<string, number>>;
}
export const assertAcceptedEffects = <Input,>(body: Input, expected: EffectExpectation, boundary: ProofBoundary) =>
  Result.gen(function* assertAcceptedEffectsProgram() {
    if (
      !(
        Number.isInteger(expected.itemsAtLeast) &&
        expected.itemsAtLeast > 0 &&
        Number.isInteger(expected.effectsAtLeast) &&
        expected.effectsAtLeast > 0 &&
        Object.keys(expected.owners).length > 0 &&
        Object.values(expected.owners).every((count) => Number.isInteger(count) && count > 0)
      )
    ) {
      return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.inputContract, undefined, undefined));
    }
    const result = yield* decode(ItemsSchema, body, boundary);
    const diagnostic = effectDiagnostic(result.items);
    if (result.items.length < expected.itemsAtLeast) {
      return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.itemCount, undefined, diagnostic));
    }
    if (!result.items.every((item) => item.outcome === 'accepted')) {
      return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.effectOutcome, undefined, diagnostic));
    }
    const effects = result.items.flatMap((item) => item.effects);
    if (effects.length < expected.effectsAtLeast) {
      return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.effectCount, undefined, diagnostic));
    }
    for (const effect of effects) {
      if (
        !(
          effect.status === 'accepted_change' ||
          effect.status === 'accepted_no_change' ||
          effect.status === 'duplicate'
        )
      ) {
        return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.effectOutcome, undefined, diagnostic));
      }
    }
    for (const [owner, count] of Object.entries(expected.owners)) {
      if (effects.filter((effect) => effect.owner === owner).length < count) {
        return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.effectOwner, undefined, diagnostic));
      }
    }
    return result;
  });
const receiptIdentity = (result: Items) =>
  result.items
    .map((item) => ({
      effects: item.effects
        .map((effect) => ({
          effectId: effect.effectId,
          owner: effect.owner,
        }))
        .toSorted((a, b) => (a.effectId ?? '').localeCompare(b.effectId ?? '')),
      itemId: item.itemId,
    }))
    .toSorted((a, b) => a.itemId.localeCompare(b.itemId));

export const assertReplayIdentity = (original: Items, replay: Items, boundary: ProofBoundary) =>
  Result.gen(function* assertReplayIdentityProgram() {
    if (!isDeepStrictEqual(receiptIdentity(original), receiptIdentity(replay))) {
      return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.replayIdentity, undefined, undefined));
    }

    return yield* Result.void;
  });
export const makeSymmyProofNames = () => {
  const prefix = `SP_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  return {
    category: `${prefix}_CATEGORY`,
    group: `${prefix}_GROUP`,
    image: `${prefix}_IMAGE`,
    list: `${prefix}_LIST`,
    organization: `${prefix}_ORG`,
    person: `${prefix}_PERSON`,
    prefix,
    product: `${prefix}_PRODUCT`,
    variant: `${prefix}_VARIANT`,
  };
};
export type SymmyProofNames = ReturnType<typeof makeSymmyProofNames>;
export interface SymmyProductProof {
  readonly baseAmount: string;
  readonly effectiveFrom: string;
  readonly listAmount: string;
  readonly names: SymmyProofNames;
  readonly productRef: ProofRef;
  readonly stockAmount: string;
  readonly variantRef: ProofRef;
}
const PriceListsPageSchema = Schema.Struct({
  count: Schema.Int,
  priceLists: Schema.Array(
    Schema.Struct({
      code: text,
      name: text,
      priceGroupRef: RefSchema,
      prices: Schema.optionalKey(
        Schema.Struct({
          count: Schema.Int,
          prices: Schema.Array(Schema.Struct({ price: Schema.Unknown })),
        }),
      ),
    }),
  ),
});
const CurrentPriceSchema = Schema.Struct({
  definition: Schema.Struct({
    identityKey: Schema.Struct({
      catalogSelection: Schema.Struct({ productRef: RefSchema, variantRef: RefSchema }),
      commercialScope: Schema.Struct({ channelId: channelIdSchema, marketId: marketIdSchema }),
      priceGroupSelector: Schema.Struct({ kind: Schema.Literal('PRICE_GROUP'), priceGroupRef: RefSchema }),
      unitBasis: Schema.Struct({ quantity: text, unitRef: RefSchema }),
    }),
    priceRef: RefSchema,
    revision: Schema.Struct({
      effectiveFrom: text,
      monetaryAmount: Schema.Struct({ amount: text, currencyCode: text }),
      revision: Schema.Int,
      revisionId: revisionIdSchema,
    }),
  }),
  outcome: Schema.Literal('PRICE_DEFINITION_CURRENT'),
});
export interface SymmyCommerceProof extends SymmyProductProof {
  readonly priceGroupRef: ProofRef;
}

const DecimalSchema = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u));
const canonicalDecimal = <Input,>(value: Input): string | undefined => {
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(DecimalSchema)(value));
  if (parsed === undefined) {
    return undefined;
  }
  return parsed.includes('.') ? parsed.replace(/0+$/u, '').replace(/\.$/u, '') : parsed;
};
/** Exact decimal comparison without binary floating point or accepting malformed decimal inputs. */
export const decimalEqual = <Left, Right>(left: Left, right: Right): boolean => {
  const canonical = canonicalDecimal(left);
  return canonical !== undefined && canonical === canonicalDecimal(right);
};
export const assertCurrentListPrice = <Input,>(
  value: Input,
  proof: SymmyProductProof,
  input: SymmyProofConfig['input'],
  priceGroupRef: ProofRef,
  startsAt: string,
) =>
  Result.gen(function* assertCurrentListPriceProgram() {
    const stored = yield* decode(CurrentPriceSchema, value, proofBoundaries.listPriceReadback);
    const identity = stored.definition.identityKey;
    if (
      !(
        isDeepStrictEqual(identity.catalogSelection, { productRef: proof.productRef, variantRef: proof.variantRef }) &&
        identity.priceGroupSelector.priceGroupRef.resourceId === priceGroupRef.resourceId &&
        identity.commercialScope.channelId === input.commercialScope.channelId &&
        identity.commercialScope.marketId === input.commercialScope.marketId &&
        decimalEqual(identity.unitBasis.quantity, '1') &&
        isDeepStrictEqual(identity.unitBasis.unitRef, input.unitRef) &&
        decimalEqual(stored.definition.revision.monetaryAmount.amount, proof.listAmount) &&
        stored.definition.revision.monetaryAmount.currencyCode === input.currencyCode &&
        stored.definition.revision.effectiveFrom === startsAt
      )
    ) {
      return yield* Result.fail(
        new SymmyProofFailure(proofBoundaries.listPriceReadback, failureCodes.readback, undefined, undefined),
      );
    }
    return stored;
  });
const PRICE_EFFECTS = {
  effectsAtLeast: 1,
  itemsAtLeast: 1,
  owners: { 'commerce.pricing': 1 },
} satisfies EffectExpectation;
const checkedOrigin = (origin: string) =>
  Result.gen(function* checkedOriginProgram() {
    const url = URL.parse(origin);
    if (
      !(
        url !== null &&
        url.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        url.pathname === '/' &&
        url.search === '' &&
        url.hash === ''
      )
    ) {
      return yield* Result.fail(
        new SymmyProofFailure(proofBoundaries.configuration, failureCodes.inputContract, undefined, undefined),
      );
    }
    return url;
  });
const checkedPath = (path: string, origin: URL, boundary: ProofBoundary) =>
  Result.gen(function* checkedPathProgram() {
    const url = URL.parse(path, origin);
    if (
      !(
        url !== null &&
        path.startsWith(`${PREFIX}/`) &&
        url.origin === origin.origin &&
        url.hash === '' &&
        url.pathname.startsWith(`${PREFIX}/`) &&
        !url.pathname.includes('//')
      )
    ) {
      return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.unsafePath, undefined, undefined));
    }
    return url;
  });

const OPERATOR_SESSION_PATH = '/shell-super-app-api/auth/session';
const OPERATOR_COMPOSITION_PATH = '/shell-super-app-api/shell/composition';
const OPERATOR_GATEWAY_PATH = '/shell-super-app-api/auth/gateway-context';
const STAGE_LEGAL_ENTITY = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
const OWNER_READS = {
  'catalog/sku-lookup': { audience: 'catalog', readName: 'sku-lookup', request: SkuLookupRequestSchema },
  'commerce-customer-context/customer-group-detail': {
    audience: 'commerce-customer-context',
    readName: 'customer-group-detail',
    request: CustomerGroupDetailRequestSchema,
  },
  'commerce-customer-context/effective-customer-group-memberships': {
    audience: 'commerce-customer-context',
    readName: 'effective-customer-group-memberships',
    request: EffectiveCustomerGroupMembershipsRequestSchema,
  },
  'inventory/catalog-variant-on-hand-page': {
    audience: 'inventory',
    readName: 'catalog-variant-on-hand-page',
    request: CatalogVariantOnHandPageRequestSchema,
  },
  'inventory/current-stock-evidence-for-availability': {
    audience: 'inventory',
    readName: 'current-stock-evidence-for-availability',
    request: CurrentStockEvidenceForAvailabilityRequestSchema,
  },
  'merchandise/records': { audience: 'merchandise', readName: 'records', request: RecordsRequestSchema },
  'pricing/catalog-page-prices': {
    audience: 'pricing',
    readName: 'catalog-page-prices',
    request: CatalogPagePricesRequestSchema,
  },
};
/** Pure plan for registered owner Reads. The operator gateway, not the proof, admits operation scope. */
export const symmyOwnerReadEnvelope = (
  operation: SymmyOwnerRead,
  query: Schema.Json,
  legalEntityId: string,
  boundary: ProofBoundary,
) =>
  Result.gen(function* symmyOwnerReadEnvelopeProgram() {
    if (!Object.hasOwn(OWNER_READS, operation)) {
      return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.inputContract, undefined, undefined));
    }
    const read = OWNER_READS[operation];
    yield* validatePayload(read.request, query, boundary);
    yield* decode(uuid, legalEntityId, proofBoundaries.configuration);
    return {
      audience: read.audience,
      legalEntityId,
      query,
      readName: read.readName,
    };
  });
/** Admit only the public Symmy prefix or the three operator endpoints and registered owner Reads. */
const proofRequestUrl = (
  path: string,
  method: 'GET' | 'POST',
  origin: URL,
  authenticationKind: 'symmy' | 'operator' | 'owner',
  boundary: ProofBoundary,
) =>
  Result.gen(function* proofRequestUrlProgram() {
    let url: URL;
    if (authenticationKind === 'symmy') {
      url = yield* checkedPath(path, origin, boundary);
    } else {
      if (!(path.startsWith('/') && !path.startsWith('//') && !path.includes('?') && !path.includes('#'))) {
        return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.unsafePath, undefined, undefined));
      }
      url = new URL(path, origin);
      if (!(url.origin === origin.origin && url.username === '' && url.password === '')) {
        return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.unsafePath, undefined, undefined));
      }
      if (authenticationKind === 'operator') {
        if (
          !(
            (method === 'GET' && [OPERATOR_SESSION_PATH, OPERATOR_COMPOSITION_PATH].includes(path)) ||
            (method === 'POST' && path === OPERATOR_GATEWAY_PATH)
          )
        ) {
          return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.unsafePath, undefined, undefined));
        }
      } else if (
        !(method === 'POST' && /^\/shell-super-app-api\/module-api\/[^?#]+\/reads\/[A-Za-z0-9._-]+$/u.test(path))
      ) {
        return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.unsafePath, undefined, undefined));
      }
    }

    return url;
  });
const SymmyTransportFailureSchema = Schema.TaggedStruct('SymmyTransportFailure', {
  privateCause: Schema.Redacted(Schema.Unknown),
});

interface ProofResponseBytes {
  readonly chunks: Uint8Array[];
  readonly size: number;
}
const emptyProofResponseBytes = (): ProofResponseBytes => ({ chunks: [], size: 0 });
/** One bounded response, no retries: classify status, decode JSON and redact every held credential. */
const readProofHttpResponse = Effect.fn('SymmyProofHttpResponse')(function* readProofHttpResponseProgram(
  response: Response,
  authenticationKind: 'symmy' | 'operator' | 'owner',
  boundary: ProofBoundary,
  secrets: readonly [Redacted.Redacted, ...Redacted.Redacted[]],
) {
  const { body } = response;
  if (response.status >= 300 && response.status < 400) {
    if (body !== null) {
      yield* Effect.tryPromise({
        catch: (cause) => SymmyTransportFailureSchema.make({ privateCause: Redacted.make(cause) }),
        try: async () => await body.cancel(),
      });
    }
    return yield* new SymmyProofFailure(boundary, failureCodes.redirect);
  }
  const success = [200, 202].includes(response.status);
  let failureCode: FailureCode = failureCodes.httpStatus;
  if (authenticationKind !== 'symmy') {
    if (response.status === 401) {
      failureCode = failureCodes.readAuthExpired;
    }
    if (response.status === 403) {
      failureCode = failureCodes.readPermission;
    }
  }
  const failure = (safeBody: SymmySafeFailureBody, cause?: Redacted.Redacted<unknown>) =>
    new SymmyProofFailure(boundary, failureCode, response.status, safeBody, cause);
  if (body === null) {
    return yield* success
      ? new SymmyProofFailure(boundary, failureCodes.schema, response.status)
      : failure({ kind: 'empty' });
  }
  const chunks = yield* Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => SymmyTransportFailureSchema.make({ privateCause: Redacted.make(cause) }),
  }).pipe(
    Stream.runFoldEffect(emptyProofResponseBytes, (acc, chunk) =>
      Effect.gen(function* chunksProgram() {
        const size = acc.size + chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          return yield* new SymmyProofFailure(boundary, failureCodes.responseTooLarge);
        }
        acc.chunks.push(chunk);
        return { chunks: acc.chunks, size };
      }),
    ),
  );
  const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    Buffer.concat(chunks.chunks).toString('utf-8'),
  ).pipe(
    Effect.mapError((cause) =>
      success
        ? new SymmyProofFailure(boundary, failureCodes.schema, response.status, undefined, Redacted.make(cause))
        : failure({ kind: 'non-json' }, Redacted.make(cause)),
    ),
  );
  if (!success) {
    let safe = sanitizeSymmyFailureBody(parsed, secrets[0]);
    for (const secret of secrets) {
      if (Result.getOrThrow(Schema.encodeResult(SafeFailureJsonSchema)(safe)).includes(Redacted.value(secret))) {
        safe = { kind: UNRECOGNIZED_PROBLEM };
      }
    }
    return yield* failure(safe);
  }
  return { body: parsed, status: response.status } satisfies HttpResult;
});
export const createSymmyProofClient = Effect.fn('SymmyProofClient')(function* createSymmyProofClientProgram(
  config: SymmyProofConfig,
) {
  const origin = yield* Effect.fromResult(checkedOrigin(config.origin));
  const budget = config.timeoutMs ?? 600_000;
  const pollMs = config.pollMs ?? 1000;
  if (
    !(
      Number.isInteger(budget) &&
      budget >= 1000 &&
      budget <= 900_000 &&
      Number.isInteger(pollMs) &&
      pollMs >= 10 &&
      pollMs <= 10_000 &&
      Redacted.isRedacted(config.apiKey) &&
      Redacted.value(config.apiKey).trim().length > 0
    )
  ) {
    return yield* new SymmyProofFailure(proofBoundaries.configuration, failureCodes.inputContract);
  }
  const deadline = (yield* Clock.currentTimeMillis) + budget;
  const remaining = Effect.fn('SymmyProofBudget')(function* remainingProgram(boundary: ProofBoundary) {
    const ms = deadline - (yield* Clock.currentTimeMillis);
    if (ms <= 0) {
      return yield* new SymmyProofFailure(boundary, failureCodes.timeout);
    }
    return ms;
  });
  type Authentication =
    | { readonly kind: 'symmy' }
    | { readonly kind: 'operator' }
    | { readonly kind: 'owner'; readonly revision: string; readonly token: Redacted.Redacted };
  const SYMMY_AUTHENTICATION = { kind: 'symmy' } satisfies Authentication;
  const request = Effect.fn('SymmyProofRequest')(function* requestProgram<Input>(
    path: string,
    method: 'GET' | 'POST',
    body: Input,
    key: string | undefined,
    boundary: ProofBoundary,
    authentication: Authentication = SYMMY_AUTHENTICATION,
  ) {
    const url = yield* Effect.fromResult(proofRequestUrl(path, method, origin, authentication.kind, boundary));
    const headers = new Headers();
    const secrets: [Redacted.Redacted, ...Redacted.Redacted[]] = [config.apiKey];
    if (config.operatorCookie !== undefined) {
      secrets.push(config.operatorCookie);
    }
    if (authentication.kind === 'symmy') {
      headers.set('x-api-key', Redacted.value(config.apiKey));
    } else if (authentication.kind === 'operator') {
      if (config.operatorCookie === undefined) {
        return yield* new SymmyProofFailure(boundary, failureCodes.readAuthRequired);
      }
      headers.set('cookie', Redacted.value(config.operatorCookie));
      headers.set('origin', origin.origin);
    } else {
      secrets.push(authentication.token);
      headers.set('authorization', `Bearer ${Redacted.value(authentication.token)}`);
      headers.set('x-correlation-id', randomUUID());
      headers.set('x-ontos-composition-revision', authentication.revision);
    }
    const encoded =
      method === 'POST'
        ? yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))(body).pipe(
            Effect.mapError(
              (cause) =>
                new SymmyProofFailure(boundary, failureCodes.inputContract, undefined, undefined, Redacted.make(cause)),
            ),
          )
        : undefined;
    headers.set('accept', 'application/json');
    if (method === 'POST') {
      headers.set('content-type', 'application/json');
    }
    if (key !== undefined) {
      headers.set('idempotency-key', key);
    }
    const timeout = Math.min(20_000, yield* remaining(boundary));
    const init: RequestInit = { headers, method, redirect: 'manual', signal: AbortSignal.timeout(timeout) };
    if (encoded !== undefined) {
      init.body = encoded;
    }
    // The request stays abortable until its body is consumed: a failed or interrupted read aborts it.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.tryPromise({
          catch: (cause) => SymmyTransportFailureSchema.make({ privateCause: Redacted.make(cause) }),
          try: async (signal) =>
            await fetch(url, { ...init, signal: AbortSignal.any([signal, controller.signal, init.signal ?? signal]) }),
        }).pipe(Effect.flatMap((response) => readProofHttpResponse(response, authentication.kind, boundary, secrets))),
      (controller, exit) => (Exit.isFailure(exit) ? Effect.sync(() => controller.abort()) : Effect.void),
    ).pipe(
      Effect.catchTag('SymmyTransportFailure', (failure) =>
        Effect.gen(function* classifyTransportFailure() {
          const cause = Redacted.value(failure.privateCause);
          const expired = (yield* Clock.currentTimeMillis) >= deadline;
          return yield* new SymmyProofFailure(
            boundary,
            expired || (Predicate.isError(cause) && ['TimeoutError', 'AbortError'].includes(cause.name))
              ? failureCodes.timeout
              : failureCodes.network,
            undefined,
            undefined,
            failure.privateCause,
          );
        }),
      ),
    );
  });
  let operatorRevision: string | undefined;
  const operatorState = Effect.fn('SymmyProofOperatorState')(function* operatorStateProgram(boundary: ProofBoundary) {
    if (config.operatorCookie === undefined) {
      return yield* new SymmyProofFailure(boundary, failureCodes.readAuthRequired);
    }
    if (operatorRevision !== undefined) {
      return operatorRevision;
    }
    const sessionResponse = yield* request(OPERATOR_SESSION_PATH, 'GET', undefined, undefined, boundary, {
      kind: 'operator',
    });
    const session = yield* Effect.fromResult(
      decode(
        Schema.Struct({
          identity: Schema.Struct({ legalEntityId: legalEntityIdSchema, tenantId: tenantIdSchema }),
          state: Schema.Literal('authenticated'),
        }),
        sessionResponse.body,
        boundary,
      ),
    );
    if (
      !(
        session.identity.tenantId === config.input.unitRef.tenantId &&
        session.identity.legalEntityId === (config.legalEntityId ?? STAGE_LEGAL_ENTITY)
      )
    ) {
      return yield* new SymmyProofFailure(boundary, failureCodes.readAuthScope);
    }
    const compositionResponse = yield* request(OPERATOR_COMPOSITION_PATH, 'GET', undefined, undefined, boundary, {
      kind: 'operator',
    });
    const composition = yield* Effect.fromResult(
      decode(
        Schema.Struct({
          compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
          state: Schema.Literal('available'),
        }),
        compositionResponse.body,
        boundary,
      ),
    );
    operatorRevision = composition.compositionRevision;
    return operatorRevision;
  });
  const client: SymmyProofClient = {
    ownerRead: Effect.fn('SymmyProofOwnerRead')(function* ownerReadProgram(operation, query, boundary) {
      const envelope = yield* Effect.fromResult(
        symmyOwnerReadEnvelope(operation, query, config.legalEntityId ?? STAGE_LEGAL_ENTITY, boundary),
      );
      const { query: ownerQuery, readName, ...scope } = envelope;
      const compositionRevision = yield* operatorState(boundary);
      const gatewayResponse = yield* request(
        OPERATOR_GATEWAY_PATH,
        'POST',
        { ...scope, compositionRevision },
        undefined,
        boundary,
        { kind: 'operator' },
      );
      const gateway = yield* Effect.fromResult(
        decode(
          Schema.Struct({
            apiBaseUrl: Schema.String,
            compositionRevision: Schema.String,
            token: Schema.RedactedFromValue(Schema.NonEmptyString),
          }),
          gatewayResponse.body,
          boundary,
        ),
      );
      if (
        !(
          gateway.compositionRevision === compositionRevision &&
          gateway.apiBaseUrl.startsWith('/shell-super-app-api/module-api/') &&
          !/[?#\\]|\/\.\.?\/|%/u.test(gateway.apiBaseUrl)
        )
      ) {
        return yield* new SymmyProofFailure(boundary, failureCodes.readAuthScope);
      }
      const result = yield* request(
        `${gateway.apiBaseUrl}/reads/${readName}`,
        'POST',
        ownerQuery,
        undefined,
        boundary,
        {
          kind: 'owner',
          revision: compositionRevision,
          token: gateway.token,
        },
      );
      if (result.status !== 200) {
        return yield* new SymmyProofFailure(boundary, failureCodes.httpStatus);
      }
      return result.body;
    }),
    read: Effect.fn('SymmyProofRead')(function* readProgram(path, boundary) {
      const result = yield* request(path, 'GET', undefined, undefined, boundary);
      if (result.status !== 200) {
        return yield* new SymmyProofFailure(boundary, failureCodes.httpStatus);
      }
      return result.body;
    }),
    settle: Effect.fn('SymmyProofSettle')(function* settleProgram(result, expected, boundary) {
      if (result.status === 200) {
        return yield* Effect.fromResult(assertAcceptedEffects(result.body, expected, boundary));
      }
      const admission = yield* Effect.fromResult(decode(AdmissionSchema, result.body, boundary));
      let lastJob: SymmySafeFailureBody | undefined;
      while (true) {
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* new SymmyProofFailure(boundary, failureCodes.timeout, 200, lastJob);
        }
        const job = yield* Effect.fromResult(
          decode(JobSchema, yield* client.read(`${PREFIX}/jobs/${admission.jobId}`, boundary), boundary),
        );
        if (job.jobId !== admission.jobId) {
          return yield* new SymmyProofFailure(boundary, failureCodes.jobIdentity);
        }
        if (job.status === 'completed_all') {
          return yield* Effect.fromResult(assertAcceptedEffects(job, expected, boundary));
        }
        const counts = effectDiagnostic(job.items ?? []);
        if (counts.kind !== 'effects') {
          return yield* new SymmyProofFailure(boundary, failureCodes.unexpected);
        }
        lastJob = { ...counts, kind: 'job', status: job.status };
        if (job.status === 'completed_partial' || job.status === 'completed_none') {
          return yield* new SymmyProofFailure(boundary, failureCodes.jobTerminal, 200, lastJob);
        }
        yield* Effect.sleep(Math.min(pollMs, yield* remaining(boundary)));
      }
    }),
    waitUntil: Effect.fn('SymmyProofWaitUntil')(function* waitUntilProgram(instant, boundary) {
      const target = DateTime.toEpochMillis(
        yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(instant).pipe(
          Effect.mapError(
            (cause) =>
              new SymmyProofFailure(boundary, failureCodes.inputContract, undefined, undefined, Redacted.make(cause)),
          ),
        ),
      );
      while ((yield* Clock.currentTimeMillis) < target) {
        yield* Effect.sleep(Math.min(target - (yield* Clock.currentTimeMillis), yield* remaining(boundary)));
      }
      yield* remaining(boundary);
    }),
    write: Effect.fn('SymmyProofWrite')(function* writeProgram<Input>(
      path: string,
      body: Input,
      key: string,
      boundary: ProofBoundary,
    ) {
      if (!/^[A-Za-z0-9._-]{1,200}$/u.test(key)) {
        return yield* new SymmyProofFailure(boundary, failureCodes.inputContract);
      }
      return yield* request(path, 'POST', body, key, boundary);
    }),
  };
  return client;
});

const PRODUCT_EFFECTS = {
  effectsAtLeast: 3,
  itemsAtLeast: 1,
  owners: { 'commerce.catalog': 2, 'commerce.pricing': 1 },
} satisfies EffectExpectation;
export const proveSymmyProduct = Effect.fn('proveSymmyProduct')(function* proveSymmyProductProgram(
  config: SymmyProofConfig,
  suppliedClient?: SymmyProofClient,
) {
  const client = suppliedClient ?? (yield* createSymmyProofClient(config));
  const names = makeSymmyProofNames();
  const input = yield* Effect.fromResult(decode(SymmyProofInputSchema, config.input, proofBoundaries.configuration));
  const path = `${PREFIX}/admin/products?q=${encodeURIComponent(names.prefix)}&limit=100`;
  const before = yield* Effect.fromResult(
    decode(ProductPageSchema, yield* client.read(path, proofBoundaries.productUnseen), proofBoundaries.productUnseen),
  );
  if (!(before.count === 0 && before.products.length === 0)) {
    return yield* new SymmyProofFailure(proofBoundaries.productUnseen, failureCodes.notUnseen, undefined, undefined);
  }
  const effectiveFrom = DateTime.formatIso(DateTime.add(yield* DateTime.now, { milliseconds: 120_000 }));
  const baseAmount = '123.45';
  const body = {
    products: [
      {
        identifier: { type: 'erpId', value: names.product },
        lifecycle: 'ACTIVE',
        name: names.product,
        variants: [
          {
            identifier: { type: 'variantId', value: names.variant },
            prices: [{ amount: baseAmount, currencyCode: input.currencyCode, effectiveFrom }],
            sku: names.variant,
          },
        ],
      },
    ],
  };
  yield* Effect.fromResult(validatePayload(SymmyProductsBatchRequestSchema, body, proofBoundaries.productImport));
  const key = `${names.prefix}.product`;
  const original = yield* client.settle(
    yield* client.write(`${PREFIX}/products/batch`, body, key, proofBoundaries.productImport),
    PRODUCT_EFFECTS,
    proofBoundaries.productImport,
  );
  const page = yield* Effect.fromResult(
    decode(
      ProductPageSchema,
      yield* client.read(path, proofBoundaries.productReadback),
      proofBoundaries.productReadback,
    ),
  );
  if (!(page.count === 1 && page.products.length === 1)) {
    return yield* new SymmyProofFailure(proofBoundaries.productReadback, failureCodes.readback, undefined, undefined);
  }
  const [product] = page.products;
  if (product === undefined) {
    return yield* new SymmyProofFailure(proofBoundaries.productReadback, failureCodes.readback, undefined, undefined);
  }
  if (!(product.sourceRecordId === `product:erpId:${names.product}` && product.product.name === names.product)) {
    return yield* new SymmyProofFailure(proofBoundaries.productReadback, failureCodes.readback, undefined, undefined);
  }
  const [source] = product.variantSources;
  if (!(product.variantSources.length === 1 && source?.sourceRecordId === `variant:variantId:${names.variant}`)) {
    return yield* new SymmyProofFailure(proofBoundaries.productReadback, failureCodes.readback, undefined, undefined);
  }
  const variant = product.product.variants.find((item) => item.variantId === source.variantId);
  if (!(variant !== undefined && product.product.variants.length === 1)) {
    return yield* new SymmyProofFailure(proofBoundaries.productReadback, failureCodes.readback, undefined, undefined);
  }
  const replay = yield* client.settle(
    yield* client.write(`${PREFIX}/products/batch`, body, key, proofBoundaries.productReplay),
    PRODUCT_EFFECTS,
    proofBoundaries.productReplay,
  );
  yield* Effect.fromResult(assertReplayIdentity(original, replay, proofBoundaries.productReplay));
  const afterReplay = yield* Effect.fromResult(
    decode(ProductPageSchema, yield* client.read(path, proofBoundaries.productReplay), proofBoundaries.productReplay),
  );
  if (!isDeepStrictEqual(page, afterReplay)) {
    return yield* new SymmyProofFailure(proofBoundaries.productReplay, failureCodes.readback, undefined, undefined);
  }
  return {
    baseAmount,
    effectiveFrom,
    listAmount: '98.76',
    names,
    productRef: product.product.productRef,
    stockAmount: '17',
    variantRef: variant.variantRef,
  };
});
export const proveSymmyProductStockList = Effect.fn('proveSymmyProductStockList')(
  function* proveSymmyProductStockListProgram(config: SymmyProofConfig, suppliedClient?: SymmyProofClient) {
    const client = suppliedClient ?? (yield* createSymmyProofClient(config));
    const proof = yield* proveSymmyProduct(config, client);
    const { input } = config;
    const stockBody = {
      stock: [
        {
          businessObservedAt: DateTime.formatIso(yield* DateTime.now),
          itemKey: proof.names.variant,
          locationKey: input.locationKey,
          quantity: { amount: proof.stockAmount, unitRef: input.unitRef },
          revision: '1',
          sourceReference: `${proof.names.prefix}:stock:1`,
        },
      ],
    };
    yield* Effect.fromResult(validatePayload(SymmyStockBatchRequestSchema, stockBody, proofBoundaries.stockImport));
    const stockResult = yield* client.write(
      `${PREFIX}/inventory/stock/batch`,
      stockBody,
      `${proof.names.prefix}.stock`,
      proofBoundaries.stockImport,
    );
    yield* client.settle(
      stockResult,
      {
        effectsAtLeast: 1,
        itemsAtLeast: 1,
        owners: { 'commerce.inventory': 1 },
      },
      proofBoundaries.stockImport,
    );
    const stockKeys = yield* Effect.fromResult(
      decode(
        Schema.Struct({
          items: Schema.NonEmptyArray(Schema.Struct({ itemKey: itemKeySchema, locationKey: locationKeySchema })),
        }),
        stockResult.body,
        proofBoundaries.stockImport,
      ),
    );
    if (
      !(
        stockKeys.items.length === 1 &&
        stockKeys.items[0]?.itemKey === proof.names.variant &&
        stockKeys.items[0]?.locationKey === input.locationKey
      )
    ) {
      return yield* new SymmyProofFailure(proofBoundaries.stockImport, failureCodes.readback, undefined, undefined);
    }
    // The Price Group owner requires creation in the future; do not reuse the product timestamp after a slow job.
    const startsAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { milliseconds: 120_000 }));
    const listBody = {
      priceLists: [
        {
          businessCode: proof.names.list,
          code: proof.names.list,
          description: `${proof.names.prefix} acceptance price list`,
          effectiveFrom: startsAt,
          name: proof.names.list,
          purpose: `Scoped Symmy HTTP acceptance price list ${proof.names.prefix}`,
        },
      ],
    };
    yield* Effect.fromResult(
      validatePayload(SymmyPriceListsBatchRequestSchema, listBody, proofBoundaries.priceListImport),
    );
    yield* client.settle(
      yield* client.write(
        `${PREFIX}/price-lists/batch-upsert`,
        listBody,
        `${proof.names.prefix}.list`,
        proofBoundaries.priceListImport,
      ),
      { effectsAtLeast: 1, itemsAtLeast: 1, owners: { 'pricing.price-group-catalog': 1 } },
      proofBoundaries.priceListImport,
    );
    yield* client.waitUntil(startsAt, proofBoundaries.priceListReadback);
    const findList = Effect.fn('findList')(function* findListProgram(
      boundary: typeof proofBoundaries.priceListReadback | typeof proofBoundaries.listPriceReadback,
    ) {
      // Public GET /price-lists has no code/q filter. Bound the scan; never dump existing price/customer data.
      for (let offset = 0; offset < 2000; offset += 100) {
        const page = yield* Effect.fromResult(
          decode(
            PriceListsPageSchema,
            yield* client.read(`${PREFIX}/price-lists?limit=100&offset=${offset}&priceLimit=100`, boundary),
            boundary,
          ),
        );
        const matches = page.priceLists.filter((list) => list.code === proof.names.list);
        if (matches.length > 1) {
          return yield* new SymmyProofFailure(boundary, failureCodes.readback, undefined, undefined);
        }
        if (matches[0] !== undefined) {
          return matches[0];
        }
        if (offset + 100 >= page.count) {
          break;
        }
      }
      return yield* new SymmyProofFailure(boundary, failureCodes.readback);
    });
    const list = yield* findList(proofBoundaries.priceListReadback);
    if (!(list.name === proof.names.list && list.priceGroupRef.tenantId === proof.productRef.tenantId)) {
      return yield* new SymmyProofFailure(
        proofBoundaries.priceListReadback,
        failureCodes.readback,
        undefined,
        undefined,
      );
    }
    const priceBody = {
      priceGroupRef: list.priceGroupRef,
      prices: [
        {
          amount: proof.listAmount,
          commercialScope: input.commercialScope,
          currencyCode: input.currencyCode,
          effectiveFrom: startsAt,
          operation: 'DEFINE',
          productRef: proof.productRef,
          unitBasis: { quantity: '1', unitRef: input.unitRef },
          variantRef: proof.variantRef,
        },
      ],
    };
    yield* Effect.fromResult(
      validatePayload(SymmyPriceListPricesBatchRequestSchema, priceBody, proofBoundaries.listPriceImport),
    );
    const key = `${proof.names.prefix}.list-price`;
    const original = yield* client.settle(
      yield* client.write(`${PREFIX}/price-lists/prices/batch`, priceBody, key, proofBoundaries.listPriceImport),
      PRICE_EFFECTS,
      proofBoundaries.listPriceImport,
    );
    const readback = yield* findList(proofBoundaries.listPriceReadback);
    if (!(readback.prices !== undefined && readback.prices.count === 1 && readback.prices.prices.length === 1)) {
      return yield* new SymmyProofFailure(
        proofBoundaries.listPriceReadback,
        failureCodes.readback,
        undefined,
        undefined,
      );
    }
    const stored = yield* Effect.fromResult(
      assertCurrentListPrice(readback.prices.prices[0]?.price, proof, input, list.priceGroupRef, startsAt),
    );
    const replay = yield* client.settle(
      yield* client.write(`${PREFIX}/price-lists/prices/batch`, priceBody, key, proofBoundaries.listPriceImport),
      PRICE_EFFECTS,
      proofBoundaries.listPriceImport,
    );
    yield* Effect.fromResult(assertReplayIdentity(original, replay, proofBoundaries.listPriceImport));
    const after = yield* findList(proofBoundaries.listPriceReadback);
    if (
      !(
        after.prices !== undefined &&
        after.prices.count === 1 &&
        after.prices.prices.length === 1 &&
        isDeepStrictEqual(after.priceGroupRef, readback.priceGroupRef) &&
        isDeepStrictEqual(
          yield* Effect.fromResult(
            decode(CurrentPriceSchema, after.prices.prices[0]?.price, proofBoundaries.listPriceReadback),
          ),
          stored,
        )
      )
    ) {
      return yield* new SymmyProofFailure(
        proofBoundaries.listPriceReadback,
        failureCodes.readback,
        undefined,
        undefined,
      );
    }
    return { ...proof, priceGroupRef: list.priceGroupRef };
  },
);

/**
 * Explicit adapter contract for worker endpoints not present in the original public Symmy surface.
 * The parent supplies documented paths and JSON pointers, not a boolean "passed" callback.
 * Each read must contain exactly one record matching ALL proof-owned expected fields.
 * `recordsPointer: ''` accepts a single root object or root array.
 */
export interface SymmyRecordRead<Field extends string> {
  readonly fields: Readonly<Record<Field, string>>;
  readonly path: string;
  readonly recordsPointer: string;
}
const atPointer = (value: Schema.Json, pointer: string, boundary: ProofBoundary) =>
  Result.gen(function* atPointerProgram() {
    if (!(pointer === '' || /^\/(?:[^~]|~[01])*$/u.test(pointer))) {
      return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.inputContract, undefined, undefined));
    }
    let current = value;
    for (const part of pointer === '' ? [] : pointer.slice(1).split('/')) {
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!(Predicate.isObjectKeyword(current) && Object.hasOwn(current, key))) {
        return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.readback, undefined, undefined));
      }
      // JSON arrays expose their own numeric elements and length; no prototype properties are followed.
      let entry: Schema.Json | undefined;
      if (EffectArray.isArray<Schema.Json>(current)) {
        entry = key === 'length' ? current.length : current[Number(key)];
      } else {
        entry = current[key];
      }
      if (entry === undefined) {
        return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.readback, undefined, undefined));
      }
      current = entry;
    }
    return current;
  });
/** Pure assertion helper. Never includes the failed value/pointer in an exception. */
export const assertRecordReadback = <Field extends string, Input>(
  response: Input,
  read: Pick<SymmyRecordRead<Field>, 'recordsPointer' | 'fields'>,
  expected: Readonly<Record<Field, Schema.Json | undefined>>,
  boundary: ProofBoundary,
  decimalFields: readonly Field[] = [],
) =>
  Result.gen(function* assertRecordReadbackProgram() {
    const selected = yield* atPointer(yield* decode(Schema.Json, response, boundary), read.recordsPointer, boundary);
    const rows = EffectArray.isArray<Schema.Json>(selected) ? selected : [selected];
    const entries = Object.entries(expected);
    if (entries.length <= 0) {
      return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.inputContract, undefined, undefined));
    }
    const decimalNames = new Set<string>(decimalFields);
    let matches = 0;
    for (const row of rows) {
      let match = true;
      for (const [field, value] of entries) {
        const pointer = Object.entries(read.fields).find(([name]) => name === field)?.[1];
        if (!Schema.is(Schema.String)(pointer)) {
          return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.inputContract, undefined, undefined));
        }
        const observed = yield* atPointer(row, pointer, boundary);
        if (!(decimalNames.has(field) ? decimalEqual(observed, value) : isDeepStrictEqual(observed, value))) {
          match = false;
        }
      }
      if (match) {
        matches += 1;
      }
    }
    if (matches !== 1) {
      return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.readback, undefined, undefined));
    }

    return yield* Result.void;
  });
const CustomerPageSchema = Schema.Struct({
  count: Schema.Int,
  customers: Schema.Array(
    Schema.Struct({
      party: Schema.Struct({
        businessName: Schema.OptionFromNullOr(Schema.String),
        contactPoints: Schema.Array(Schema.Struct({ normalizedValue: text, type: text })),
        firstName: Schema.OptionFromNullOr(Schema.String),
        lastName: Schema.OptionFromNullOr(Schema.String),
        outcome: Schema.Literal('AVAILABLE'),
        partyType: Schema.Literals(['PERSON', 'ORGANIZATION']),
      }),
      partyRef: RefSchema,
      profile: Schema.Struct({
        profileRef: Schema.Struct({
          ...RefSchema.fields,
          kind: Schema.Literals(['RETAIL', 'COUNTERPARTY']),
        }),
        subject: Schema.Union([
          Schema.Struct({ kind: Schema.Literal('RETAIL'), partyRef: RefSchema, sellingLegalEntityRef: RefSchema }),
          Schema.Struct({
            counterpartyRef: RefSchema,
            kind: Schema.Literal('COUNTERPARTY'),
            sellingLegalEntityRef: Schema.optionalKey(RefSchema),
          }),
        ]),
      }),
      sourceRecordId: sourceRecordIdSchema,
    }),
  ),
});
export interface SymmyCustomerProof {
  readonly customerId: string;
  readonly kind: 'PERSON' | 'ORGANIZATION';
  readonly partyRef: ProofRef;
  readonly profileId: string;
  readonly profileRef: ProofRef;
  readonly subject: (typeof CustomerPageSchema.Encoded.customers)[number]['profile']['subject'];
}
export interface SymmyCustomerFixture {
  readonly label: string;
  readonly postalAddress: {
    readonly addressLine1: string;
    readonly city: string;
    readonly countryCode: string;
    readonly postalCode: string;
  };
  readonly purposes: readonly ['BILLING', 'DELIVERY'];
}
export interface SymmyFullProofContext {
  readonly address: SymmyCustomerFixture;
  readonly customers: readonly [SymmyCustomerProof, SymmyCustomerProof];
  readonly names: SymmyProofNames;
}
export interface SymmyOrderExportWiring {
  readonly collectionPath: string;
  readonly detailPath: (id: string) => string;
  readonly expectedOrderIds: readonly [string, ...string[]];
}
const CUSTOMER_EFFECTS = {
  effectsAtLeast: 11,
  owners: { 'commerce.customer-context': 4, 'party.registry': 7 },
};
const proofContacts = (id: string) => [
  { preferred: true, type: 'EMAIL', value: `${id.toLowerCase()}@example.invalid` },
  // NANP 202-555-0100..0199 is reserved for fictional use; no message/call is sent.
  { preferred: false, type: 'PHONE', value: '+12025550123' },
];
export const proveCustomers = Effect.fn('proveCustomers')(function* proveCustomersProgram(
  config: SymmyProofConfig,
  client: SymmyProofClient,
  names: SymmyProofNames,
) {
  const proof = { names };
  const address: SymmyCustomerFixture = {
    label: `${proof.names.prefix}_ADDRESS`,
    postalAddress: {
      addressLine1: 'Acceptance fixture 1',
      city: 'Test City',
      countryCode: 'CZ',
      postalCode: '11000',
    },
    purposes: ['BILLING', 'DELIVERY'],
  };

  const body = {
    customers: [
      {
        addresses: [address],
        businessName: proof.names.organization,
        contacts: proofContacts(proof.names.organization),
        customerId: proof.names.organization,
        kind: 'ORGANIZATION',
      },
      {
        addresses: [address],
        contacts: proofContacts(proof.names.person),
        customerId: proof.names.person,
        firstName: proof.names.prefix,
        kind: 'PERSON',
        lastName: 'Acceptance',
      },
    ],
  };
  const expected = { ...CUSTOMER_EFFECTS, itemsAtLeast: body.customers.length } satisfies EffectExpectation;
  yield* Effect.fromResult(validatePayload(SymmyCustomersBatchRequestSchema, body, proofBoundaries.customerImport));
  const key = `${proof.names.prefix}.customers`;
  const original = yield* client.settle(
    yield* client.write(`${PREFIX}/customers/batch`, body, key, proofBoundaries.customerImport),
    expected,
    proofBoundaries.customerImport,
  );
  const read = Effect.fn('read')(function* readProgram() {
    return yield* Effect.fromResult(
      decode(
        CustomerPageSchema,
        yield* client.read(
          `${PREFIX}/admin/customers?q=${encodeURIComponent(proof.names.prefix)}&limit=100`,
          proofBoundaries.customerReadback,
        ),
        proofBoundaries.customerReadback,
      ),
    );
  });
  const page = yield* read();
  if (!(page.count === 2 && page.customers.length === 2)) {
    return yield* new SymmyProofFailure(proofBoundaries.customerReadback, failureCodes.readback, undefined, undefined);
  }
  const customer = (id: string, kind: 'PERSON' | 'ORGANIZATION') =>
    Result.gen(function* customerProgram() {
      const matches = page.customers.filter((item) => item.sourceRecordId === id);
      const [item] = matches;
      if (!(matches.length === 1 && item !== undefined)) {
        return yield* Result.fail(
          new SymmyProofFailure(proofBoundaries.customerReadback, failureCodes.readback, undefined, undefined),
        );
      }
      if (
        !(
          item.party.partyType === kind &&
          item.partyRef.tenantId === config.input.unitRef.tenantId &&
          item.profile.profileRef.kind === (kind === 'PERSON' ? 'RETAIL' : 'COUNTERPARTY') &&
          (kind === 'ORGANIZATION'
            ? Option.contains(item.party.businessName, proof.names.organization)
            : Option.contains(item.party.firstName, proof.names.prefix) &&
              Option.contains(item.party.lastName, 'Acceptance'))
        )
      ) {
        return yield* Result.fail(
          new SymmyProofFailure(proofBoundaries.customerReadback, failureCodes.readback, undefined, undefined),
        );
      }
      for (const contact of proofContacts(id)) {
        if (
          item.party.contactPoints.filter(
            (point) => point.type === contact.type && point.normalizedValue === contact.value,
          ).length !== 1
        ) {
          return yield* Result.fail(
            new SymmyProofFailure(proofBoundaries.customerReadback, failureCodes.readback, undefined, undefined),
          );
        }
      }
      const { kind: _profileKind, ...profileRef } = item.profile.profileRef;
      return {
        customerId: id,
        kind,
        partyRef: item.partyRef,
        profileId: profileRef.resourceId,
        profileRef,
        subject: item.profile.subject,
      };
    });
  const customers: SymmyFullProofContext['customers'] = [
    yield* Effect.fromResult(customer(proof.names.organization, 'ORGANIZATION')),
    yield* Effect.fromResult(customer(proof.names.person, 'PERSON')),
  ];
  const replay = yield* client.settle(
    yield* client.write(`${PREFIX}/customers/batch`, body, key, proofBoundaries.customerReplay),
    expected,
    proofBoundaries.customerReplay,
  );
  yield* Effect.fromResult(assertReplayIdentity(original, replay, proofBoundaries.customerReplay));
  if (!isDeepStrictEqual(page, yield* read())) {
    return yield* new SymmyProofFailure(proofBoundaries.customerReplay, failureCodes.readback, undefined, undefined);
  }
  return { address, customers, names };
});
const orderFields = SymmyDemoOrderSchema.fields;
const lineFields = orderFields.lines.value.fields;
const OrderSchema = Schema.Struct({
  currencyCode: orderFields.currencyCode,
  id: text,
  lines: Schema.NonEmptyArray(
    Schema.Struct({
      productId: productIdSchema,
      quantity: lineFields.quantity,
      sku: text,
      totalMinor: lineFields.totalMinor,
      totalVatMinor: lineFields.totalVatMinor,
      unitPriceMinor: lineFields.unitPriceMinor,
      vatRate: lineFields.vatRate,
    }),
  ),
  number: text,
  pricesIncludeVat: orderFields.pricesIncludeVat,
  shipping: orderFields.shipping,
  totalMinor: orderFields.totalMinor,
  totalNetMinor: orderFields.totalNetMinor,
  totalVatMinor: orderFields.totalVatMinor,
});
/** Pure check of persisted monetary snapshots; PII fields are deliberately not part of this decoder. */
export const assertOrderSnapshots = <Input,>(body: Input) =>
  Result.gen(function* assertOrderSnapshotsProgram() {
    const orders = yield* decode(Schema.Array(OrderSchema), body, proofBoundaries.orderExport);
    if (!(orders.length > 0 && new Set(orders.map((order) => order.id)).size === orders.length)) {
      return yield* Result.fail(
        new SymmyProofFailure(proofBoundaries.orderExport, failureCodes.readback, undefined, undefined),
      );
    }
    for (const order of orders) {
      const totals = fullOrderTotals(order);
      if (
        !(
          order.totalMinor === totals.totalMinor &&
          order.totalVatMinor === totals.totalVatMinor &&
          order.totalNetMinor === totals.totalMinor - totals.totalVatMinor &&
          order.lines.every((line) => {
            const gross = lineGrossMinor(line, order.pricesIncludeVat);
            const vat = order.pricesIncludeVat ? vatInGrossMinor(gross, line.vatRate) : orderLineVatMinor(line);
            return line.totalMinor === gross && line.totalVatMinor === vat;
          })
        )
      ) {
        return yield* Result.fail(
          new SymmyProofFailure(proofBoundaries.orderExport, failureCodes.readback, undefined, undefined),
        );
      }
    }
    return orders;
  });
export const proveSymmyOrderExport = Effect.fn('proveSymmyOrderExport')(function* proveSymmyOrderExportProgram(
  client: SymmyProofClient,
  wiring: SymmyOrderExportWiring,
) {
  if (!(wiring.expectedOrderIds.length > 0 && wiring.expectedOrderIds.every(Schema.is(text)))) {
    return yield* new SymmyProofFailure(proofBoundaries.orderExport, failureCodes.inputContract, undefined, undefined);
  }
  const page = yield* Effect.fromResult(
    decode(
      Schema.Struct({ orders: Schema.Array(Schema.Unknown) }),
      yield* client.read(wiring.collectionPath, proofBoundaries.orderExport),
      proofBoundaries.orderExport,
    ),
  );
  const orders = yield* Effect.fromResult(assertOrderSnapshots(page.orders));
  for (const id of wiring.expectedOrderIds) {
    const matches = orders.filter((order) => order.id === id);
    if (matches.length !== 1) {
      return yield* new SymmyProofFailure(proofBoundaries.orderExport, failureCodes.readback, undefined, undefined);
    }
    const detail = yield* Effect.fromResult(
      decode(
        Schema.Struct({ order: Schema.Unknown }),
        yield* client.read(wiring.detailPath(id), proofBoundaries.orderExport),
        proofBoundaries.orderExport,
      ),
    );
    const [order] = yield* Effect.fromResult(assertOrderSnapshots([detail.order]));
    if (!isDeepStrictEqual(matches[0], order)) {
      return yield* new SymmyProofFailure(proofBoundaries.orderExport, failureCodes.readback, undefined, undefined);
    }
  }

  return yield* Effect.void;
});

const PNG_ONE_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const slugOf = (name: string) => name.toLowerCase().replaceAll('_', '-');
/** The real public demo contracts use native IDs and a revision fence, never engineered Catalog refs. */
export const symmyNativeCategoryPayload = (names: SymmyProofNames, expectedRevision: number) => ({
  categories: [{ code: names.category, name: names.category, published: true, slug: slugOf(names.category) }],
  expectedRevision,
});
export const symmyNativeProductPayload = (names: SymmyProofNames, expectedRevision: number) => ({
  expectedRevision,
  products: [
    {
      active: true,
      category: names.category,
      categoryCode: names.category,
      description: `${names.prefix} scoped HTTP acceptance product`,
      lowStockThreshold: 0,
      name: names.product,
      priceMinor: 12_345,
      published: true,
      sku: names.variant,
      slug: slugOf(names.product),
      stockTracked: false,
      taxClassificationCode: 'cz.vat.standard',
      unit: 'ks',
    },
  ],
});
export const symmyNativeMediaPayload = (names: SymmyProofNames, productId: string, expectedRevision: number) => ({
  expectedRevision,
  image: { filename: `${names.image}.png`, full: { contentBase64: PNG_ONE_PIXEL, height: 1, width: 1 } },
  productId,
});
export const assertNativeApplied = <Input,>(
  body: Input,
  expected: { readonly legalEntityId: string; readonly previousRevision: number; readonly tenantId: string },
  boundary: ProofBoundary,
) =>
  Result.gen(function* assertNativeAppliedProgram() {
    const result = yield* decode(SymmyDemoCatalogBatchResponseSchema, body, boundary);
    const [item] = result.items;
    if (
      !(
        result.ownerModuleId === 'demo.merchandise' &&
        result.tenantId === expected.tenantId &&
        result.legalEntityId === expected.legalEntityId &&
        result.items.length === 1 &&
        item !== undefined &&
        item.index === 0 &&
        item.outcome === 'APPLIED' &&
        item.revision === result.revision &&
        result.revision > expected.previousRevision
      )
    ) {
      return yield* Result.fail(new SymmyProofFailure(boundary, failureCodes.readback, undefined, undefined));
    }
    return { item, revision: result.revision };
  });
const NativeCatalogReadSchema = Schema.Struct({
  categories: Schema.Array(Schema.Struct({ id: text, name: text, slug: text })),
  products: Schema.Array(
    Schema.Struct({
      active: Schema.Boolean,
      categoryId: categoryIdSchema,
      currentPriceMinor: Schema.Int,
      id: text,
      images: Schema.optionalKey(Schema.Array(text)),
      name: text,
      published: Schema.Boolean,
      sku: text,
    }),
  ),
  revision: Schema.Int,
});
/** Validate the one persisted native projection, separately from revision-fenced HTTP writes. */
const assertNativeCatalogProjection = (
  state: typeof NativeCatalogReadSchema.Type,
  names: SymmyProofNames,
  categoryId: string,
  productId: string,
  image: string,
  mediaRevision: number,
) =>
  Result.gen(function* nativeCatalogProjectionProgram() {
    const [stored] = state.products;
    if (!(state.products.length === 1 && stored !== undefined)) {
      return yield* Result.fail(
        new SymmyProofFailure(proofBoundaries.productReadback, failureCodes.readback, undefined, undefined),
      );
    }
    if (
      !(
        stored.id === productId &&
        stored.name === names.product &&
        stored.sku === names.variant &&
        stored.currentPriceMinor === 12_345 &&
        stored.active &&
        stored.published &&
        stored.categoryId === categoryId &&
        state.revision >= mediaRevision
      )
    ) {
      return yield* Result.fail(
        new SymmyProofFailure(proofBoundaries.productReadback, failureCodes.readback, undefined, undefined),
      );
    }
    if (
      state.categories.filter(
        (entry) => entry.id === categoryId && entry.name === names.category && entry.slug === slugOf(names.category),
      ).length !== 1
    ) {
      return yield* Result.fail(
        new SymmyProofFailure(proofBoundaries.categoryReadback, failureCodes.readback, undefined, undefined),
      );
    }
    if (stored.images?.filter((storedImage) => storedImage === image).length !== 1) {
      return yield* Result.fail(
        new SymmyProofFailure(proofBoundaries.imageReadback, failureCodes.readback, undefined, undefined),
      );
    }
    return {
      categoryId,
      categorySlug: slugOf(names.category),
      imageId: image.slice('media:'.length),
      productId: stored.id,
      sku: names.variant,
      slug: slugOf(names.product),
    };
  });
export const proveNativeCatalog = Effect.fn('proveNativeCatalog')(function* proveNativeCatalogProgram(
  config: SymmyProofConfig,
  client: SymmyProofClient,
  names: SymmyProofNames,
) {
  const { tenantId } = config.input.unitRef;
  const legalEntityId = config.legalEntityId ?? STAGE_LEGAL_ENTITY;
  const initial = yield* Effect.fromResult(
    decode(
      SymmyDemoCatalogRevisionResponseSchema,
      yield* client.read(`${PREFIX}/catalog/revision`, proofBoundaries.categoryImport),
      proofBoundaries.categoryImport,
    ),
  );
  if (!(initial.tenantId === tenantId && initial.legalEntityId === legalEntityId)) {
    return yield* new SymmyProofFailure(proofBoundaries.categoryImport, failureCodes.readback, undefined, undefined);
  }
  const categoryBody = symmyNativeCategoryPayload(names, initial.revision);
  yield* Effect.fromResult(
    validatePayload(SymmyDemoCategoriesBatchRequestSchema, categoryBody, proofBoundaries.categoryImport),
  );
  const categoryResult = yield* client.write(
    `${PREFIX}/categories/batch`,
    categoryBody,
    `${names.prefix}.native-category`,
    proofBoundaries.categoryImport,
  );
  if (categoryResult.status !== 200) {
    return yield* new SymmyProofFailure(proofBoundaries.categoryImport, failureCodes.httpStatus, undefined, undefined);
  }
  const category = yield* Effect.fromResult(
    assertNativeApplied(
      categoryResult.body,
      {
        legalEntityId,
        previousRevision: initial.revision,
        tenantId,
      },
      proofBoundaries.categoryImport,
    ),
  );
  const productBody = symmyNativeProductPayload(names, category.revision);
  yield* Effect.fromResult(
    validatePayload(SymmyDemoProductsBatchRequestSchema, productBody, proofBoundaries.productImport),
  );
  const productResult = yield* client.write(
    `${PREFIX}/catalog/products/batch`,
    productBody,
    `${names.prefix}.native-product`,
    proofBoundaries.productImport,
  );
  if (productResult.status !== 200) {
    return yield* new SymmyProofFailure(proofBoundaries.productImport, failureCodes.httpStatus, undefined, undefined);
  }
  const product = yield* Effect.fromResult(
    assertNativeApplied(
      productResult.body,
      {
        legalEntityId,
        previousRevision: category.revision,
        tenantId,
      },
      proofBoundaries.productImport,
    ),
  );
  const mediaBody = symmyNativeMediaPayload(names, product.item.entityId, product.revision);
  yield* Effect.fromResult(validatePayload(SymmyDemoMediaUploadRequestSchema, mediaBody, proofBoundaries.imageImport));
  const mediaResult = yield* client.write(
    `${PREFIX}/products/media`,
    mediaBody,
    `${names.prefix}.native-media`,
    proofBoundaries.imageImport,
  );
  if (mediaResult.status !== 200) {
    return yield* new SymmyProofFailure(proofBoundaries.imageImport, failureCodes.httpStatus, undefined, undefined);
  }
  const media = yield* Effect.fromResult(
    assertNativeApplied(
      mediaResult.body,
      {
        legalEntityId,
        previousRevision: product.revision,
        tenantId,
      },
      proofBoundaries.imageImport,
    ),
  );
  if (
    !(
      media.item.entityId === product.item.entityId &&
      media.item.image !== undefined &&
      /^media:[0-9a-f-]{36}$/u.test(media.item.image)
    )
  ) {
    return yield* new SymmyProofFailure(proofBoundaries.imageImport, failureCodes.readback, undefined, undefined);
  }
  const state = yield* Effect.fromResult(
    decode(
      NativeCatalogReadSchema,
      yield* client.ownerRead(
        'merchandise/records',
        {
          view: { includeCategories: true, limit: 1, ordersLimit: 0, productIds: [product.item.entityId] },
        },
        proofBoundaries.imageReadback,
      ),
      proofBoundaries.imageReadback,
    ),
  );
  return yield* Effect.fromResult(
    assertNativeCatalogProjection(
      state,
      names,
      category.item.entityId,
      product.item.entityId,
      media.item.image,
      media.revision,
    ),
  );
});
export const proveOwnerStock = Effect.fn('proveOwnerStock')(function* proveOwnerStockProgram(
  config: SymmyProofConfig,
  client: SymmyProofClient,
  context: SymmyCommerceProof,
) {
  const source = yield* Effect.fromResult(
    decode(SymmyProofStockSourceSchema, config.stockSource ?? AKROS_STAGE_STOCK_SOURCE, proofBoundaries.configuration),
  );
  const page = yield* Effect.fromResult(
    decode(
      CatalogVariantOnHandPageResponseSchema,
      yield* client.ownerRead(
        'inventory/catalog-variant-on-hand-page',
        { customerConfigurationId: source.customerConfigurationId, variantRefs: [context.variantRef] },
        proofBoundaries.stockReadback,
      ),
      proofBoundaries.stockReadback,
    ),
  );
  const [item] = page.items;
  if (
    !(
      page.items.length === 1 &&
      item !== undefined &&
      item.outcome === 'ON_HAND' &&
      isDeepStrictEqual(item.variantRef, context.variantRef) &&
      page.backend.backendId === source.issuer.backendId &&
      page.backend.kind === source.issuer.backendKind &&
      item.positions.length === 1 &&
      decimalEqual(item.total.amount, context.stockAmount) &&
      isDeepStrictEqual(item.stockItem.unitRef, config.input.unitRef)
    )
  ) {
    return yield* new SymmyProofFailure(proofBoundaries.stockReadback, failureCodes.readback, undefined, undefined);
  }
  const [position] = item.positions;
  if (position === undefined) {
    return yield* new SymmyProofFailure(proofBoundaries.stockReadback, failureCodes.readback, undefined, undefined);
  }
  const { evidence } = yield* Effect.fromResult(
    decode(
      CurrentStockEvidenceForAvailabilityResponseSchema,
      yield* client.ownerRead(
        'inventory/current-stock-evidence-for-availability',
        { positionRef: position.positionRef },
        proofBoundaries.stockReadback,
      ),
      proofBoundaries.stockReadback,
    ),
  );
  const { sourceEvidence } = evidence;
  if (
    !(
      evidence.position.lifecycle === 'CURRENT' &&
      isDeepStrictEqual(evidence.position.ref, position.positionRef) &&
      isDeepStrictEqual(evidence.binding.catalogSelection, {
        productRef: context.productRef,
        variantRef: context.variantRef,
      }) &&
      isDeepStrictEqual(evidence.position.scope.stockLocationRef, position.stockLocation.ref) &&
      isDeepStrictEqual(evidence.position.scope.stockItemRef, item.stockItem.stockItemRef)
    )
  ) {
    return yield* new SymmyProofFailure(proofBoundaries.stockReadback, failureCodes.readback, undefined, undefined);
  }
  if (
    !Match.value(sourceEvidence).pipe(
      Match.tag('EXTERNAL_SOURCE_ASSERTION', (external) =>
        Match.value(external.evaluation).pipe(
          Match.tag(
            'DETERMINATE',
            (evaluation) =>
              !evaluation.reconciliationRequired &&
              decimalEqual(evaluation.postEffectOnHand.amount, context.stockAmount) &&
              isDeepStrictEqual(evaluation.postEffectOnHand.unitRef, config.input.unitRef) &&
              isDeepStrictEqual(evaluation.assertion.positionRef, position.positionRef) &&
              isDeepStrictEqual(evaluation.assertion.issuer, source.issuer) &&
              evaluation.assertion.customerConfigurationId === source.customerConfigurationId &&
              evaluation.assertion.itemExternalKey.externalValue === context.names.variant &&
              evaluation.assertion.itemExternalKey.namespace === source.namespace &&
              evaluation.assertion.itemExternalKey.externalScope === source.externalScope &&
              evaluation.assertion.locationExternalKey.externalValue === config.input.locationKey &&
              decimalEqual(evaluation.assertion.quantity.amount, context.stockAmount),
          ),
          Match.orElse(() => false),
        ),
      ),
      Match.orElse(() => false),
    )
  ) {
    return yield* new SymmyProofFailure(proofBoundaries.stockReadback, failureCodes.readback, undefined, undefined);
  }

  return yield* Effect.void;
});
export const proveOwnerAddresses = Effect.fn('proveOwnerAddresses')(function* proveOwnerAddressesProgram(
  client: SymmyProofClient,
  context: SymmyFullProofContext,
) {
  const { fields } = CustomerPageSchema.fields.customers.value;
  const page = yield* Effect.fromResult(
    decode(
      Schema.Struct({
        count: Schema.Int,
        customers: Schema.Array(
          Schema.Struct({
            addresses: Schema.Array(ActiveSavedAddressSchema),
            profile: fields.profile,
            sourceRecordId: fields.sourceRecordId,
          }),
        ),
      }),
      yield* client.read(
        `${PREFIX}/admin/customers?q=${encodeURIComponent(context.names.prefix)}&limit=100&fields=sourceRecordId,profile,addresses`,
        proofBoundaries.addressReadback,
      ),
      proofBoundaries.addressReadback,
    ),
  );
  if (!(page.count === 2 && page.customers.length === 2)) {
    return yield* new SymmyProofFailure(proofBoundaries.addressReadback, failureCodes.readback, undefined, undefined);
  }
  for (const customer of context.customers) {
    const matches = page.customers.filter((item) => item.sourceRecordId === customer.customerId);
    const [current] = matches;
    if (!(matches.length === 1 && current !== undefined)) {
      return yield* new SymmyProofFailure(proofBoundaries.addressReadback, failureCodes.readback, undefined, undefined);
    }
    const { kind: _kind, ...profileRef } = current.profile.profileRef;
    if (!isDeepStrictEqual(profileRef, customer.profileRef)) {
      return yield* new SymmyProofFailure(proofBoundaries.addressReadback, failureCodes.readback, undefined, undefined);
    }
    const { addresses } = current;
    const [address] = addresses;
    if (
      !(
        addresses.length === 1 &&
        address !== undefined &&
        address.label === context.address.label &&
        address.lifecycle === 'ACTIVE' &&
        address.origin.kind === 'COMMERCE_ONLY' &&
        isDeepStrictEqual(address.origin.postalAddress, context.address.postalAddress) &&
        isDeepStrictEqual(address.purposes.toSorted(), [...context.address.purposes].toSorted()) &&
        isDeepStrictEqual(address.profile.profileRef, customer.profileRef)
      )
    ) {
      return yield* new SymmyProofFailure(proofBoundaries.addressReadback, failureCodes.readback, undefined, undefined);
    }
  }

  return yield* Effect.void;
});
export const symmyCustomerGroupPayload = (names: SymmyProofNames) => ({
  customerGroups: [
    {
      businessCode: names.group,
      code: names.group,
      description: `${names.prefix} acceptance group`,
      meaningKey: `${names.prefix.toLowerCase().replaceAll('_', '-')}.customers`,
      membershipCriteria: 'Explicit ERP assignment of scoped acceptance customers',
      name: names.group,
      purpose: `Scoped Symmy HTTP acceptance group ${names.prefix}`,
    },
  ],
});
const proveOwnerGroups = Effect.fn('proveOwnerGroups')(function* proveOwnerGroupsProgram(
  client: SymmyProofClient,
  context: SymmyFullProofContext,
) {
  const groupBody = symmyCustomerGroupPayload(context.names);
  yield* Effect.fromResult(
    validatePayload(SymmyCustomerGroupsBatchRequestSchema, groupBody, proofBoundaries.groupImport),
  );
  const groupExpected = { effectsAtLeast: 1, itemsAtLeast: 1, owners: { 'commerce.customer-context': 1 } };
  const groupKey = `${context.names.prefix}.group`;
  const group = yield* client.settle(
    yield* client.write(`${PREFIX}/customer-groups/batch`, groupBody, groupKey, proofBoundaries.groupImport),
    groupExpected,
    proofBoundaries.groupImport,
  );
  const groupReplay = yield* client.settle(
    yield* client.write(`${PREFIX}/customer-groups/batch`, groupBody, groupKey, proofBoundaries.groupReplay),
    groupExpected,
    proofBoundaries.groupReplay,
  );
  yield* Effect.fromResult(assertReplayIdentity(group, groupReplay, proofBoundaries.groupReplay));
  const path = `${PREFIX}/customer-groups/${encodeURIComponent(context.names.group)}/customers/batch`;
  const body = { customers: context.customers.map(({ customerId }) => ({ customerId })) };
  yield* Effect.fromResult(
    validatePayload(SymmyGroupCustomersBatchRequestSchema, body, proofBoundaries.groupAssignment),
  );
  const expected = { effectsAtLeast: 2, itemsAtLeast: 2, owners: { 'commerce.customer-context': 2 } };
  const key = `${context.names.prefix}.assignment`;
  const original = yield* client.settle(
    yield* client.write(path, body, key, proofBoundaries.groupAssignment),
    expected,
    proofBoundaries.groupAssignment,
  );
  const readMemberships = Effect.fn('readMemberships')(function* readMembershipsProgram() {
    const identities = [];
    for (const customer of context.customers) {
      const profile = {
        profileKind: customer.kind === 'PERSON' ? 'RETAIL' : 'COUNTERPARTY',
        profileRef: customer.profileRef,
      };
      const response = yield* Effect.fromResult(
        decode(
          EffectiveCustomerGroupMembershipsResponseSchema,
          yield* client.ownerRead(
            'commerce-customer-context/effective-customer-group-memberships',
            { asOf: DateTime.formatIso(yield* DateTime.now), profile },
            proofBoundaries.groupReadback,
          ),
          proofBoundaries.groupReadback,
        ),
      );
      const [membership] = response.items;
      if (
        !(
          response.items.length === 1 &&
          membership !== undefined &&
          membership.state === 'VALID' &&
          isDeepStrictEqual(membership.profile.profileRef, customer.profileRef)
        )
      ) {
        return yield* new SymmyProofFailure(proofBoundaries.groupReadback, failureCodes.readback, undefined, undefined);
      }
      const { group: stored } = yield* Effect.fromResult(
        decode(
          CustomerGroupDetailResponseSchema,
          yield* client.ownerRead(
            'commerce-customer-context/customer-group-detail',
            { groupRef: membership.groupRef },
            proofBoundaries.groupReadback,
          ),
          proofBoundaries.groupReadback,
        ),
      );
      if (
        !(
          stored.businessCode === context.names.group &&
          stored.currentDefinition.name === context.names.group &&
          stored.currentState === 'ACTIVE'
        )
      ) {
        return yield* new SymmyProofFailure(proofBoundaries.groupReadback, failureCodes.readback, undefined, undefined);
      }
      identities.push({
        groupRef: stored.groupRef,
        membershipRef: membership.membershipRef,
        profileRef: customer.profileRef,
      });
    }
    return identities;
  });
  const before = yield* readMemberships();
  const replay = yield* client.settle(
    yield* client.write(path, body, key, proofBoundaries.groupReplay),
    expected,
    proofBoundaries.groupReplay,
  );
  yield* Effect.fromResult(assertReplayIdentity(original, replay, proofBoundaries.groupReplay));
  if (!isDeepStrictEqual(before, yield* readMemberships())) {
    return yield* new SymmyProofFailure(proofBoundaries.groupReplay, failureCodes.readback, undefined, undefined);
  }
  yield* client.settle(
    yield* client.write(path, body, `${key}.source-replay`, proofBoundaries.groupReplay),
    expected,
    proofBoundaries.groupReplay,
  );
  if (!isDeepStrictEqual(before, yield* readMemberships())) {
    return yield* new SymmyProofFailure(proofBoundaries.groupReplay, failureCodes.readback, undefined, undefined);
  }

  return yield* Effect.void;
});
export interface SymmyStageProofOptions {
  /** Optional known existing order IDs; otherwise prove up to three actual IDs returned by the public list. */
  readonly expectedOrderIds?: readonly string[];
}

export interface SymmyNativeProofResult {
  readonly categoryId: string;
  readonly categorySlug: string;
  readonly imageId: string;
  readonly productId: string;
  readonly sku: string;
  readonly slug: string;
}
const NativeResultSchema = Schema.Struct({
  categoryId: categoryIdSchema,
  categorySlug: text,
  imageId: text.pipe(Schema.brand('NativeImageId')),
  productId: productIdSchema,
  sku: text,
  slug: text,
});
export const symmyNativeResultLine = (result: SymmyNativeProofResult) =>
  Result.gen(function* symmyNativeResultLineProgram() {
    const safe = {
      categoryId: result.categoryId,
      categorySlug: result.categorySlug,
      imageId: result.imageId,
      productId: result.productId,
      sku: result.sku,
      slug: result.slug,
    };
    if (!Object.values(safe).every((value) => /^[A-Za-z0-9._:-]{1,300}$/u.test(value))) {
      return yield* Result.fail(
        new SymmyProofFailure(proofBoundaries.imageReadback, failureCodes.readback, undefined, undefined),
      );
    }
    return `RESULT native-catalog ${Result.getOrThrow(Schema.encodeUnknownResult(Schema.fromJsonString(NativeResultSchema))(safe))}`;
  });

export const symmyProofFailureLine = <Input,>(error: Input): string =>
  Schema.is(SymmyProofFailure)(error) ? error.message : 'FAIL full-proof:unexpected';
/** Starts every disjoint lane, reports each settlement, and never rejects while another lane is still running. */
export const runSymmyProofLanes = Effect.fn('SymmyProofLanes')(function* runSymmyProofLanesProgram(
  lanes: readonly { readonly name: SymmyProofLaneName; readonly run: () => Effect.Effect<void, SymmyProofFailure> }[],
  report: (line: string) => Effect.Effect<void>,
) {
  const settled = yield* Effect.forEach(
    lanes,
    (lane) =>
      Effect.exit(
        lane.run().pipe(
          Effect.tap(() => report(`PASS lane:${lane.name}`)),
          Effect.tapCause((cause) => report(`FAIL lane:${lane.name} ${symmyProofFailureLine(Cause.squash(cause))}`)),
        ),
      ),
    { concurrency: 'unbounded' },
  );
  const failed = lanes
    .filter((_lane, index) => {
      const exit = settled[index];
      return exit !== undefined && Exit.isFailure(exit);
    })
    .map((lane) => lane.name);
  if (failed.length > 0) {
    return yield* new SymmyProofFailure(
      proofBoundaries.fullProof,
      failureCodes.laneFailed,
      undefined,
      { failed, kind: 'lanes' },
      Redacted.make(settled),
    );
  }

  return yield* Effect.void;
});
/** Complete executable stage proof: all writes use public Symmy bodies, all extra owner calls are registered Reads. */
export const proveSymmyFullFunction = Effect.fn('proveSymmyFullFunction')(function* proveSymmyFullFunctionProgram(
  config: SymmyProofConfig,
  options: SymmyStageProofOptions = {},
  pass: (boundary: ProofBoundary) => Effect.Effect<void> = (boundary) => Console.log(`PASS ${boundary}`),
  report: (line: string) => Effect.Effect<void> = Console.log,
) {
  yield* Effect.fromResult(decode(SymmyProofInputSchema, config.input, proofBoundaries.configuration));
  yield* Effect.fromResult(
    decode(SymmyProofStockSourceSchema, config.stockSource ?? AKROS_STAGE_STOCK_SOURCE, proofBoundaries.configuration),
  );
  const client = yield* createSymmyProofClient(config);
  if (!Redacted.isRedacted(config.operatorCookie)) {
    return yield* new SymmyProofFailure(
      proofBoundaries.configuration,
      failureCodes.readAuthRequired,
      undefined,
      undefined,
    );
  }
  // Verify the new endpoints, existing orders and staff read permission before the first test write.
  yield* Effect.fromResult(
    decode(
      SymmyDemoCatalogRevisionResponseSchema,
      yield* client.read(`${PREFIX}/catalog/revision`, proofBoundaries.categoryImport),
      proofBoundaries.categoryImport,
    ),
  );
  const orderPage = yield* Effect.fromResult(
    decode(
      Schema.Struct({ orders: Schema.Array(Schema.Unknown) }),
      yield* client.read(`${PREFIX}/orders?limit=100&offset=0`, proofBoundaries.orderExport),
      proofBoundaries.orderExport,
    ),
  );
  const actualOrders = yield* Effect.fromResult(assertOrderSnapshots(orderPage.orders));
  const ids = options.expectedOrderIds ?? actualOrders.slice(0, 3).map((order) => order.id);
  const [first, ...rest] = ids;
  if (first === undefined) {
    return yield* new SymmyProofFailure(proofBoundaries.orderExport, failureCodes.readback, undefined, undefined);
  }
  const orderWiring: SymmyOrderExportWiring = {
    collectionPath: `${PREFIX}/orders?limit=100&offset=0`,
    detailPath: (id) => `${PREFIX}/orders/${encodeURIComponent(id)}`,
    expectedOrderIds: [first, ...rest],
  };
  yield* client.ownerRead(
    'merchandise/records',
    {
      view: { limit: 0, ordersLimit: 0, summary: true },
    },
    proofBoundaries.categoryReadback,
  );
  yield* runSymmyProofLanes(
    [
      {
        name: 'commerce',
        run: Effect.fn('run')(function* runProgram() {
          const commerce = yield* proveSymmyProductStockList(config, client);
          yield* report(
            `RESULT commerce ${Result.getOrThrow(Schema.encodeResult(Schema.fromJsonString(Schema.Struct({ sku: text })))({ sku: commerce.names.variant }))}`,
          );
          yield* pass(proofBoundaries.productReplay);
          yield* pass(proofBoundaries.listPriceReadback);
          const sku = yield* Effect.fromResult(
            decode(
              SkuLookupResponseSchema,
              yield* client.ownerRead(
                'catalog/sku-lookup',
                { code: commerce.names.variant },
                proofBoundaries.skuReadback,
              ),
              proofBoundaries.skuReadback,
            ),
          );
          if (
            !Match.value(sku).pipe(
              Match.tag(
                'found',
                (found) =>
                  found.state === 'CURRENT' &&
                  found.displayCode === commerce.names.variant &&
                  found.target.kind === 'VARIANT' &&
                  found.target.variantId === commerce.variantRef.resourceId &&
                  found.target.tenantId === commerce.variantRef.tenantId,
              ),
              Match.orElse(() => false),
            )
          ) {
            return yield* new SymmyProofFailure(
              proofBoundaries.skuReadback,
              failureCodes.readback,
              undefined,
              undefined,
            );
          }
          yield* pass(proofBoundaries.skuReadback);
          yield* proveOwnerStock(config, client, commerce);
          yield* pass(proofBoundaries.stockReadback);
          // Catalog page pricing evaluates the owner's current instant; do not mistake a scheduled future Price for absence.
          yield* client.waitUntil(commerce.effectiveFrom, proofBoundaries.basePriceReadback);
          const prices = yield* Effect.fromResult(
            decode(
              CatalogPagePricesResponseSchema,
              yield* client.ownerRead(
                'pricing/catalog-page-prices',
                {
                  ...config.input.commercialScope,
                  currencyCode: config.input.currencyCode,
                  items: [
                    {
                      catalogSelection: { productRef: commerce.productRef, variantRef: commerce.variantRef },
                      unitBasis: { quantity: '1', unitRef: config.input.unitRef },
                    },
                  ],
                },
                proofBoundaries.basePriceReadback,
              ),
              proofBoundaries.basePriceReadback,
            ),
          );
          if (
            !Match.value(prices).pipe(
              Match.tag('CATALOG_PAGE_PRICED', (priced) => {
                const [price] = priced.prices;
                return (
                  priced.prices.length === 1 &&
                  price !== undefined &&
                  Match.value(price).pipe(
                    Match.tag(
                      'PRICE_FOUND',
                      (found) =>
                        found.priceGroupSelector.kind === 'NO_GROUP' &&
                        decimalEqual(found.priceRevision.monetaryAmount.amount, commerce.baseAmount) &&
                        found.priceRevision.monetaryAmount.currencyCode === config.input.currencyCode &&
                        isDeepStrictEqual(found.catalogSelection, {
                          productRef: commerce.productRef,
                          variantRef: commerce.variantRef,
                        }),
                    ),
                    Match.orElse(() => false),
                  )
                );
              }),
              Match.orElse(() => false),
            )
          ) {
            return yield* new SymmyProofFailure(
              proofBoundaries.basePriceReadback,
              failureCodes.readback,
              undefined,
              undefined,
            );
          }
          yield* pass(proofBoundaries.basePriceReadback);

          return yield* Effect.void;
        }),
      },
      {
        name: 'customers',
        run: Effect.fn('run')(function* runProgram() {
          const context = yield* proveCustomers(config, client, makeSymmyProofNames());
          yield* pass(proofBoundaries.customerReplay);
          yield* proveOwnerAddresses(client, context);
          yield* pass(proofBoundaries.addressReadback);
          yield* proveOwnerGroups(client, context);
          yield* pass(proofBoundaries.groupReplay);

          return yield* Effect.void;
        }),
      },
      {
        name: 'native-catalog',
        run: Effect.fn('run')(function* runProgram() {
          const result = yield* proveNativeCatalog(config, client, makeSymmyProofNames());
          const line = yield* Effect.fromResult(symmyNativeResultLine(result));
          if (
            !(
              !line.includes(Redacted.value(config.apiKey)) &&
              (config.operatorCookie === undefined || !line.includes(Redacted.value(config.operatorCookie)))
            )
          ) {
            return yield* new SymmyProofFailure(
              proofBoundaries.imageReadback,
              failureCodes.readback,
              undefined,
              undefined,
            );
          }
          yield* report(line);
          yield* pass(proofBoundaries.categoryReadback);
          yield* pass(proofBoundaries.imageReadback);

          return yield* Effect.void;
        }),
      },
      {
        name: 'orders',
        run: Effect.fn('run')(function* runProgram() {
          yield* proveSymmyOrderExport(client, orderWiring);
          yield* pass(proofBoundaries.orderExport);

          return yield* Effect.void;
        }),
      },
    ],
    report,
  );
  yield* pass(proofBoundaries.fullProof);

  return yield* Effect.void;
});
export type SymmyOwnerRead = keyof typeof OWNER_READS;
interface HttpResult {
  readonly body: Schema.Json;
  readonly status: number;
}
export interface SymmyProofClient {
  readonly ownerRead: (
    operation: SymmyOwnerRead,
    query: Schema.Json,
    boundary: ProofBoundary,
  ) => Effect.Effect<Schema.Json, SymmyProofFailure>;
  readonly read: (path: string, boundary: ProofBoundary) => Effect.Effect<Schema.Json, SymmyProofFailure>;
  readonly settle: (
    result: HttpResult,
    expected: EffectExpectation,
    boundary: ProofBoundary,
  ) => Effect.Effect<Items, SymmyProofFailure>;
  readonly waitUntil: (instant: string, boundary: ProofBoundary) => Effect.Effect<void, SymmyProofFailure>;
  readonly write: <Input>(
    path: string,
    body: Input,
    key: string,
    boundary: ProofBoundary,
  ) => Effect.Effect<HttpResult, SymmyProofFailure>;
}

const ProofEnvironmentSchema = Schema.Struct({
  SYMMY_API_KEY: Schema.optionalKey(Schema.String),
  SYMMY_API_KEY_FILE: Schema.optionalKey(Schema.String),
  SYMMY_PROOF_INPUT_JSON: Schema.optionalKey(Schema.String),
  SYMMY_PROOF_LEGAL_ENTITY_ID: Schema.optionalKey(Schema.String),
  SYMMY_PROOF_OPERATOR_COOKIE_FILE: Schema.optionalKey(Schema.String),
  SYMMY_PROOF_ORDER_IDS_JSON: Schema.optionalKey(Schema.String),
  SYMMY_PROOF_ORIGIN: Schema.optionalKey(Schema.String),
  SYMMY_PROOF_STOCK_SOURCE_JSON: Schema.optionalKey(Schema.String),
});
export type SymmyProofEnvironment = typeof ProofEnvironmentSchema.Type;
/** Environment values are consumed once; callers must not print config, fixtures, responses, or thrown causes. */
export const readSymmyProofConfig = (env: SymmyProofEnvironment): Result.Result<SymmyProofConfig, SymmyProofFailure> =>
  Result.gen(function* readSymmyProofConfigProgram() {
    const values = yield* decode(ProofEnvironmentSchema, env, proofBoundaries.configuration);
    const key = values.SYMMY_API_KEY;
    const origin = values.SYMMY_PROOF_ORIGIN ?? 'https://ontos-stage.web-revolution.cz';
    const input =
      values.SYMMY_PROOF_INPUT_JSON === undefined
        ? yield* decode(SymmyProofInputSchema, AKROS_STAGE_PROOF_INPUT, proofBoundaries.configuration)
        : yield* decode(
            Schema.fromJsonString(SymmyProofInputSchema),
            values.SYMMY_PROOF_INPUT_JSON,
            proofBoundaries.configuration,
          );
    const stockSource =
      values.SYMMY_PROOF_STOCK_SOURCE_JSON === undefined
        ? yield* decode(SymmyProofStockSourceSchema, AKROS_STAGE_STOCK_SOURCE, proofBoundaries.configuration)
        : yield* decode(
            Schema.fromJsonString(SymmyProofStockSourceSchema),
            values.SYMMY_PROOF_STOCK_SOURCE_JSON,
            proofBoundaries.configuration,
          );
    if (!(key !== undefined && key.trim().length > 0)) {
      return yield* Result.fail(
        new SymmyProofFailure(proofBoundaries.configuration, failureCodes.inputContract, undefined, undefined),
      );
    }
    yield* checkedOrigin(origin);
    return {
      apiKey: Redacted.make(key),
      input,
      legalEntityId: yield* decode(
        legalEntityIdSchema,
        values.SYMMY_PROOF_LEGAL_ENTITY_ID ?? STAGE_LEGAL_ENTITY,
        proofBoundaries.configuration,
      ),
      origin,
      stockSource,
    };
  }).pipe(
    Result.mapError(
      (cause) =>
        new SymmyProofFailure(
          proofBoundaries.configuration,
          failureCodes.inputContract,
          undefined,
          undefined,
          Redacted.make(cause),
        ),
    ),
  );

const CookieJarRowSchema = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
]);
/** Parses a curl Netscape jar without exposing it. Only live, same-origin Shell-wide cookies are selected. */
export const parseSymmyOperatorCookieJar = (
  contents: string,
  origin: string,
  nowMs = DateTime.toEpochMillis(DateTime.nowUnsafe()),
) =>
  Result.gen(function* parseSymmyOperatorCookieJarProgram() {
    const host = (yield* checkedOrigin(origin)).hostname;
    const selected: string[] = [];
    const lines = contents.split(/\r?\n/u).flatMap((line) => {
      if (line.startsWith('#HttpOnly_')) {
        return [line.slice('#HttpOnly_'.length)];
      }
      if (line.startsWith('#') || line.trim().length === 0) {
        return [];
      }
      return [line];
    });
    for (const line of lines) {
      const fields = line.split('\t');
      if (fields.length !== 7) {
        return yield* Result.fail(
          new SymmyProofFailure(proofBoundaries.configuration, failureCodes.inputContract, undefined, undefined),
        );
      }
      const [domain, subdomains, path, secure, expires, name, value] = yield* decode(
        CookieJarRowSchema,
        fields,
        proofBoundaries.configuration,
      );
      const normalizedDomain = domain.replace(/^\./u, '').toLowerCase();
      const domainMatches =
        host === normalizedDomain || (subdomains === 'TRUE' && host.endsWith(`.${normalizedDomain}`));
      const expiry = Number(expires);
      if (!(Number.isFinite(expiry) && expiry >= 0)) {
        return yield* Result.fail(
          new SymmyProofFailure(proofBoundaries.configuration, failureCodes.inputContract, undefined, undefined),
        );
      }
      // One Shell-wide cookie must cover session, composition and gateway-context.
      if (
        !domainMatches ||
        (expiry !== 0 && expiry * 1000 <= nowMs) ||
        !(path === '/' || path === '/shell-super-app-api' || path === '/shell-super-app-api/')
      ) {
        continue;
      }
      if (
        !(
          (secure === 'TRUE' || secure === 'FALSE') &&
          /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/u.test(name) &&
          value.length > 0 &&
          !value.includes(';') &&
          value.split('').every((character) => character > ' ' && character !== '\u007F')
        )
      ) {
        return yield* Result.fail(
          new SymmyProofFailure(proofBoundaries.configuration, failureCodes.inputContract, undefined, undefined),
        );
      }
      selected.push(`${name}=${value}`);
    }
    if (selected.length <= 0) {
      return yield* Result.fail(
        new SymmyProofFailure(proofBoundaries.configuration, failureCodes.readAuthRequired, undefined, undefined),
      );
    }
    return Redacted.make(selected.join('; '));
  });

const DEFAULT_LOAD_OPTIONS = { operatorReadback: false };
const ExclusiveCredentialEnvironmentSchema = ProofEnvironmentSchema.check(
  Schema.makeFilter(
    (values) =>
      !(
        values.SYMMY_API_KEY !== undefined &&
        values.SYMMY_API_KEY !== '' &&
        values.SYMMY_API_KEY_FILE !== undefined &&
        values.SYMMY_API_KEY_FILE !== ''
      ),
  ),
);
/** The FileSystem service is obtained only when the parent executes this loader, never during import. */
export const loadSymmyProofConfig = Effect.fn('SymmyProofConfiguration')(function* loadSymmyProofConfigProgram(
  env: SymmyProofEnvironment,
  options: { readonly operatorReadback: boolean } = DEFAULT_LOAD_OPTIONS,
) {
  const values = yield* Config.schema(ExclusiveCredentialEnvironmentSchema)
    .parse(ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true }))
    .pipe(
      Effect.mapError(
        (cause) =>
          new SymmyProofFailure(
            proofBoundaries.configuration,
            failureCodes.inputContract,
            undefined,
            undefined,
            Redacted.make(cause),
          ),
      ),
    );
  const fs = yield* FileSystem.FileSystem;
  const config = yield* values.SYMMY_API_KEY_FILE === undefined
    ? Effect.fromResult(readSymmyProofConfig(values))
    : fs.readFileString(values.SYMMY_API_KEY_FILE).pipe(
        Effect.mapError(
          (cause) =>
            new SymmyProofFailure(
              proofBoundaries.configuration,
              failureCodes.inputContract,
              undefined,
              undefined,
              Redacted.make(cause),
            ),
        ),
        Effect.flatMap((key) => Effect.fromResult(readSymmyProofConfig({ ...values, SYMMY_API_KEY: key.trim() }))),
      );
  if (!options.operatorReadback) {
    return config;
  }
  const file = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(values.SYMMY_PROOF_OPERATOR_COOKIE_FILE).pipe(
    Effect.mapError(
      (cause) =>
        new SymmyProofFailure(
          proofBoundaries.configuration,
          failureCodes.readAuthRequired,
          undefined,
          undefined,
          Redacted.make(cause),
        ),
    ),
  );
  const contents = yield* fs
    .readFileString(file)
    .pipe(
      Effect.mapError(
        (cause) =>
          new SymmyProofFailure(
            proofBoundaries.configuration,
            failureCodes.readAuthRequired,
            undefined,
            undefined,
            Redacted.make(cause),
          ),
      ),
    );
  const operatorCookie = yield* Effect.fromResult(parseSymmyOperatorCookieJar(contents, config.origin));
  return { ...config, operatorCookie };
});

const command = Command.make(
  'stage-symmy-full-function-proof',
  {
    commerce: Flag.Boolean('commerce'),
    full: Flag.Boolean('full'),
  },
  Effect.fn('SymmyProofCommand')(function* commandProgram(flags) {
    if (flags.commerce === flags.full) {
      return yield* new SymmyProofFailure(proofBoundaries.configuration, failureCodes.inputContract);
    }
    const env = yield* Config.schema(ProofEnvironmentSchema).pipe(
      Effect.mapError(
        (cause) =>
          new SymmyProofFailure(
            proofBoundaries.configuration,
            failureCodes.inputContract,
            undefined,
            undefined,
            Redacted.make(cause),
          ),
      ),
    );
    const config = yield* loadSymmyProofConfig(env, { operatorReadback: flags.full });
    if (flags.commerce) {
      yield* proveSymmyProductStockList(config);
      yield* Console.log('PASS product-stock-list:effects-and-list-readback');
    } else {
      const options: SymmyStageProofOptions =
        env.SYMMY_PROOF_ORDER_IDS_JSON === undefined
          ? {}
          : {
              expectedOrderIds: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.NonEmptyArray(text)))(
                env.SYMMY_PROOF_ORDER_IDS_JSON,
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new SymmyProofFailure(
                      proofBoundaries.configuration,
                      failureCodes.inputContract,
                      undefined,
                      undefined,
                      Redacted.make(cause),
                    ),
                ),
              ),
            };
      yield* proveSymmyFullFunction(config, options);
    }

    return yield* Effect.void;
  }),
);
// Explicit opt-in only. The command and its services remain inert when native tests import this file.
if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(command, { renderErrors: false, version: '1.0.0' }).pipe(
      Effect.mapError((cause) =>
        Schema.is(SymmyProofFailure)(cause)
          ? cause
          : new SymmyProofFailure(
              proofBoundaries.configuration,
              failureCodes.inputContract,
              undefined,
              undefined,
              Redacted.make(cause),
            ),
      ),
      Effect.tapCause((cause) => Console.error(symmyProofFailureLine(Cause.squash(cause)))),
      Effect.provide(NodeServices.layer),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
    ),
    { disableErrorReporting: true },
  );
}
