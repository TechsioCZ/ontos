import { DateTime, Schema } from 'effect';

import type { CatalogSelectionRevision } from '../../shared/domain/catalog-selection-evidence.ts';
import type {
  ProductConfiguration,
  ProductConfigurationDefinitionRevision,
  ProductConfigurationRevisionEquivalenceAttestation,
} from '../../shared/domain/product-configuration.ts';
import type {
  CurrentConfigurationAssessment,
  CurrentConfigurationAssessmentInput,
} from '../persistence/product-configuration-current-evaluator.ts';
import { assessProductConfigurationEquivalence } from './product-configuration-equivalence.ts';

/**
 * #479 owns the durable open-selection population and its Current basis. Catalog never infers
 * that population from private rows, so an absent authority fails closed instead of assuming
 * that no earlier selection is affected.
 */
export interface ProductConfigurationReassessmentAuthority {
  readonly complete: true;
  readonly observedAt: Date;
  readonly revisionToken: string;
  readonly selectionId: string;
}

const ProductConfigurationChangeKindSchema = Schema.Literals(['DOCUMENTED_EQUIVALENCE', 'EXACT_REVISION']);
type ProductConfigurationChangeKind = typeof ProductConfigurationChangeKindSchema.Type;

export type ProductConfigurationReassessment =
  | {
      readonly assessedAt: Date;
      readonly changeKind: ProductConfigurationChangeKind;
      readonly currentDefinitionRevision: number;
      /** The earlier selection verbatim: never upgraded, substituted, or repaired. */
      readonly selection: ProductConfiguration;
      readonly status: 'CURRENT';
    }
  | {
      readonly assessedAt: Date;
      readonly code: string;
      readonly currentDefinitionRevision?: number;
      readonly reason: string;
      readonly ruleIds: readonly string[];
      readonly selection: ProductConfiguration;
      readonly status: 'INVALIDATED';
    }
  | {
      readonly assessedAt: Date;
      readonly reason: string;
      readonly selection: ProductConfiguration;
      readonly status: 'INDETERMINATE';
    };

export interface ProductConfigurationAssessmentSide {
  readonly assessment?: CurrentConfigurationAssessment;
  readonly definition?: ProductConfigurationDefinitionRevision;
  readonly input: CurrentConfigurationAssessmentInput;
}

export interface ProductConfigurationReassessmentInput {
  /** #460 owner-issued proof is the only way a revision change stays immaterial. */
  readonly attestation?: ProductConfigurationRevisionEquivalenceAttestation;
  readonly authority?: ProductConfigurationReassessmentAuthority;
  readonly current: ProductConfigurationAssessmentSide;
  readonly earlier: ProductConfigurationAssessmentSide;
  readonly selection: ProductConfiguration;
}

type InvalidatedReassessment = Extract<ProductConfigurationReassessment, { status: 'INVALIDATED' }>;

const epoch = (value: Date): number => DateTime.toEpochMillis(DateTime.makeUnsafe(value));
const nonBlank = (value: string): boolean => value.length > 0 && value === value.trim();

const authorityUsable = (authority: ProductConfigurationReassessmentAuthority | undefined, at: Date): boolean =>
  authority !== undefined &&
  authority.complete &&
  epoch(authority.observedAt) === epoch(at) &&
  nonBlank(authority.selectionId) &&
  nonBlank(authority.revisionToken);

const retained = (selection: ProductConfiguration): ProductConfiguration => structuredClone(selection);

const indeterminate = (
  selection: ProductConfiguration,
  at: Date,
  reason: string,
): ProductConfigurationReassessment => ({ assessedAt: at, reason, selection, status: 'INDETERMINATE' });

const invalidated = (
  selection: ProductConfiguration,
  at: Date,
  code: string,
  ruleIds: readonly string[],
  definitionRevision: number | undefined,
  reason: string,
): InvalidatedReassessment => {
  const result: InvalidatedReassessment = {
    assessedAt: at,
    code,
    reason,
    ruleIds,
    selection,
    status: 'INVALIDATED',
  };
  return definitionRevision === undefined ? result : { ...result, currentDefinitionRevision: definitionRevision };
};

