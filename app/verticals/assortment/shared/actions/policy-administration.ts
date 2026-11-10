import { DateTime, Schema } from 'effect';
import {
  AssortmentCommercialScopeSchema,
  AssortmentEffectSchema,
  AssortmentRuleRevisionReferenceSchema,
  AssortmentStableRuleRefSchema,
  AssortmentApplicabilityBindingRefSchema,
  AssortmentCatalogSelectorSchema,
  AssortmentDecisionPurposeSchema,
  AssortmentPurchasingSubjectSchema,
  AssortmentOwnerResourceRefSchema,
  CatalogProductRefSchema,
} from '../domain/decision-contracts.ts';
import { assortmentMeaningFingerprint, ruleMeaning } from '../domain/policy-fingerprint.ts';

const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ProvenanceRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const InstantSchema = Schema.DateTimeUtcFromString;
const FingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const RevisionNumberSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const AssortmentBindingAudienceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('SHARED') }),
  Schema.Struct({
    groupRef: AssortmentOwnerResourceRefSchema.check(
      Schema.makeFilter((ref) =>
        ref.moduleId === 'commerce.customer-context' && ref.resourceType === 'commerce.customer-context.customer-group'
          ? undefined
          : 'Binding Customer Group references must identify Commerce Customer Context groups',
      ),
    ),
    kind: Schema.Literal('COMMERCE_CUSTOMER_GROUP'),
  }),
  Schema.Struct({ kind: Schema.Literal('SUBJECT'), subject: AssortmentPurchasingSubjectSchema }),
]);
export type AssortmentBindingAudience = typeof AssortmentBindingAudienceSchema.Type;

export const CreateRulePayloadSchema = Schema.Struct({
  effect: AssortmentEffectSchema,
  provenanceRef: ProvenanceRefSchema,
  purpose: AssortmentDecisionPurposeSchema,
  reason: ReasonSchema,
  selector: AssortmentCatalogSelectorSchema,
  stableCode: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9._-]{0,127}$/u)),
});
export type CreateRulePayload = typeof CreateRulePayloadSchema.Type;
export const CreateRuleResultSchema = Schema.Struct({
  created: Schema.Boolean,
  initialRuleRevisionRef: AssortmentRuleRevisionReferenceSchema,
  stableRuleRef: AssortmentStableRuleRefSchema,
});

export const CreateRuleRevisionPayloadSchema = Schema.Struct({
  effect: AssortmentEffectSchema,
  expectedLatestRevision: RevisionNumberSchema,
  provenanceRef: ProvenanceRefSchema,
  purpose: AssortmentDecisionPurposeSchema,
  reason: ReasonSchema,
  selector: AssortmentCatalogSelectorSchema,
  stableRuleRef: AssortmentStableRuleRefSchema,
});
export type CreateRuleRevisionPayload = typeof CreateRuleRevisionPayloadSchema.Type;
export const CreateRuleRevisionResultSchema = Schema.Struct({
  created: Schema.Boolean,
  revisionNumber: RevisionNumberSchema,
  ruleRevisionRef: AssortmentRuleRevisionReferenceSchema,
});

export const RetireRulePayloadSchema = Schema.Struct({
  effectiveAt: InstantSchema,
  expectedBasisFingerprint: FingerprintSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  stableRuleRef: AssortmentStableRuleRefSchema,
});
export type RetireRulePayload = typeof RetireRulePayloadSchema.Type;
export const RetireRuleResultSchema = Schema.Struct({
  retired: Schema.Boolean,
  stableRuleRef: AssortmentStableRuleRefSchema,
});

export const CreateApplicabilityBindingPayloadSchema = Schema.Struct({
  audience: AssortmentBindingAudienceSchema,
  commercialScope: AssortmentCommercialScopeSchema,
  effectiveFrom: InstantSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  ruleRevisionRef: AssortmentRuleRevisionReferenceSchema,
});
export type CreateApplicabilityBindingPayload = typeof CreateApplicabilityBindingPayloadSchema.Type;
export const CreateApplicabilityBindingResultSchema = Schema.Struct({
  applicabilityBindingRef: AssortmentApplicabilityBindingRefSchema,
  created: Schema.Boolean,
});

