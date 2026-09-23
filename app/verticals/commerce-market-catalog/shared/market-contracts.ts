import { DateTime, Schema } from 'effect';

import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';

import { MarketRefSchema } from './resources/market.ts';
import { MarketDefinitionRevisionRefSchema } from './resources/market-definition-revision.ts';
import { StorefrontAssociationRefSchema } from './resources/storefront-association.ts';

const strict = { parseOptions: { onExcessProperty: 'error' as const } };
const boundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());
const shortCode = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Z0-9][A-Z0-9_-]*$/u),
);
const positiveRevision = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const checkedUuid = Schema.String.check(Schema.isUUID());
const SellingLegalEntityResourceIdSchema = checkedUuid.pipe(
  Schema.brand('CommerceMarketSellingLegalEntityResourceId'),
  Schema.decodeTo(checkedUuid),
);
const SellingLegalEntityTenantIdSchema = checkedUuid.pipe(
  Schema.brand('CommerceMarketSellingLegalEntityTenantId'),
  Schema.decodeTo(checkedUuid),
);
const StorefrontAppIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
).pipe(
  Schema.brand('CommerceMarketStorefrontAppId'),
  Schema.decodeTo(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
      Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    ),
  ),
);
const StorefrontTenantIdSchema = checkedUuid.pipe(
  Schema.brand('CommerceMarketStorefrontTenantId'),
  Schema.decodeTo(checkedUuid),
);

export const MarketChannelSchema = Schema.Literals(['B2C', 'B2B']);

export const MarketLifecycleSchema = Schema.Literals(['ACTIVE', 'SUSPENDED', 'RETIRED']);
export type MarketLifecycle = typeof MarketLifecycleSchema.Type;

export const InitialMarketLifecycleSchema = Schema.Literals(['ACTIVE', 'SUSPENDED']);

export const SellingLegalEntityRefSchema = Schema.Struct({
  moduleId: Schema.Literal('core.identity'),
  resourceId: SellingLegalEntityResourceIdSchema,
  resourceType: Schema.Literal('core.identity.legal-entity'),
  tenantId: SellingLegalEntityTenantIdSchema,
}).annotate(strict);

export const StorefrontRefSchema = Schema.Struct({
  appId: StorefrontAppIdSchema,
  tenantId: StorefrontTenantIdSchema,
}).annotate(strict);

export const EffectivePeriodSchema = Schema.Struct({
  endsAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  startsAt: Schema.DateTimeUtcFromString,
})
  .check(
    Schema.makeFilter(({ endsAt, startsAt }) =>
      endsAt === undefined || DateTime.toEpochMillis(endsAt) > DateTime.toEpochMillis(startsAt)
        ? undefined
        : { issue: 'endsAt must be later than startsAt', path: ['endsAt'] },
    ),
  )
  .annotate(strict);
export type EffectivePeriod = typeof EffectivePeriodSchema.Type;

export const JurisdictionRefSchema = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(40), Schema.isTrimmed()),
  kind: Schema.Literals(['COUNTRY', 'REGION', 'JURISDICTION']),
}).annotate(strict);

const uniqueValues = <A>(values: readonly A[]) =>
  new Set(values).size === values.length ? undefined : 'values must be unique';
const channels = Schema.Array(MarketChannelSchema).check(Schema.isMinLength(1), Schema.makeFilter(uniqueValues));
const jurisdictions = Schema.Array(JurisdictionRefSchema).check(Schema.isMinLength(1));
const supportedLocales = Schema.Array(
  Schema.String.check(
    Schema.isMinLength(2),
    Schema.isMaxLength(35),
    Schema.isPattern(/^[a-z]{2,3}(?:-[A-Z][A-Za-z0-9]{1,7})*$/u),
  ),
).check(Schema.isMinLength(1), Schema.makeFilter(uniqueValues));

export const MarketDefinitionSchema = Schema.Struct({
  channels,
  definitionRevisionRef: MarketDefinitionRevisionRefSchema,
  effectivePeriod: EffectivePeriodSchema,
  jurisdictions,
  lifecycle: MarketLifecycleSchema,
  marketCode: shortCode,
  marketRef: MarketRefSchema,
  previousDefinitionRevisionRef: Schema.optionalKey(MarketDefinitionRevisionRefSchema),
  purpose: boundedText,
  revision: positiveRevision,
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
  supportedLocales,
})
  .check(
    Schema.makeFilter(({ definitionRevisionRef, marketRef, previousDefinitionRevisionRef, sellingLegalEntityRef }) =>
      marketRef.tenantId === sellingLegalEntityRef.tenantId &&
      definitionRevisionRef.tenantId === marketRef.tenantId &&
      (previousDefinitionRevisionRef === undefined || previousDefinitionRevisionRef.tenantId === marketRef.tenantId)
        ? undefined
        : 'Market, revisions, and Selling Legal Entity must belong to the same Tenant',
    ),
  )
  .annotate(strict);

