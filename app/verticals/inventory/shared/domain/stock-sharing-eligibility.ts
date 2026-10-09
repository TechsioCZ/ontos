import type { Effect as EffectType, Option } from 'effect';
import { Schema } from 'effect';

import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';
import { StockSharingEligibilityRefSchema } from '../resources/stock-sharing-eligibility.ts';
import type { StockSharingEligibilityUnavailable } from './stock-sharing-eligibility-unavailable.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const tenantIdSchema = StockSharingEligibilityRefSchema.fields.tenantId;
const SellingLegalEntityResourceIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('InventorySellingLegalEntityResourceId'),
);
const CommerceMarketResourceIdSchema = boundedText.pipe(Schema.brand('InventoryCommerceMarketResourceId'));
const InventoryStorefrontAppIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
).pipe(Schema.brand('InventoryStorefrontAppId'));
export const StockSharingEligibilityInstantSchema = Schema.toEncoded(Schema.DateTimeUtcFromString);

export const InventoryChannelSchema = Schema.Literals(['B2C', 'B2B']);

export const InventorySellingLegalEntityRefSchema = Schema.Struct({
  moduleId: Schema.Literal('core.identity'),
  resourceId: SellingLegalEntityResourceIdSchema,
  resourceType: Schema.Literal('core.identity.legal-entity'),
  tenantId: tenantIdSchema,
});

export const InventoryCommerceMarketRefSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.market-catalog'),
  resourceId: CommerceMarketResourceIdSchema,
  resourceType: Schema.Literal('commerce.market-catalog.market'),
  tenantId: tenantIdSchema,
});

export const InventoryStorefrontRefSchema = Schema.Struct({
  appId: InventoryStorefrontAppIdSchema,
  tenantId: tenantIdSchema,
});

/**
 * The relation subject is deliberately limited to the confirmed four dimensions. Purchasing
 * Subject, Principal, Permission, Assortment, Price Group, Cart, and operation time never enter it.
 */
export const StockSharingEligibilitySubjectSchema = Schema.Struct({
  channel: InventoryChannelSchema,
  commerceMarketRef: Schema.optionalKey(InventoryCommerceMarketRefSchema),
  sellingLegalEntityRef: InventorySellingLegalEntityRefSchema,
  storefrontRef: Schema.optionalKey(InventoryStorefrontRefSchema),
}).check(
  Schema.makeFilter(({ commerceMarketRef, sellingLegalEntityRef, storefrontRef }) => {
    const { tenantId } = sellingLegalEntityRef;
    return (commerceMarketRef === undefined || commerceMarketRef.tenantId === tenantId) &&
      (storefrontRef === undefined || storefrontRef.tenantId === tenantId)
      ? undefined
      : 'Stock Sharing Eligibility subject references must share one Tenant';
  }),
);
export type StockSharingEligibilitySubject = typeof StockSharingEligibilitySubjectSchema.Type;

export const StockSharingEligibilityScopeSchema = Schema.Struct({
  customerConfigurationId: CustomerConfigurationIdSchema,
  ownerConfigurationRef: InventoryBackendConfigurationRefSchema,
  positionRef: StockPositionRefSchema,
}).check(
  Schema.makeFilter(({ ownerConfigurationRef, positionRef }) =>
    ownerConfigurationRef.tenantId === positionRef.tenantId
      ? undefined
      : 'Stock Position and selected Inventory Backend configuration must share one Tenant',
  ),
);
export type StockSharingEligibilityScope = typeof StockSharingEligibilityScopeSchema.Type;

export const StockSharingCommerceValidationSchema = Schema.Struct({
  evidenceRef: boundedText,
  observedAt: StockSharingEligibilityInstantSchema,
  verification: Schema.Literal('OWNER_VERIFIED_CURRENT'),
});
export type StockSharingCommerceValidation = typeof StockSharingCommerceValidationSchema.Type;

export const StockSharingEligibilityEffectivePeriodSchema = Schema.Struct({
  from: StockSharingEligibilityInstantSchema,
  to: Schema.toEncoded(Schema.OptionFromNullOr(StockSharingEligibilityInstantSchema)),
}).check(
  Schema.makeFilter(({ from, to }) =>
    to === null || from < to ? undefined : 'Stock Sharing Eligibility Effective Period must be non-empty',
  ),
);

