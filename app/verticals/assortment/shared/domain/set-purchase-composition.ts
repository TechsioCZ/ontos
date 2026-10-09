import { DateTime, Result, Schema } from 'effect';

import {
  AssortmentCatalogSelectionSchema,
  AssortmentDecisionRequestSchema,
  AssortmentDecisionSubjectSchema,
  AssortmentGovernedDecisionSchema,
  AssortmentPurchaseConstituentSchema,
  AssortmentPurchaseRequestSchema,
  AssortmentSetPurchaseCompositionSchema,
  AssortmentTrustedCommerceContextSchema,
  composeAssortmentPurchaseOutcome,
} from './decision-contracts.ts';
import type {
  AssortmentConstituentDecision,
  AssortmentGovernedDecision,
  AssortmentPurchaseConstituent,
  AssortmentPurchaseRequest,
} from './decision-contracts.ts';
import { AssortmentSetCompositionResolutionSchema } from './ports/owner-evidence.ts';
import type { AssortmentSetCompositionResolution } from './ports/owner-evidence.ts';

export interface AssortmentConstituentResolutionRequest {
  readonly constituent: AssortmentPurchaseConstituent;
  readonly decisionPurpose: 'PURCHASE';
  readonly subject: AssortmentPurchaseRequest['subject'];
  readonly trustedContext: AssortmentPurchaseRequest['trustedContext'];
}

export type AssortmentConstituentResolver = (
  request: AssortmentConstituentResolutionRequest,
) => AssortmentGovernedDecision;

export const AssortmentSetPurchaseCompositionInputSchema = Schema.Struct({
  composition: AssortmentSetCompositionResolutionSchema,
  request: AssortmentDecisionRequestSchema,
});
export type AssortmentSetPurchaseCompositionInput = typeof AssortmentSetPurchaseCompositionInputSchema.Type;

const AssortmentSetPurchaseCompositionIndeterminateSchema = Schema.Struct({
  kind: Schema.Literal('INDETERMINATE'),
  reason: Schema.Literals([
    'COMPOSITION_REVISION_MISMATCH',
    'CONSTITUENT_RESOLUTION_INVALID',
    'INVALID_SET_PURCHASE_REQUEST',
    'VISIBILITY_NOT_SUPPORTED',
  ]),
});
type AssortmentSetPurchaseCompositionIndeterminate = typeof AssortmentSetPurchaseCompositionIndeterminateSchema.Type;

const AssortmentEvaluatedConstituentSchema = Schema.Struct({
  constituent: AssortmentPurchaseConstituentSchema,
  decision: AssortmentGovernedDecisionSchema,
});
export type AssortmentEvaluatedConstituent = typeof AssortmentEvaluatedConstituentSchema.Type;

export const AssortmentSetPurchaseCompositionEvidenceSchema = Schema.Struct({
  composition: AssortmentSetPurchaseCompositionSchema,
  compositionSource: AssortmentSetCompositionResolutionSchema,
  evaluated: Schema.Array(AssortmentEvaluatedConstituentSchema),
});
export type AssortmentSetPurchaseCompositionEvidence = typeof AssortmentSetPurchaseCompositionEvidenceSchema.Type;

const AssortmentSetPurchaseCompositionOutcomeSchema = Schema.Struct({
  evidence: AssortmentSetPurchaseCompositionEvidenceSchema,
  kind: Schema.Literals(['ELIGIBLE', 'INELIGIBLE']),
});

const AssortmentSetPurchaseCompositionIndeterminateWithEvidenceSchema = Schema.Struct({
  evidence: AssortmentSetPurchaseCompositionEvidenceSchema,
  kind: Schema.Literal('INDETERMINATE'),
  reason: Schema.Literal('CONSTITUENT_INDETERMINATE'),
});

export const AssortmentSetPurchaseCompositionResolutionSchema = Schema.Union([
  AssortmentSetPurchaseCompositionOutcomeSchema,
  AssortmentSetPurchaseCompositionIndeterminateWithEvidenceSchema,
  AssortmentSetPurchaseCompositionIndeterminateSchema,
]);
export type AssortmentSetPurchaseCompositionResolution = typeof AssortmentSetPurchaseCompositionResolutionSchema.Type;