export const AssociationProvenanceSchema = Schema.Struct({
  kind: Schema.Literals(['CONFIGURATION_ACTION', 'MIGRATION', 'ROLLBACK']),
  reference: boundedText,
}).annotate(strict);

export const StorefrontAssociationDefinitionSchema = Schema.Struct({
  associationRef: StorefrontAssociationRefSchema,
  channel: MarketChannelSchema,
  effectivePeriod: EffectivePeriodSchema,
  marketDefinitionRevisionRef: MarketDefinitionRevisionRefSchema,
  marketRef: MarketRefSchema,
  previousAssociationRevision: Schema.optionalKey(positiveRevision),
  provenance: AssociationProvenanceSchema,
  revision: positiveRevision,
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
  storefrontRef: StorefrontRefSchema,
})
  .check(
    Schema.makeFilter(
      ({ associationRef, marketDefinitionRevisionRef, marketRef, sellingLegalEntityRef, storefrontRef }) => {
        const { tenantId } = marketRef;
        return associationRef.tenantId === tenantId &&
          marketDefinitionRevisionRef.tenantId === tenantId &&
          sellingLegalEntityRef.tenantId === tenantId &&
          storefrontRef.tenantId === tenantId
          ? undefined
          : 'Association, Market revision, Market, seller, and Storefront must belong to the same Tenant';
      },
    ),
  )
  .annotate(strict);

const PurchasingSubjectTenantIdSchema = checkedUuid.pipe(
  Schema.brand('CommerceMarketPurchasingSubjectTenantId'),
  Schema.decodeTo(checkedUuid),
);
const RetailCustomerProfileResourceIdSchema = boundedText.pipe(
  Schema.brand('CommerceMarketRetailCustomerProfileResourceId'),
  Schema.decodeTo(boundedText),
);
const CounterpartyPurchasingProfileResourceIdSchema = boundedText.pipe(
  Schema.brand('CommerceMarketCounterpartyPurchasingProfileResourceId'),
  Schema.decodeTo(boundedText),
);
const CounterpartyResourceIdSchema = boundedText.pipe(
  Schema.brand('CommerceMarketCounterpartyResourceId'),
  Schema.decodeTo(boundedText),
);

const RetailCustomerProfileRefSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.customer-context'),
  resourceId: RetailCustomerProfileResourceIdSchema,
  resourceType: Schema.Literal('commerce.customer-context.retail-customer-profile'),
  tenantId: PurchasingSubjectTenantIdSchema,
}).annotate(strict);

const CounterpartyPurchasingProfileRefSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.customer-context'),
  resourceId: CounterpartyPurchasingProfileResourceIdSchema,
  resourceType: Schema.Literal('commerce.customer-context.counterparty-purchasing-profile'),
  tenantId: PurchasingSubjectTenantIdSchema,
}).annotate(strict);

const CounterpartyRefSchema = Schema.Struct({
  moduleId: Schema.Literal('party.registry'),
  resourceId: CounterpartyResourceIdSchema,
  resourceType: Schema.Literal('party.registry.counterparty'),
  tenantId: PurchasingSubjectTenantIdSchema,
}).annotate(strict);

export const PurchasingSubjectKindSchema = Schema.Literals(['GUEST', 'RETAIL_PROFILE', 'COUNTERPARTY']);

export const PurchasingSubjectRefSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('GUEST'), subjectRef: boundedText }).annotate(strict),
  Schema.Struct({
    kind: Schema.Literal('RETAIL_PROFILE'),
    profileRef: RetailCustomerProfileRefSchema,
  }).annotate(strict),
  Schema.Struct({
    counterpartyRef: CounterpartyRefSchema,
    kind: Schema.Literal('COUNTERPARTY'),
    profileRef: CounterpartyPurchasingProfileRefSchema,
  })
    .check(
      Schema.makeFilter(({ counterpartyRef, profileRef }) =>
        counterpartyRef.tenantId === profileRef.tenantId
          ? undefined
          : 'Counterparty and Purchasing Profile must belong to the same Tenant',
      ),
    )
    .annotate(strict),
]);

export const SafeSubjectRestrictionEvidenceSchema = Schema.Struct({
  decision: Schema.Literal('ALLOWED'),
  evidenceRefs: Schema.Array(boundedText).check(Schema.isMinLength(1)),
  observedAt: Schema.DateTimeUtcFromString,
  ownerRevision: boundedText,
  profileState: Schema.Literal('ACTIVE'),
  subjectKind: PurchasingSubjectKindSchema,
}).annotate(strict);