const currentResult = (
  selection: ProductConfiguration,
  at: Date,
  changeKind: ProductConfigurationChangeKind,
  currentDefinitionRevision: number,
): ProductConfigurationReassessment => ({
  assessedAt: at,
  changeKind,
  currentDefinitionRevision,
  selection,
  status: 'CURRENT',
});

/** Re-express the exact selected values at another Definition revision without selecting anything new. */
const reexpress = (selection: ProductConfiguration, reference: CatalogSelectionRevision): ProductConfiguration => {
  const candidate: ProductConfiguration = {
    definition: reference,
    productRef: selection.productRef,
    values: structuredClone(selection.values),
    variantRef: selection.variantRef,
  };
  if (selection.packageOptionRef !== undefined) {
    Object.assign(candidate, { packageOptionRef: selection.packageOptionRef });
  }
  return candidate;
};

const sameRevisionAttested = (
  earlier: CurrentConfigurationAssessment,
  current: CurrentConfigurationAssessment,
  selection: ProductConfiguration,
): boolean =>
  earlier.status === 'VALID' &&
  current.status === 'VALID' &&
  earlier.definitionRevision !== undefined &&
  earlier.definitionRevision === current.definitionRevision &&
  current.definitionId === selection.definition.resourceRef.resourceId;

/**
 * Catalog-owned decision for a Definition change against an earlier selection. It consumes only
 * owner-issued Current assessments and #460 equivalence evidence, retains the earlier exact
 * revisions, and never rewrites a value or substitutes a successor.
 */
export const reassessProductConfigurationChange = (
  input: ProductConfigurationReassessmentInput,
): ProductConfigurationReassessment => {
  const selection = retained(input.selection);
  const { assessment: current, definition: currentDefinition, input: currentInput } = input.current;
  const { assessment: earlier, definition: earlierDefinition, input: earlierInput } = input.earlier;
  const { at } = currentInput;
  if (!authorityUsable(input.authority, at)) {
    return indeterminate(selection, at, 'Owner-issued #479 open-selection and Current evidence is unavailable');
  }
  if (current === undefined) {
    return indeterminate(selection, at, 'Current Configuration assessment is unavailable');
  }
  if (current.status === 'INVALID') {
    return invalidated(
      selection,
      at,
      current.code,
      current.ruleIds,
      current.definitionRevision,
      `Configuration change is material: ${current.code}`,
    );
  }
  if (current.status === 'INDETERMINATE') {
    return indeterminate(selection, at, `Current Configuration assessment is indeterminate: ${current.code}`);
  }
  if (earlier?.status !== 'VALID') {
    return indeterminate(selection, at, 'The earlier selection is not owner-attested as VALID at its exact revision');
  }
  if (sameRevisionAttested(earlier, current, selection)) {
    const proof = assessProductConfigurationEquivalence(
      selection,
      earlierDefinition,
      earlierInput,
      earlier,
      selection,
      earlierDefinition,
      currentInput,
      current,
      input.attestation,
    );
    return proof.status === 'VALID' && proof.same === true
      ? currentResult(selection, at, 'EXACT_REVISION', current.definitionRevision ?? selection.definition.revision)
      : indeterminate(
          selection,
          at,
          proof.status === 'VALID' ? 'Current assessment does not match the earlier selection' : proof.reason,
        );
  }
  if (earlierDefinition === undefined || currentDefinition === undefined) {
    return indeterminate(selection, at, 'Exact Definition revisions are unavailable');
  }
  const proof = assessProductConfigurationEquivalence(
    selection,
    earlierDefinition,
    earlierInput,
    earlier,
    reexpress(selection, currentDefinition.reference),
    currentDefinition,
    currentInput,
    current,
    input.attestation,
  );
  if (proof.status !== 'VALID') {
    return indeterminate(selection, at, proof.reason);
  }
  return proof.same === true
    ? currentResult(
        selection,
        at,
        'DOCUMENTED_EQUIVALENCE',
        current.definitionRevision ?? currentDefinition.reference.revision,
      )
    : invalidated(
        selection,
        at,
        'SELECTED_VALUE_MEANING_CHANGED',
        [],
        current.definitionRevision,
        'A changed Definition revision no longer preserves the selected value meaning',
      );
};