const compositionEquivalence = Schema.toEquivalence(AssortmentSetPurchaseCompositionSchema);
const subjectEquivalence = Schema.toEquivalence(AssortmentDecisionSubjectSchema);
const contextEquivalence = Schema.toEquivalence(AssortmentTrustedCommerceContextSchema);
const selectionEquivalence = Schema.toEquivalence(AssortmentCatalogSelectionSchema);
const requestSubject = (request: AssortmentPurchaseRequest) => request.subject;

const JsonValueSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
);
const JsonArraySchema = Schema.Array(JsonValueSchema);
const JsonRecordSchema = Schema.Record(Schema.String, JsonValueSchema);
const JsonStringSchema = Schema.fromJsonString(JsonValueSchema);

const resourceKey = (reference: {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}): string => `${reference.moduleId}:${reference.resourceType}:${reference.resourceId}:${reference.tenantId}`;

const revisionKey = (revision: {
  readonly ownerModuleId: string;
  readonly revision: string;
  readonly sourceRef: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  };
}): string => `${revision.ownerModuleId}:${revision.revision}:${resourceKey(revision.sourceRef)}`;

const canonicalJsonValue = (value: Schema.Json): Schema.Json => {
  if (Schema.is(JsonArraySchema)(value)) {
    return value.map(canonicalJsonValue);
  }
  if (Schema.is(JsonRecordSchema)(value)) {
    const sorted = Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
    const decoded = Schema.decodeResult(JsonValueSchema)(sorted);
    return Result.getOrElse(decoded, () => value);
  }
  return value;
};

const jsonValueKey = (value: Schema.Json): string =>
  Result.getOrElse(Schema.encodeResult(JsonStringSchema)(canonicalJsonValue(value)), () => 'invalid-json-value');

const selectionKey = (selection: AssortmentPurchaseConstituent['catalogSelection']): string => {
  const configuration =
    selection.configuration.kind === 'CONFIGURED'
      ? `configured:${revisionKey(selection.configuration.definitionRevision)}:${jsonValueKey(selection.configuration.value)}`
      : 'none';
  const packageOption =
    selection.packageOption === undefined
      ? 'none'
      : `${resourceKey(selection.packageOption.packageOptionRef)}:${revisionKey(selection.packageOption.contentRevision)}`;
  const setComposition = selection.variantKind === 'SET' ? revisionKey(selection.setCompositionRevision) : 'none';
  return `${selection.variantKind}:${resourceKey(selection.productRef)}:${resourceKey(selection.variantRef)}:${configuration}:${packageOption}:${setComposition}`;
};

const constituentKey = (constituent: AssortmentPurchaseConstituent): string =>
  `${selectionKey(constituent.catalogSelection)}|${constituent.role}`;

const evidenceFor = (
  composition: AssortmentSetCompositionResolution,
  evaluated: readonly AssortmentEvaluatedConstituent[],
): AssortmentSetPurchaseCompositionEvidence => ({
  composition: composition.composition,
  compositionSource: composition,
  evaluated: evaluated.toSorted((left, right) =>
    constituentKey(left.constituent).localeCompare(constituentKey(right.constituent)),
  ),
});

const invalid = (
  reason: AssortmentSetPurchaseCompositionIndeterminate['reason'],
): AssortmentSetPurchaseCompositionResolution => ({ kind: 'INDETERMINATE', reason });

const constituentsFrom = (
  request: AssortmentPurchaseRequest,
  composition: AssortmentSetCompositionResolution,
): readonly AssortmentPurchaseConstituent[] =>
  [request.constituent, ...composition.composition.requiredComponents].toSorted((left, right) =>
    constituentKey(left).localeCompare(constituentKey(right)),
  );

