import { Schema } from 'effect';

import {
  AssociationProvenanceSchema,
  EffectivePeriodSchema,
  InitialMarketLifecycleSchema,
  JurisdictionRefSchema,
  MarketChannelSchema,
  MarketLifecycleSchema,
  SellingLegalEntityRefSchema,
  StorefrontRefSchema,
} from './market-contracts.ts';
import { MarketRefSchema } from './resources/market.ts';
import { MarketDefinitionRevisionRefSchema } from './resources/market-definition-revision.ts';
import { StorefrontAssociationRefSchema } from './resources/storefront-association.ts';

const checkedUuid = Schema.String.check(Schema.isUUID());
const MarketIdSchema = checkedUuid.pipe(Schema.brand('CommerceMarketId'), Schema.decodeTo(checkedUuid));
const StorefrontAssociationIdSchema = checkedUuid.pipe(
  Schema.brand('CommerceMarketStorefrontAssociationId'),
  Schema.decodeTo(checkedUuid),
);
const positiveRevision = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());
const boundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());
const expectedRevisionTenantMismatch = 'Market and expected definition revision must belong to the same Tenant';
const marketCode = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Z0-9][A-Z0-9_-]*$/u),
);
const channels = Schema.Array(MarketChannelSchema).check(Schema.isMinLength(1));
const jurisdictions = Schema.Array(JurisdictionRefSchema).check(Schema.isMinLength(1));
const supportedLocales = Schema.Array(
  Schema.String.check(
    Schema.isMinLength(2),
    Schema.isMaxLength(35),
    Schema.isPattern(/^[a-z]{2,3}(?:-[A-Z][A-Za-z0-9]{1,7})*$/u),
  ),
).check(Schema.isMinLength(1));

export const CreateMarketPayloadSchema = Schema.Struct({
  channels,
  effectivePeriod: EffectivePeriodSchema,
  jurisdictions,
  lifecycle: InitialMarketLifecycleSchema,
  marketCode,
  marketId: MarketIdSchema,
  purpose: boundedText,
  reason,
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
  supportedLocales,
});
export type CreateMarketPayload = typeof CreateMarketPayloadSchema.Type;

export const CreateMarketResultSchema = Schema.Struct({
  created: Schema.Boolean,
  definitionRevisionRef: MarketDefinitionRevisionRefSchema,
  marketRef: MarketRefSchema,
  revision: Schema.Literal(1),
}).check(
  Schema.makeFilter(({ definitionRevisionRef, marketRef }) =>
    definitionRevisionRef.tenantId === marketRef.tenantId
      ? undefined
      : 'Market and definition revision must belong to the same Tenant',
  ),
);

export const ReviseMarketDefinitionPayloadSchema = Schema.Struct({
  channels,
  effectivePeriod: EffectivePeriodSchema,
  expectedCurrentDefinitionRevisionRef: MarketDefinitionRevisionRefSchema,
  expectedRevision: positiveRevision,
  jurisdictions,
  marketRef: MarketRefSchema,
  purpose: boundedText,
  reason,
  supportedLocales,
}).check(
  Schema.makeFilter(({ expectedCurrentDefinitionRevisionRef, marketRef }) =>
    expectedCurrentDefinitionRevisionRef.tenantId === marketRef.tenantId ? undefined : expectedRevisionTenantMismatch,
  ),
);
export type ReviseMarketDefinitionPayload = typeof ReviseMarketDefinitionPayloadSchema.Type;

export const ReviseMarketDefinitionResultSchema = Schema.Struct({
  definitionRevisionRef: MarketDefinitionRevisionRefSchema,
  marketRef: MarketRefSchema,
  previousDefinitionRevisionRef: MarketDefinitionRevisionRefSchema,
  revision: positiveRevision,
}).check(
  Schema.makeFilter(({ definitionRevisionRef, marketRef, previousDefinitionRevisionRef }) =>
    definitionRevisionRef.tenantId === marketRef.tenantId &&
    previousDefinitionRevisionRef.tenantId === marketRef.tenantId
      ? undefined
      : 'Market and definition revisions must belong to the same Tenant',
  ),
);

const lifecyclePayloadFields = {
  effectiveAt: Schema.DateTimeUtcFromString,
  expectedCurrentDefinitionRevisionRef: MarketDefinitionRevisionRefSchema,
  expectedRevision: positiveRevision,
  marketRef: MarketRefSchema,
  reason,
};