export const StockSharingEligibilitySchema = Schema.Struct({
  commerceValidation: StockSharingCommerceValidationSchema,
  effectivePeriod: StockSharingEligibilityEffectivePeriodSchema,
  lifecycle: Schema.Literals(['CURRENT', 'ENDED']),
  ref: StockSharingEligibilityRefSchema,
  revision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
  scope: StockSharingEligibilityScopeSchema,
  subject: StockSharingEligibilitySubjectSchema,
}).check(
  Schema.makeFilter((relation) => {
    const { tenantId } = relation.ref;
    if (
      relation.scope.positionRef.tenantId !== tenantId ||
      relation.scope.ownerConfigurationRef.tenantId !== tenantId ||
      relation.subject.sellingLegalEntityRef.tenantId !== tenantId
    ) {
      return 'Stock Sharing Eligibility identity, scope, and subject must share one Tenant';
    }
    return (relation.lifecycle === 'CURRENT' && relation.effectivePeriod.to === null) ||
      (relation.lifecycle === 'ENDED' && relation.effectivePeriod.to !== null)
      ? undefined
      : 'Stock Sharing Eligibility lifecycle must match its Effective Period';
  }),
);
export type StockSharingEligibility = typeof StockSharingEligibilitySchema.Type;

export const TrustedCurrentCommercePurchasingContextSchema = Schema.Struct({
  channel: InventoryChannelSchema,
  commerceMarketRef: InventoryCommerceMarketRefSchema,
  customerConfigurationId: CustomerConfigurationIdSchema,
  evidenceRef: boundedText,
  observedAt: StockSharingEligibilityInstantSchema,
  sellingLegalEntityRef: InventorySellingLegalEntityRefSchema,
  status: Schema.Literal('CURRENT_OWNER_VERIFIED'),
  storefrontRef: InventoryStorefrontRefSchema,
  tenantId: tenantIdSchema,
}).check(
  Schema.makeFilter(({ commerceMarketRef, sellingLegalEntityRef, storefrontRef, tenantId }) =>
    commerceMarketRef.tenantId === tenantId &&
    sellingLegalEntityRef.tenantId === tenantId &&
    storefrontRef.tenantId === tenantId
      ? undefined
      : 'Trusted Commerce Purchasing Context references must share one Tenant',
  ),
);
export type TrustedCurrentCommercePurchasingContext = typeof TrustedCurrentCommercePurchasingContextSchema.Type;

export const UnverifiableCommercePurchasingContextSchema = Schema.TaggedStruct('UNVERIFIABLE', {
  customerConfigurationId: CustomerConfigurationIdSchema,
  reason: Schema.Literals([
    'OWNER_EVIDENCE_MISSING',
    'OWNER_EVIDENCE_STALE',
    'OWNER_EVIDENCE_UNAVAILABLE',
    'OWNER_EVIDENCE_INDETERMINATE',
  ]),
  tenantId: tenantIdSchema,
});
export const StockSharingCommerceContextEvidenceSchema = Schema.Union([
  TrustedCurrentCommercePurchasingContextSchema,
  UnverifiableCommercePurchasingContextSchema,
]);

export class StockSharingEligibilityRejected extends Schema.TaggedError<StockSharingEligibilityRejected>()(
  'StockSharingEligibilityRejected',
  {
    code: Schema.Literal('stock_sharing_eligibility_rejected'),
    reason: Schema.Literals([
      'INVALID_RELATION',
      'TENANT_SCOPE_MISMATCH',
      'POSITION_SCOPE_MISMATCH',
      'COMMERCE_SCOPE_NOT_CURRENT',
      'COMMERCE_CONTEXT_UNVERIFIABLE',
      'RELATION_IDENTITY_CONFLICT',
      'RELATION_NOT_FOUND',
      'RELATION_NOT_CURRENT',
      'REVISION_CONFLICT',
      'INVALID_LIFECYCLE_TIME',
      'NO_APPLICABLE_CURRENT_RELATION',
      'DUPLICATE_CURRENT_RELATION',
    ]),
    relationRef: Schema.optionalKey(StockSharingEligibilityRefSchema),
  },
) {}

