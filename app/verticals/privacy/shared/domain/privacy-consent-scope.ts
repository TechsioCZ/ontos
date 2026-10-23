import type { ConsentMaterialDimensionKind, ConsentScope } from '@app/consent-authority-contracts';
import type { PurposeVersion } from './processing-purpose.ts';

export {
  ConsentScopeSchema,
  ConsentMaterialDimensionKindSchema,
  ConsentMaterialDimensionSchema,
} from '@app/consent-authority-contracts';
export type {
  ConsentScope,
  ConsentMaterialDimensionKind,
  ConsentMaterialDimension,
} from '@app/consent-authority-contracts';

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