const fixtureRefOwnerMismatch = 'The fixture reference has the wrong owner';
const canonicalFixtureResourceId = AssortmentOwnerResourceRefSchema.fields.resourceId.check(
  Schema.isUUID(),
  Schema.isPattern(/^[0-9a-f-]+$/u),
);
const FixtureStorefrontAppIdSchema = Schema.String.check(
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
).pipe(Schema.brand('AssortmentFixtureStorefrontAppId'), Schema.decodeTo(Schema.String));

export const ImportSymmyRulePayloadSchema = Schema.Struct({
  binding: Schema.Struct({
    audience: Schema.Struct({
      groupRef: Schema.Struct({
        ...AssortmentOwnerResourceRefSchema.fields,
        moduleId: AssortmentOwnerResourceRefSchema.fields.moduleId.check(
          Schema.makeFilter((moduleId) =>
            moduleId === 'commerce.customer-context' ? undefined : fixtureRefOwnerMismatch,
          ),
        ),
        resourceType: Schema.Literal('commerce.customer-context.customer-group'),
      }),
      kind: Schema.Literal('COMMERCE_CUSTOMER_GROUP'),
    }),
    commercialScope: Schema.Struct({
      channelRef: Schema.Struct({
        ...AssortmentOwnerResourceRefSchema.fields,
        moduleId: AssortmentOwnerResourceRefSchema.fields.moduleId.check(
          Schema.makeFilter((moduleId) => (moduleId === 'commerce.channel' ? undefined : fixtureRefOwnerMismatch)),
        ),
        resourceType: Schema.Literal('commerce.channel.channel'),
      }),
      commerceMarketRef: Schema.Union([
        Schema.Struct({
          ...AssortmentOwnerResourceRefSchema.fields,
          moduleId: AssortmentOwnerResourceRefSchema.fields.moduleId.check(
            Schema.makeFilter((moduleId) =>
              moduleId === 'commerce.market-catalog' ? undefined : fixtureRefOwnerMismatch,
            ),
          ),
          resourceId: canonicalFixtureResourceId,
          resourceType: Schema.Literal('commerce.market-catalog.market'),
        }),
        Schema.Struct({
          ...AssortmentOwnerResourceRefSchema.fields,
          moduleId: AssortmentOwnerResourceRefSchema.fields.moduleId.check(
            Schema.makeFilter((moduleId) => (moduleId === 'commerce.market' ? undefined : fixtureRefOwnerMismatch)),
          ),
          resourceType: Schema.Literal('commerce.market.market'),
        }),
      ]),
      sellingLegalEntityRef: Schema.Union([
        Schema.Struct({
          ...AssortmentOwnerResourceRefSchema.fields,
          moduleId: AssortmentOwnerResourceRefSchema.fields.moduleId.check(
            Schema.makeFilter((moduleId) => (moduleId === 'core.identity' ? undefined : fixtureRefOwnerMismatch)),
          ),
          resourceId: canonicalFixtureResourceId,
          resourceType: Schema.Literal('core.identity.legal-entity'),
        }),
        Schema.Struct({
          ...AssortmentOwnerResourceRefSchema.fields,
          moduleId: AssortmentOwnerResourceRefSchema.fields.moduleId.check(
            Schema.makeFilter((moduleId) => (moduleId === 'party.registry' ? undefined : fixtureRefOwnerMismatch)),
          ),
          resourceType: Schema.Literal('party.registry.legal-entity'),
        }),
      ]),
      storefrontRef: Schema.Union([
        Schema.Struct({
          ...AssortmentOwnerResourceRefSchema.fields,
          moduleId: AssortmentOwnerResourceRefSchema.fields.moduleId.check(
            Schema.makeFilter((moduleId) =>
              moduleId === 'commerce.storefront-registry' ? undefined : fixtureRefOwnerMismatch,
            ),
          ),
          resourceId: canonicalFixtureResourceId,
          resourceType: Schema.Literal('commerce.storefront-registry.storefront-application'),
        }),
        Schema.Struct({
          ...AssortmentOwnerResourceRefSchema.fields,
          moduleId: AssortmentOwnerResourceRefSchema.fields.moduleId.check(
            Schema.makeFilter((moduleId) => (moduleId === 'commerce.storefront' ? undefined : fixtureRefOwnerMismatch)),
          ),
          resourceType: Schema.Literal('commerce.storefront.storefront'),
        }),
      ]),
    }),
    effectiveFrom: InstantSchema,
    provenanceRef: ProvenanceRefSchema,
    reason: ReasonSchema,
    storefrontAppId: Schema.optionalKey(FixtureStorefrontAppIdSchema),
  }),
  rule: Schema.Struct({
    ...CreateRulePayloadSchema.fields,
    selector: Schema.Struct({ kind: Schema.Literal('PRODUCT'), productRef: CatalogProductRefSchema }).check(
      Schema.makeFilter(({ productRef }) =>
        productRef.moduleId === 'commerce.catalog' && productRef.resourceType === 'commerce.catalog.product'
          ? undefined
          : 'The fixture rule must identify a Catalog Product',
      ),
    ),
    stableCode: Schema.String.check(Schema.isPattern(/^symmy-[0-9a-f]{64}$/u)),
  }),
}).check(
  Schema.makeFilter(({ binding, rule }) => {
    const { channelRef, commerceMarketRef, sellingLegalEntityRef, storefrontRef } = binding.commercialScope;
    return binding.provenanceRef === `internal-c14-assortment:${rule.stableCode.slice(6)}` &&
      rule.provenanceRef === binding.provenanceRef &&
      rule.reason === binding.reason &&
      [channelRef, commerceMarketRef, storefrontRef, binding.audience.groupRef, rule.selector.productRef].every(
        (ref) => ref.tenantId === sellingLegalEntityRef.tenantId,
      )
      ? undefined
      : 'The fixture rule and binding must share exact source provenance and Tenant';
  }),
);
export type ImportSymmyRulePayload = typeof ImportSymmyRulePayloadSchema.Type;