export type StockSharingEligibilityError = StockSharingEligibilityRejected | StockSharingEligibilityUnavailable;

export interface StockSharingEligibilityPersistence {
  readonly findByRef: (
    relationRef: StockSharingEligibility['ref'],
  ) => EffectType.Effect<Option.Option<StockSharingEligibility>, StockSharingEligibilityError>;
  readonly insertCurrent: (
    relation: StockSharingEligibility,
  ) => EffectType.Effect<StockSharingEligibility, StockSharingEligibilityError>;
  readonly listCurrent: (
    scope: StockSharingEligibilityScope,
  ) => EffectType.Effect<readonly StockSharingEligibility[], StockSharingEligibilityError>;
  readonly readHistory: (
    relationRef: StockSharingEligibility['ref'],
  ) => EffectType.Effect<readonly StockSharingEligibility[], StockSharingEligibilityError>;
  readonly saveRevision: (input: {
    readonly current: StockSharingEligibility;
    readonly next: StockSharingEligibility;
  }) => EffectType.Effect<StockSharingEligibility, StockSharingEligibilityError>;
}

export interface StockSharingCommerceScopeValidator {
  /**
   * The Commerce owner contract must prove Current tenant/configuration scope, seller + Channel,
   * Market ownership by that seller when restricted, and Current Storefront applicability when
   * restricted. Missing, stale, unavailable, or indeterminate proof fails through the typed error.
   */
  readonly validateCurrent: (
    scope: StockSharingEligibilityScope,
    subject: StockSharingEligibilitySubject,
    effectiveAt: string,
  ) => EffectType.Effect<StockSharingCommerceValidation, StockSharingEligibilityError>;
}

export const EstablishStockSharingEligibilityInputSchema = Schema.Struct({
  effectiveFrom: StockSharingEligibilityInstantSchema,
  scope: StockSharingEligibilityScopeSchema,
  subject: StockSharingEligibilitySubjectSchema,
});
export type EstablishStockSharingEligibilityInput = typeof EstablishStockSharingEligibilityInputSchema.Type;

export const ChangeStockSharingEligibilityInputSchema = Schema.Struct({
  changedAt: StockSharingEligibilityInstantSchema,
  relationRef: StockSharingEligibilityRefSchema,
  subject: StockSharingEligibilitySubjectSchema,
});
export type ChangeStockSharingEligibilityInput = typeof ChangeStockSharingEligibilityInputSchema.Type;

export const EndStockSharingEligibilityInputSchema = Schema.Struct({
  endedAt: StockSharingEligibilityInstantSchema,
  relationRef: StockSharingEligibilityRefSchema,
});
export type EndStockSharingEligibilityInput = typeof EndStockSharingEligibilityInputSchema.Type;

export const EvaluateStockSharingEligibilityInputSchema = Schema.Struct({
  context: StockSharingCommerceContextEvidenceSchema,
  scope: StockSharingEligibilityScopeSchema,
});
export type EvaluateStockSharingEligibilityInput = typeof EvaluateStockSharingEligibilityInputSchema.Type;

export const StockSharingEligibilityDecisionSchema = Schema.Struct({
  applicableRelationRefs: Schema.Array(StockSharingEligibilityRefSchema).check(Schema.isMinLength(1)),
  contextEvidenceRef: boundedText,
  outcome: Schema.Literal('ELIGIBLE'),
  positionRef: StockPositionRefSchema,
  rule: Schema.Literal('POSITIVE_CURRENT_RELATION_UNION'),
});

const sameResourceRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/** Positive-union applicability: omitted optional dimensions are wildcards, never DENY rules. */
export const commerceScopeMatchesRelation = (
  subject: StockSharingEligibilitySubject,
  context: TrustedCurrentCommercePurchasingContext,
): boolean =>
  subject.channel === context.channel &&
  sameResourceRef(subject.sellingLegalEntityRef, context.sellingLegalEntityRef) &&
  (subject.commerceMarketRef === undefined || sameResourceRef(subject.commerceMarketRef, context.commerceMarketRef)) &&
  (subject.storefrontRef === undefined ||
    (subject.storefrontRef.appId === context.storefrontRef.appId &&
      subject.storefrontRef.tenantId === context.storefrontRef.tenantId));
