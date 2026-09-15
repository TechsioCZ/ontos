import { Schema } from 'effect';

import type { PurposeVersion } from './processing-purpose.ts';
import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Meaning = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000));

/** A dimension is included only when its value changes the business choice. */
export const ConsentMaterialDimensionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('COMMUNICATION_CHANNEL'),
    value: Schema.Literals(['EMAIL', 'SMS', 'PHONE', 'PUSH']),
  }),
  Schema.Struct({ kind: Schema.Literal('SITE'), value: Ref }),
  Schema.Struct({ kind: Schema.Literal('TECHNOLOGY_CATEGORY'), value: Ref }),
  Schema.Struct({ kind: Schema.Literal('TECHNOLOGY_PROVIDER_SET'), value: Ref }),
  Schema.Struct({ kind: Schema.Literal('JURISDICTION'), value: Ref }),
]);
export type ConsentMaterialDimension = typeof ConsentMaterialDimensionSchema.Type;
export type ConsentMaterialDimensionKind = ConsentMaterialDimension['kind'];

/**
 * The stable business scope of one consent. Capture channel, UI, and transport
 * are provenance, never scope dimensions. An empty materialDimensions list is
 * the explicit representation of a channel-neutral choice.
 */
export const ConsentScopeSchema = Schema.Struct({
  controllerRef: Ref,
  materialDimensions: Schema.Array(ConsentMaterialDimensionSchema).check(Schema.isMaxLength(16)),
  privacySubjectRef: PrivacySubjectRefSchema,
  processingPurposeRef: ProcessingPurposeRefSchema,
  purposeMeaning: Meaning,
  purposeVersionRef: Ref,
  scopeRef: Ref,
});
export type ConsentScope = typeof ConsentScopeSchema.Type;

export interface ConsentScopeValidation {
  readonly errors: readonly string[];
  readonly valid: boolean;
}

export interface ValidateConsentScopeInput {
  /** The catalog version used by the decision, retained as historical evidence. */
  readonly purposeVersion?: PurposeVersion;
  /** Dimensions required by this business choice, not by persistence convenience. */
  readonly requiredDimensions?: readonly ConsentMaterialDimensionKind[];
  readonly scope: ConsentScope;
}

/**
 * Checks that a scope is complete without widening missing material inputs.
 * Purpose meaning and version are checked against the pinned historical version
 * when supplied; current catalog state is never used as a replacement.
 */
export const validateConsentScope = (input: ValidateConsentScopeInput): ConsentScopeValidation => {
  const errors: string[] = [];
  const kinds = input.scope.materialDimensions.map(({ kind }) => kind);
  const presentKinds = new Set(kinds);
  if (presentKinds.size !== kinds.length) {
    errors.push('Consent scope cannot contain duplicate material dimensions');
  }

  for (const required of input.requiredDimensions ?? []) {
    if (!presentKinds.has(required)) {
      errors.push(`Missing material consent dimension: ${required}`);
    }
  }

  const version = input.purposeVersion;
  if (version !== undefined) {
    if (input.scope.purposeVersionRef !== version.versionId) {
      errors.push('Consent scope must pin the used Purpose Version');
    }
    if (input.scope.purposeMeaning !== version.meaning) {
      errors.push('Consent scope must preserve the used Purpose meaning');
    }
  }
  return { errors, valid: errors.length === 0 };
};

/** A channel-neutral scope is represented without a fabricated channel value. */
export const isChannelNeutralConsentScope = (scope: ConsentScope): boolean =>
  !scope.materialDimensions.some(({ kind }) => kind === 'COMMUNICATION_CHANNEL');