/** The exact owner document hashed by a fixture permit and passed to its guarded write. */
export const projectSymmyRuleFixtureDatabaseCommand = ({ binding, rule }: ImportSymmyRulePayload) => {
  const { storefrontAppId } = binding;
  if (storefrontAppId === undefined) {
    return null;
  }
  return {
    channel: binding.commercialScope.channelRef.resourceId,
    effect: rule.effect,
    effectiveFrom: DateTime.formatIso(binding.effectiveFrom),
    fingerprint: assortmentMeaningFingerprint(ruleMeaning(rule)),
    group: binding.audience.groupRef.resourceId,
    market: binding.commercialScope.commerceMarketRef.resourceId,
    product: rule.selector.productRef.resourceId,
    purpose: rule.purpose,
    reason: rule.reason,
    scopeVersion: 'C14_CANONICAL_V1',
    stableCode: rule.stableCode,
    storefront: binding.commercialScope.storefrontRef.resourceId,
    storefrontAppId,
  };
};

export const ImportSymmyRuleResultSchema = Schema.Struct({
  binding: CreateApplicabilityBindingResultSchema,
  rule: CreateRuleResultSchema,
});

export const EndApplicabilityBindingPayloadSchema = Schema.Struct({
  applicabilityBindingRef: AssortmentApplicabilityBindingRefSchema,
  effectiveAt: InstantSchema,
  expectedBasisFingerprint: FingerprintSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
});
export type EndApplicabilityBindingPayload = typeof EndApplicabilityBindingPayloadSchema.Type;
export const EndApplicabilityBindingResultSchema = Schema.Struct({
  applicabilityBindingRef: AssortmentApplicabilityBindingRefSchema,
  ended: Schema.Boolean,
});

export const ReplaceApplicabilityBindingPayloadSchema = Schema.Struct({
  effectiveAt: InstantSchema,
  existingBindingRef: AssortmentApplicabilityBindingRefSchema,
  expectedExistingBasisFingerprint: FingerprintSchema,
  proposedAudience: AssortmentBindingAudienceSchema,
  proposedCommercialScope: AssortmentCommercialScopeSchema,
  proposedEffectiveFrom: InstantSchema,
  proposedRuleRevisionRef: AssortmentRuleRevisionReferenceSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
}).check(
  Schema.makeFilter((payload) =>
    DateTime.formatIso(payload.effectiveAt) === DateTime.formatIso(payload.proposedEffectiveFrom)
      ? undefined
      : 'A Binding replacement must end and create at one trusted effective time',
  ),
);
export type ReplaceApplicabilityBindingPayload = typeof ReplaceApplicabilityBindingPayloadSchema.Type;
export const ReplaceApplicabilityBindingResultSchema = Schema.Struct({
  createdBindingRef: AssortmentApplicabilityBindingRefSchema,
  endedBindingRef: AssortmentApplicabilityBindingRefSchema,
  replaced: Schema.Boolean,
});
