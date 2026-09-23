import { Schema } from 'effect';

import { CatalogResourceRefSchema } from './catalog-revision-reference.ts';
import { ColorDetailsSchema } from './color.ts';

const meaningfulText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());
const controlledValueResourceType = 'commerce.catalog.controlled-attribute-value';

/** Labels, previews, and list positions are never identity keys. */
export const ControlledAttributeValueSchema = Schema.Struct({
  attributeDefinitionRef: CatalogResourceRefSchema,
  color: Schema.optionalKey(ColorDetailsSchema),
  label: meaningfulText,
  lifecycle: Schema.Literals(['ACTIVE', 'RETIRED']),
  ref: CatalogResourceRefSchema,
  specialization: Schema.Literals(['GENERAL', 'COLOR', 'SIZE']),
}).check(
  Schema.makeFilter((value) => {
    if (value.ref.resourceType !== controlledValueResourceType) {
      return 'Expected a controlled value';
    }
    if (value.attributeDefinitionRef.resourceType !== 'commerce.catalog.attribute-definition') {
      return 'Expected an Attribute Definition';
    }
    if (value.ref.tenantId !== value.attributeDefinitionRef.tenantId) {
      return 'Controlled value and definition must share a Tenant';
    }
    return (value.specialization === 'COLOR') === (value.color !== undefined)
      ? undefined
      : 'Only Color has Color-specific description';
  }),
);
export type ControlledAttributeValue = typeof ControlledAttributeValueSchema.Type;

/** A same-identity rename is a reviewed correction of presentation, never a change of meaning. */
export const ControlledValueRenameDecisionSchema = Schema.Struct({
  current: ControlledAttributeValueSchema,
  evidence: meaningfulText,
  proposedLabel: meaningfulText,
  sameMeaning: Schema.Boolean,
});
export type ControlledValueRenameDecision = typeof ControlledValueRenameDecisionSchema.Type;

export const mayRenameControlledValue = (decision: ControlledValueRenameDecision): boolean =>
  Schema.is(ControlledValueRenameDecisionSchema)(decision) && decision.sameMeaning;

/** Reactivation is an explicit Current review of the same identity, not creation of a duplicate. */
export const ControlledValueReactivationDecisionSchema = Schema.Struct({
  currentMeaningConfirmed: Schema.Boolean,
  evidence: meaningfulText,
  value: ControlledAttributeValueSchema,
});
export type ControlledValueReactivationDecision = typeof ControlledValueReactivationDecisionSchema.Type;

export const mayReactivateControlledValue = (decision: ControlledValueReactivationDecision): boolean =>
  Schema.is(ControlledValueReactivationDecisionSchema)(decision) &&
  decision.value.lifecycle === 'RETIRED' &&
  decision.currentMeaningConfirmed;

/** Retirement restricts future assignments but never deletes existing references. */
export const mayAssignControlledValue = (
  definition: { readonly ref: { readonly resourceId: string; readonly tenantId: string } },
  value: ControlledAttributeValue,
): boolean =>
  Schema.is(ControlledAttributeValueSchema)(value) &&
  value.lifecycle === 'ACTIVE' &&
  value.attributeDefinitionRef.resourceId === definition.ref.resourceId &&
  value.attributeDefinitionRef.tenantId === definition.ref.tenantId;

export const SizeUsageListSchema = Schema.Struct({
  productRef: CatalogResourceRefSchema,
  /** The array position is local to this Product's usage list, never a property of Size. */
  orderedSizeRefs: Schema.Array(CatalogResourceRefSchema),
}).check(
  Schema.makeFilter(({ orderedSizeRefs, productRef }) => {
    if (productRef.resourceType !== 'commerce.catalog.product') {
      return 'Size list needs a Product';
    }
    if (
      orderedSizeRefs.some(
        (ref) => ref.resourceType !== controlledValueResourceType || ref.tenantId !== productRef.tenantId,
      )
    ) {
      return 'Size list must reference same-Tenant controlled values';
    }
    return new Set(orderedSizeRefs.map((ref) => ref.resourceId)).size === orderedSizeRefs.length
      ? undefined
      : 'Size list cannot repeat an identity';
  }),
);
export type SizeUsageList = typeof SizeUsageListSchema.Type;

/** A conversion applies only to an evidenced scope; matching labels do not establish it. */
export const SizeEquivalenceAssertionSchema = Schema.Struct({
  evidence: meaningfulText,
  leftSizeRef: CatalogResourceRefSchema,
  rightSizeRef: CatalogResourceRefSchema,
  scope: meaningfulText,
  validFrom: Schema.optionalKey(Schema.DateTimeUtc),
  validUntil: Schema.optionalKey(Schema.DateTimeUtc),
}).check(
  Schema.makeFilter(({ leftSizeRef, rightSizeRef }) => {
    if (
      leftSizeRef.resourceType !== controlledValueResourceType ||
      rightSizeRef.resourceType !== controlledValueResourceType
    ) {
      return 'Expected Size value references';
    }
    if (leftSizeRef.tenantId !== rightSizeRef.tenantId) {
      return 'Size equivalence cannot cross Tenants';
    }
    return leftSizeRef.resourceId === rightSizeRef.resourceId ? 'Distinct Size identities are required' : undefined;
  }),
);
export type SizeEquivalenceAssertion = typeof SizeEquivalenceAssertionSchema.Type;
