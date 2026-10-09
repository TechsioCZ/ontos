import { Schema } from 'effect';

import {
  AttributeDefinitionSchema,
  AttributeValueSchema,
  assessDefinitionRuleChange,
  validateAttributeValues,
} from './attribute-values.ts';
import type { AttributeDefinition, AttributeValue, UnitConversion } from './attribute-values.ts';
import type { CatalogResourceRefInput } from './catalog-revision-reference.ts';

export interface AttributeValueProvenance {
  readonly evidence: string;
  readonly sourceDefinitionRef: CatalogResourceRefInput;
  readonly sourceDefinitionRevision: number;
  readonly sourceUnit: string | null;
  readonly subjectRef: CatalogResourceRefInput;
  readonly valueOrdinal: number;
}

export interface EvidencedAttributeValue {
  /** The immutable value as recorded under the previous definition rules. */
  readonly original: AttributeValue | null;
  /** Evidence for the unit and origin of this specific recorded value. */
  readonly provenance: AttributeValueProvenance | null;
}

export type AttributeUnitChangeAssessment =
  | { readonly kind: 'NEW_DEFINITION_REQUIRED'; readonly reasons: readonly string[] }
  | { readonly kind: 'INDETERMINATE'; readonly reasons: readonly string[] }
  | { readonly kind: 'REMEDIATION_REQUIRED'; readonly reasons: readonly string[] }
  | {
      readonly converted: readonly AttributeValue[];
      readonly kind: 'CONVERTIBLE';
      readonly originals: readonly AttributeValue[];
    };

/**
 * A TEXT or CONTROLLED rule revision has no unit to convert. It may keep identity only while the
 * recorded values stay valid under the proposed rules; otherwise the owner must remediate them.
 */
const assessNonMeasurementChange = (
  proposed: AttributeDefinition,
  recorded: readonly EvidencedAttributeValue[],
): AttributeUnitChangeAssessment => {
  if (recorded.some(({ original }) => original === null)) {
    return { kind: 'INDETERMINATE', reasons: ['Recorded value is absent'] };
  }
  const originals = recorded.map(({ original }) => original);
  if (originals.some((value) => !Schema.is(AttributeValueSchema)(value))) {
    return { kind: 'INDETERMINATE', reasons: ['Recorded value is malformed'] };
  }
  const next = validateAttributeValues(proposed, originals);
  return next.valid
    ? { converted: next.normalized, kind: 'CONVERTIBLE', originals: next.normalized }
    : { kind: 'REMEDIATION_REQUIRED', reasons: next.reasons };
};

/** Assess one fully enumerated subject; this does not establish impact completeness or write Current. */
export const assessAttributeUnitChange = (
  current: AttributeDefinition,
  proposed: AttributeDefinition,
  subjectRef: CatalogResourceRefInput,
  sourceDefinitionRevision: number,
  recorded: readonly EvidencedAttributeValue[],
  conversions: readonly UnitConversion[],
): AttributeUnitChangeAssessment => {
  if (!Schema.is(AttributeDefinitionSchema)(current) || !Schema.is(AttributeDefinitionSchema)(proposed)) {
    return { kind: 'NEW_DEFINITION_REQUIRED', reasons: ['Invalid definition'] };
  }
  const definitionChange = assessDefinitionRuleChange(current, proposed);
  if (definitionChange.kind === 'NEW_DEFINITION_REQUIRED') {
    return { kind: 'NEW_DEFINITION_REQUIRED', reasons: definitionChange.reasons };
  }
  if (current.valueKind !== 'MEASUREMENT') {
    return assessNonMeasurementChange(proposed, recorded);
  }
  if (recorded.length === 0 || recorded.some(({ original }) => original === null)) {
    return { kind: 'INDETERMINATE', reasons: ['Recorded value is absent'] };
  }
  if (
    !Schema.is(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)))(sourceDefinitionRevision) ||
    recorded.some(
      ({ original, provenance }, valueOrdinal) =>
        provenance === null ||
        provenance.evidence.trim().length === 0 ||
        provenance.subjectRef.moduleId !== subjectRef.moduleId ||
        provenance.subjectRef.resourceId !== subjectRef.resourceId ||
        provenance.subjectRef.resourceType !== subjectRef.resourceType ||
        provenance.subjectRef.tenantId !== subjectRef.tenantId ||
        provenance.sourceDefinitionRef.moduleId !== current.ref.moduleId ||
        provenance.sourceDefinitionRef.resourceId !== current.ref.resourceId ||
        provenance.sourceDefinitionRef.resourceType !== current.ref.resourceType ||
        provenance.sourceDefinitionRef.tenantId !== current.ref.tenantId ||
        provenance.sourceDefinitionRevision !== sourceDefinitionRevision ||
        provenance.valueOrdinal !== valueOrdinal ||
        provenance.sourceUnit !== (original?.kind === 'MEASUREMENT' ? original.unit : null),
    )
  ) {
    return { kind: 'INDETERMINATE', reasons: ['Unit or value provenance is unknown'] };
  }
  const originals = recorded.map(({ original }) => original);
  if (originals.some((value) => !Schema.is(AttributeValueSchema)(value))) {
    return { kind: 'INDETERMINATE', reasons: ['Recorded value is malformed'] };
  }
  const previous = validateAttributeValues(current, originals);
  if (!previous.valid) {
    return { kind: 'INDETERMINATE', reasons: previous.reasons };
  }
  const next = validateAttributeValues(proposed, originals, conversions);
  if (!next.valid) {
    return { kind: 'REMEDIATION_REQUIRED', reasons: next.reasons };
  }
  return { converted: next.normalized, kind: 'CONVERTIBLE', originals: previous.normalized };
};