const compositionSourceProvesRevision = (composition: AssortmentSetCompositionResolution): boolean => {
  const revision = composition.composition.setCompositionRevision;
  const { sourceRevision } = composition.source;
  return (
    composition.source.ownerModuleId === revision.ownerModuleId &&
    composition.source.evidenceRef.moduleId === revision.sourceRef.moduleId &&
    composition.source.evidenceRef.tenantId === revision.sourceRef.tenantId &&
    sourceRevision !== undefined &&
    sourceRevision.ownerModuleId === revision.ownerModuleId &&
    sourceRevision.revision === revision.revision &&
    sourceRevision.sourceRef.moduleId === revision.sourceRef.moduleId &&
    sourceRevision.sourceRef.resourceId === revision.sourceRef.resourceId &&
    sourceRevision.sourceRef.resourceType === revision.sourceRef.resourceType &&
    sourceRevision.sourceRef.tenantId === revision.sourceRef.tenantId
  );
};

const decisionEvidenceMatches = (
  request: AssortmentConstituentResolutionRequest,
  constituent: AssortmentPurchaseConstituent,
  decision: AssortmentGovernedDecision,
): boolean => {
  if (decision.evidence === undefined) {
    return decision.outcome === 'INDETERMINATE';
  }
  return (
    decision.evidence.target.kind === 'CATALOG_SELECTION' &&
    selectionEquivalence(decision.evidence.target.selection, constituent.catalogSelection) &&
    subjectEquivalence(decision.evidence.subject, request.subject) &&
    contextEquivalence(decision.evidence.trustedContext, request.trustedContext) &&
    DateTime.toEpochMillis(decision.evidence.operationTime) ===
      DateTime.toEpochMillis(request.trustedContext.operationTime)
  );
};

/** Compose one exact Set PURCHASE from its pinned, owner-resolved constituent identity set. */
export const resolveAssortmentSetPurchase = (
  input: AssortmentSetPurchaseCompositionInput,
  resolveConstituent: AssortmentConstituentResolver,
): AssortmentSetPurchaseCompositionResolution => {
  if (!Schema.is(AssortmentSetPurchaseCompositionInputSchema)(input)) {
    return invalid('INVALID_SET_PURCHASE_REQUEST');
  }
  if (!Schema.is(AssortmentPurchaseRequestSchema)(input.request)) {
    return Schema.is(AssortmentDecisionRequestSchema)(input.request)
      ? invalid('VISIBILITY_NOT_SUPPORTED')
      : invalid('INVALID_SET_PURCHASE_REQUEST');
  }
  if (input.request.decisionPurpose !== 'PURCHASE' || input.request.setComposition === undefined) {
    return invalid('INVALID_SET_PURCHASE_REQUEST');
  }
  if (!compositionSourceProvesRevision(input.composition)) {
    return invalid('COMPOSITION_REVISION_MISMATCH');
  }
  if (!compositionEquivalence(input.request.setComposition, input.composition.composition)) {
    return invalid('COMPOSITION_REVISION_MISMATCH');
  }

  const evaluated: AssortmentEvaluatedConstituent[] = [];
  for (const constituent of constituentsFrom(input.request, input.composition)) {
    const request: AssortmentConstituentResolutionRequest = {
      constituent,
      decisionPurpose: 'PURCHASE',
      subject: requestSubject(input.request),
      trustedContext: input.request.trustedContext,
    };
    const decision = resolveConstituent(request);
    if (!Schema.is(AssortmentGovernedDecisionSchema)(decision)) {
      return invalid('CONSTITUENT_RESOLUTION_INVALID');
    }
    if (!decisionEvidenceMatches(request, constituent, decision)) {
      return invalid('CONSTITUENT_RESOLUTION_INVALID');
    }
    evaluated.push({ constituent, decision });
    if (decision.outcome === 'INELIGIBLE') {
      return {
        evidence: evidenceFor(input.composition, evaluated),
        kind: 'INELIGIBLE',
      };
    }
  }

  const decisions: readonly AssortmentConstituentDecision[] = evaluated.map(({ constituent, decision }) => ({
    constituent,
    outcome: decision.outcome,
  }));
  const outcome = composeAssortmentPurchaseOutcome(decisions);
  if (outcome === 'INDETERMINATE') {
    return {
      evidence: evidenceFor(input.composition, evaluated),
      kind: 'INDETERMINATE',
      reason: 'CONSTITUENT_INDETERMINATE',
    };
  }
  return {
    evidence: evidenceFor(input.composition, evaluated),
    kind: outcome,
  };
};
