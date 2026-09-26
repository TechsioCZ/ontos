import { Schema } from 'effect';

import {
  EffectivePeriodSchema,
  InitialMarketLifecycleSchema,
  MarketChannelSchema,
  SellingLegalEntityRefSchema,
  StorefrontRefSchema,
} from './market-contracts.ts';
import { MarketRefSchema } from './resources/market.ts';
import { MarketDefinitionRevisionRefSchema } from './resources/market-definition-revision.ts';
import { StorefrontAssociationRefSchema } from './resources/storefront-association.ts';

const positiveRevision = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const instant = Schema.toEncoded(Schema.DateTimeUtcFromString);
const effectivePeriod = Schema.toEncoded(EffectivePeriodSchema);
const revisionTenantMismatch = 'Market and definition revision must belong to the same Tenant';
const associationTenantMismatch = 'Association, Market, and Storefront Tenant must match';

export const MarketCreatedOutboxPayloadSchema = Schema.Struct({
  channels: Schema.Array(MarketChannelSchema).check(Schema.isMinLength(1)),
  definitionRevisionRef: MarketDefinitionRevisionRefSchema,
  effectivePeriod,
  lifecycle: InitialMarketLifecycleSchema,
  marketRef: MarketRefSchema,
  revision: Schema.Literal(1),
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
}).check(
  Schema.makeFilter(({ definitionRevisionRef, marketRef, sellingLegalEntityRef }) =>
    marketRef.tenantId === sellingLegalEntityRef.tenantId && definitionRevisionRef.tenantId === marketRef.tenantId
      ? undefined
      : 'Market revision, Market, and seller Tenant must match',
  ),
);

export const MarketDefinitionRevisedOutboxPayloadSchema = Schema.Struct({
  definitionRevisionRef: MarketDefinitionRevisionRefSchema,
  effectivePeriod,
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

const marketLifecycleChangedFields = {
  changedAt: instant,
  definitionRevisionRef: MarketDefinitionRevisionRefSchema,
  marketRef: MarketRefSchema,
  revision: positiveRevision,
};

export const MarketActivatedOutboxPayloadSchema = Schema.Struct({
  ...marketLifecycleChangedFields,
  lifecycle: Schema.Literal('ACTIVE'),
}).check(
  Schema.makeFilter(({ definitionRevisionRef, marketRef }) =>
    definitionRevisionRef.tenantId === marketRef.tenantId ? undefined : revisionTenantMismatch,
  ),
);
export const MarketSuspendedOutboxPayloadSchema = Schema.Struct({
  ...marketLifecycleChangedFields,
  lifecycle: Schema.Literal('SUSPENDED'),
}).check(
  Schema.makeFilter(({ definitionRevisionRef, marketRef }) =>
    definitionRevisionRef.tenantId === marketRef.tenantId ? undefined : revisionTenantMismatch,
  ),
);
export const MarketRetiredOutboxPayloadSchema = Schema.Struct({
  ...marketLifecycleChangedFields,
  lifecycle: Schema.Literal('RETIRED'),
}).check(
  Schema.makeFilter(({ definitionRevisionRef, marketRef }) =>
    definitionRevisionRef.tenantId === marketRef.tenantId ? undefined : revisionTenantMismatch,
  ),
);

export const StorefrontAssociatedOutboxPayloadSchema = Schema.Struct({
  associationRef: StorefrontAssociationRefSchema,
  channel: MarketChannelSchema,
  effectivePeriod,
  marketRef: MarketRefSchema,
  revision: Schema.Literal(1),
  storefrontRef: StorefrontRefSchema,
}).check(
  Schema.makeFilter(({ associationRef, marketRef, storefrontRef }) =>
    associationRef.tenantId === marketRef.tenantId && storefrontRef.tenantId === marketRef.tenantId
      ? undefined
      : associationTenantMismatch,
  ),
);

export const StorefrontAssociationRevisedOutboxPayloadSchema = Schema.Struct({
  associationRef: StorefrontAssociationRefSchema,
  channel: MarketChannelSchema,
  effectivePeriod,
  marketRef: MarketRefSchema,
  previousRevision: positiveRevision,
  revision: positiveRevision,
  storefrontRef: StorefrontRefSchema,
}).check(
  Schema.makeFilter(({ associationRef, marketRef, storefrontRef }) =>
    associationRef.tenantId === marketRef.tenantId && storefrontRef.tenantId === marketRef.tenantId
      ? undefined
      : associationTenantMismatch,
  ),
);

export const StorefrontAssociationRemovedOutboxPayloadSchema = Schema.Struct({
  associationRef: StorefrontAssociationRefSchema,
  marketRef: MarketRefSchema,
  removedAt: instant,
  revision: positiveRevision,
  storefrontRef: StorefrontRefSchema,
}).check(
  Schema.makeFilter(({ associationRef, marketRef, storefrontRef }) =>
    associationRef.tenantId === marketRef.tenantId && storefrontRef.tenantId === marketRef.tenantId
      ? undefined
      : associationTenantMismatch,
  ),
);
