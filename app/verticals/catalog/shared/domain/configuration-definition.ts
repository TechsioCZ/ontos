import { Schema } from 'effect';

import { CatalogRevisionResourceIdSchema, CatalogRevisionTenantIdSchema } from './catalog-revision-reference.ts';
import type { CatalogResourceRef } from './catalog-revision-reference.ts';
import type { ProductRef } from '../resources/product.ts';

/**
 * Catalog-owned Configuration Definition vocabulary (#456).
 *
 * A Configuration Definition is a Product-level Catalog Resource whose exact revision declares
 * which Configuration Choices the Product supports and what each value kind means. A concrete
 * Product Configuration is an immutable value at an exact target, never a new Resource or registry.
 * This module owns the supported-kind vocabulary and the definition-identity checks; rule bounds,
 * compatibility, and Current identity remain with #457/#459/#460/#461.
 */

/** The exact Catalog resource type of a Product-level Configuration Definition revision. */
export const PRODUCT_CONFIGURATION_DEFINITION_RESOURCE_TYPE = 'commerce.catalog.configuration-definition' as const;

/** Canonical tenant-qualified reference to one Product-level Configuration Definition Resource. */
export const ProductConfigurationDefinitionReferenceSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.catalog'),
  resourceId: CatalogRevisionResourceIdSchema,
  resourceType: Schema.Literal(PRODUCT_CONFIGURATION_DEFINITION_RESOURCE_TYPE),
  tenantId: CatalogRevisionTenantIdSchema,
});
export type ProductConfigurationDefinitionReference = typeof ProductConfigurationDefinitionReferenceSchema.Type;

/** Launch scope declares exactly these choice kinds; text labels are never identity. */
export const SUPPORTED_CONFIGURATION_CHOICE_KINDS = ['MEASURED_VALUE', 'SINGLE_CHOICE'] as const;
export const SupportedConfigurationChoiceKindSchema = Schema.Literals(SUPPORTED_CONFIGURATION_CHOICE_KINDS);
export type SupportedConfigurationChoiceKind = typeof SupportedConfigurationChoiceKindSchema.Type;

/** One exact business meaning per supported kind, not a presentation label. */
export const configurationChoiceKindMeaning = {
  MEASURED_VALUE: 'Exactly one exact numeric value carried with the explicit Unit of the choice meaning',
  SINGLE_CHOICE: 'Exactly one value from an explicit set of named options',
} as const satisfies Record<SupportedConfigurationChoiceKind, string>;

/**
 * Kinds a legacy system may know but that need a documented Product case before entering scope.
 * Their presence in another system is not evidence that any Product needs them.
 */
export const OUT_OF_SCOPE_CONFIGURATION_CHOICE_KINDS = [
  'MULTI_CHOICE',
  'FREE_TEXT',
  'BOOLEAN',
  'NESTED_STRUCTURE',
  'EXPRESSION',
] as const;
export const OutOfScopeConfigurationChoiceKindSchema = Schema.Literals(OUT_OF_SCOPE_CONFIGURATION_CHOICE_KINDS);
export type OutOfScopeConfigurationChoiceKind = typeof OutOfScopeConfigurationChoiceKindSchema.Type;

const outOfScopeReason = {
  BOOLEAN: 'A universal Boolean is not in scope; express binarity as two named Single Choice options',
  EXPRESSION: 'A general expression or formula engine is not in scope',
  FREE_TEXT: 'Free Text is not in scope without a documented Product that requires it',
  MULTI_CHOICE: 'Multi Choice is not in scope',
  NESTED_STRUCTURE: 'Arbitrarily nested configuration structures are not in scope',
} as const satisfies Record<OutOfScopeConfigurationChoiceKind, string>;

export type ConfigurationChoiceKindClassification =
  | {
      readonly kind: SupportedConfigurationChoiceKind;
      readonly meaning: string;
      readonly status: 'SUPPORTED';
    }
  | {
      readonly code: 'OUT_OF_SCOPE_CHOICE_KIND' | 'UNKNOWN_CHOICE_KIND';
      readonly kind: string;
      readonly reason: string;
      readonly status: 'UNSUPPORTED';
    };

/** Classify one declared kind, failing closed for out-of-scope and unrecognized values. */
export const classifyConfigurationChoiceKind = (declaredKind: string): ConfigurationChoiceKindClassification => {
  if (Schema.is(SupportedConfigurationChoiceKindSchema)(declaredKind)) {
    return { kind: declaredKind, meaning: configurationChoiceKindMeaning[declaredKind], status: 'SUPPORTED' };
  }
  if (Schema.is(OutOfScopeConfigurationChoiceKindSchema)(declaredKind)) {
    return {
      code: 'OUT_OF_SCOPE_CHOICE_KIND',
      kind: declaredKind,
      reason: outOfScopeReason[declaredKind],
      status: 'UNSUPPORTED',
    };
  }
  return {
    code: 'UNKNOWN_CHOICE_KIND',
    kind: declaredKind,
    reason: 'A new choice kind needs a documented Product case; legacy presence is not evidence',
    status: 'UNSUPPORTED',
  };
};

/** Structural input only; this never imports another owner's private Definition model. */
export interface ProductConfigurationDefinitionIdentity {
  readonly productRef: ProductRef;
  readonly reference: {
    readonly resourceRef: CatalogResourceRef;
    readonly revision: number;
    readonly revisionId?: string;
  };
}

export type ConfigurationDefinitionInspection =
  | { readonly status: 'VALID' }
  | { readonly reason: string; readonly status: 'INVALID' | 'INDETERMINATE' };

/**
 * A Definition is valid only as the Catalog-owned, Product-level Resource at one exact owner
 * revision in the Product's Tenant. Missing identity or ownership is INVALID, not merely absent.
 */
export const inspectProductConfigurationDefinitionOwnership = (
  definition: ProductConfigurationDefinitionIdentity,
): ConfigurationDefinitionInspection => {
  const { resourceRef } = definition.reference;
  if (
    resourceRef.moduleId !== 'commerce.catalog' ||
    resourceRef.resourceType !== PRODUCT_CONFIGURATION_DEFINITION_RESOURCE_TYPE
  ) {
    return {
      reason: 'Configuration Definition must be the Catalog-owned Product-level definition Resource',
      status: 'INVALID',
    };
  }
  if (resourceRef.tenantId !== definition.productRef.tenantId) {
    return { reason: 'Configuration Definition and its Product must share one Tenant', status: 'INVALID' };
  }
  if (!Number.isSafeInteger(definition.reference.revision) || definition.reference.revision < 1) {
    return {
      reason: 'Configuration Definition revision must be an owner-qualified positive sequence',
      status: 'INVALID',
    };
  }
  return { status: 'VALID' };
};