export const ActivateMarketPayloadSchema = Schema.Struct(lifecyclePayloadFields).check(
  Schema.makeFilter(({ expectedCurrentDefinitionRevisionRef, marketRef }) =>
    expectedCurrentDefinitionRevisionRef.tenantId === marketRef.tenantId ? undefined : expectedRevisionTenantMismatch,
  ),
);
export type ActivateMarketPayload = typeof ActivateMarketPayloadSchema.Type;
export const SuspendMarketPayloadSchema = Schema.Struct(lifecyclePayloadFields).check(
  Schema.makeFilter(({ expectedCurrentDefinitionRevisionRef, marketRef }) =>
    expectedCurrentDefinitionRevisionRef.tenantId === marketRef.tenantId ? undefined : expectedRevisionTenantMismatch,
  ),
);
export type SuspendMarketPayload = typeof SuspendMarketPayloadSchema.Type;
export const RetireMarketPayloadSchema = Schema.Struct(lifecyclePayloadFields).check(
  Schema.makeFilter(({ expectedCurrentDefinitionRevisionRef, marketRef }) =>
    expectedCurrentDefinitionRevisionRef.tenantId === marketRef.tenantId ? undefined : expectedRevisionTenantMismatch,
  ),
);
export type RetireMarketPayload = typeof RetireMarketPayloadSchema.Type;

export const MarketLifecycleResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  definitionRevisionRef: MarketDefinitionRevisionRefSchema,
  lifecycle: MarketLifecycleSchema,
  marketRef: MarketRefSchema,
  revision: positiveRevision,
}).check(
  Schema.makeFilter(({ definitionRevisionRef, marketRef }) =>
    definitionRevisionRef.tenantId === marketRef.tenantId
      ? undefined
      : 'Market and definition revision must belong to the same Tenant',
  ),
);

export const AssociateStorefrontPayloadSchema = Schema.Struct({
  associationId: StorefrontAssociationIdSchema,
  channel: MarketChannelSchema,
  effectivePeriod: EffectivePeriodSchema,
  expectedMarketDefinitionRevisionRef: MarketDefinitionRevisionRefSchema,
  marketRef: MarketRefSchema,
  provenance: AssociationProvenanceSchema,
  reason,
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
  storefrontRef: StorefrontRefSchema,
}).check(
  Schema.makeFilter(({ expectedMarketDefinitionRevisionRef, marketRef, sellingLegalEntityRef, storefrontRef }) =>
    marketRef.tenantId === sellingLegalEntityRef.tenantId &&
    marketRef.tenantId === storefrontRef.tenantId &&
    marketRef.tenantId === expectedMarketDefinitionRevisionRef.tenantId
      ? undefined
      : 'Market revision, Market, seller, and Storefront must belong to the same Tenant',
  ),
);
export type AssociateStorefrontPayload = typeof AssociateStorefrontPayloadSchema.Type;

export const ReviseStorefrontAssociationPayloadSchema = Schema.Struct({
  associationRef: StorefrontAssociationRefSchema,
  channel: MarketChannelSchema,
  effectivePeriod: EffectivePeriodSchema,
  expectedRevision: positiveRevision,
  marketRef: MarketRefSchema,
  provenance: AssociationProvenanceSchema,
  reason,
  storefrontRef: StorefrontRefSchema,
}).check(
  Schema.makeFilter(({ associationRef, marketRef, storefrontRef }) =>
    associationRef.tenantId === marketRef.tenantId && marketRef.tenantId === storefrontRef.tenantId
      ? undefined
      : 'Association, Market, and Storefront must belong to the same Tenant',
  ),
);
export type ReviseStorefrontAssociationPayload = typeof ReviseStorefrontAssociationPayloadSchema.Type;

export const RemoveStorefrontAssociationPayloadSchema = Schema.Struct({
  associationRef: StorefrontAssociationRefSchema,
  effectiveAt: Schema.DateTimeUtcFromString,
  expectedRevision: positiveRevision,
  marketRef: MarketRefSchema,
  reason,
  storefrontRef: StorefrontRefSchema,
}).check(
  Schema.makeFilter(({ associationRef, marketRef, storefrontRef }) =>
    associationRef.tenantId === marketRef.tenantId && marketRef.tenantId === storefrontRef.tenantId
      ? undefined
      : 'Association, Market, and Storefront must belong to the same Tenant',
  ),
);
export type RemoveStorefrontAssociationPayload = typeof RemoveStorefrontAssociationPayloadSchema.Type;

export const StorefrontAssociationResultSchema = Schema.Struct({
  associationRef: StorefrontAssociationRefSchema,
  changed: Schema.Boolean,
  marketRef: MarketRefSchema,
  revision: positiveRevision,
}).check(
  Schema.makeFilter(({ associationRef, marketRef }) =>
    associationRef.tenantId === marketRef.tenantId
      ? undefined
      : 'Association and Market must belong to the same Tenant',
  ),
);

export class MarketCommandRejected extends Schema.TaggedError<MarketCommandRejected>()('MarketCommandRejected', {
  code: Schema.Literals([
    'cross_tenant_reference',
    'inconsistent_seller_or_channel',
    'invalid_lifecycle_transition',
    'market_code_conflict',
    'overlapping_association',
    'replacement_impact_unresolved',
    'revision_conflict',
    'seller_identity_immutable',
  ]),
  reason,
}) {}