export const EligibleMarketTupleSchema = Schema.Struct({
  associationRef: StorefrontAssociationRefSchema,
  associationRevision: positiveRevision,
  channel: MarketChannelSchema,
  marketDefinitionRevisionRef: MarketDefinitionRevisionRefSchema,
  marketRef: MarketRefSchema,
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
})
  .check(
    Schema.makeFilter(({ associationRef, marketDefinitionRevisionRef, marketRef, sellingLegalEntityRef }) =>
      associationRef.tenantId === marketRef.tenantId &&
      marketDefinitionRevisionRef.tenantId === marketRef.tenantId &&
      sellingLegalEntityRef.tenantId === marketRef.tenantId
        ? undefined
        : 'Eligible tuple references must belong to the same Tenant',
    ),
  )
  .annotate(strict);
export type EligibleMarketTuple = typeof EligibleMarketTupleSchema.Type;

export const EligibleMarketTupleSetSchema = Schema.Struct({
  completenessEvidence: OwnerVerifiableSetCompletenessEvidenceSchema,
  effectiveAt: Schema.DateTimeUtcFromString,
  evaluatedAt: Schema.DateTimeUtcFromString,
  nextApplicabilityBoundary: Schema.optionalKey(Schema.DateTimeUtcFromString),
  outcome: Schema.Literal('ELIGIBLE_MARKET_TUPLES'),
  tuples: Schema.Array(EligibleMarketTupleSchema),
}).annotate(strict);
export type EligibleMarketTupleSet = typeof EligibleMarketTupleSetSchema.Type;

const resolved = Schema.Struct({
  associationRevision: positiveRevision,
  bootstrapPolicyRevision: Schema.optionalKey(boundedText),
  completenessEvidence: OwnerVerifiableSetCompletenessEvidenceSchema,
  effectiveAt: Schema.DateTimeUtcFromString,
  evaluatedAt: Schema.DateTimeUtcFromString,
  marketDefinitionRevisionRef: MarketDefinitionRevisionRefSchema,
  nextApplicabilityBoundary: Schema.optionalKey(Schema.DateTimeUtcFromString),
  outcome: Schema.Literal('MARKET_RESOLVED'),
  selectedTuple: EligibleMarketTupleSchema,
  selectionSource: Schema.Literals(['EXPLICIT', 'BOOTSTRAP_DEFAULT', 'SOLE_ELIGIBLE']),
  subjectRestrictionEvidence: Schema.optionalKey(SafeSubjectRestrictionEvidenceSchema),
})
  .check(
    Schema.makeFilter(({ associationRevision, marketDefinitionRevisionRef, selectedTuple }) =>
      associationRevision === selectedTuple.associationRevision &&
      marketDefinitionRevisionRef.resourceId === selectedTuple.marketDefinitionRevisionRef.resourceId &&
      marketDefinitionRevisionRef.tenantId === selectedTuple.marketDefinitionRevisionRef.tenantId
        ? undefined
        : 'Resolved revision evidence must match the selected eligible tuple',
    ),
  )
  .annotate(strict);

const selectionRequired = Schema.Struct({
  choices: Schema.Array(EligibleMarketTupleSchema).check(Schema.isMinLength(2)),
  completenessEvidence: OwnerVerifiableSetCompletenessEvidenceSchema,
  effectiveAt: Schema.DateTimeUtcFromString,
  evaluatedAt: Schema.DateTimeUtcFromString,
  nextApplicabilityBoundary: Schema.optionalKey(Schema.DateTimeUtcFromString),
  outcome: Schema.Literal('MARKET_SELECTION_REQUIRED'),
})
  .check(
    Schema.makeFilter(({ choices }) => {
      const materialTupleKeys = choices.map(
        ({ channel, marketRef, sellingLegalEntityRef }) =>
          `${sellingLegalEntityRef.resourceId}\u0000${marketRef.resourceId}\u0000${channel}`,
      );
      return new Set(materialTupleKeys).size === materialTupleKeys.length
        ? undefined
        : 'Market selection choices must contain distinct seller, Market, and Channel tuples';
    }),
  )
  .annotate(strict);

const knownResolutionFailure = <Tag extends string>(tag: Tag) =>
  Schema.Struct({
    outcome: Schema.Literal(tag),
    reason: boundedText,
  }).annotate(strict);

export const MarketResolutionOutcomeSchema = Schema.Union([
  resolved,
  selectionRequired,
  knownResolutionFailure('MARKET_NOT_ALLOWED_FOR_STOREFRONT'),
  knownResolutionFailure('MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL'),
  knownResolutionFailure('MARKET_NOT_ACTIVE'),
  knownResolutionFailure('MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT'),
  Schema.Struct({
    outcome: Schema.Literal('MARKET_ELIGIBILITY_UNAVAILABLE'),
    reason: boundedText,
    retryable: Schema.Literal(true),
  }).annotate(strict),
]);
export type MarketResolutionOutcome = typeof MarketResolutionOutcomeSchema.Type;
