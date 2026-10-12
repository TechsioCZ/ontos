import type { PrivacyApplicabilityDecision, PrivacyApplicabilityScope } from './privacy-applicability.ts';
import type { PrivacyNoticeVersion } from './privacy-notice-version.ts';

export interface PrivacyNoticeSelectionInput {
  readonly at: string;
  readonly decision: PrivacyApplicabilityDecision;
  /** An explicitly configured, scope-local fallback chain. */
  readonly fallbackLanguages?: readonly string[];
  readonly notices: readonly PrivacyNoticeVersion[];
  readonly requestedLanguage: string;
}

export type PrivacyNoticeSelection =
  | {
      readonly decision: PrivacyApplicabilityDecision;
      readonly kind: 'SELECTED';
      readonly notice: PrivacyNoticeVersion;
      readonly providedLanguage: string;
    }
  | { readonly kind: 'UNCOVERED'; readonly reason: 'NO_LANGUAGE_MATCH' | 'NO_VALID_FALLBACK' }
  | {
      readonly kind: 'INDETERMINATE';
      readonly reason:
        | 'APPLICABILITY_NOT_APPROVED'
        | 'NOTICE_CONFIGURATION_CONFLICT'
        | 'INVALID_FALLBACK_CONFIGURATION';
    };

const stableKey = (parts: readonly string[]): string => parts.map((part) => `${String(part.length)}:${part}`).join('|');

const scopeKey = (scope: PrivacyApplicabilityScope): string =>
  stableKey([
    stableKey(scope.facts.map(({ dimension, value }) => `${dimension}:${value}`).toSorted()),
    scope.operation,
    scope.processingScopeRef.scopeId,
    scope.processingScopeRef.scopeType,
  ]);

const inEffectivePeriod = (notice: PrivacyNoticeVersion, at: string): boolean =>
  notice.effectiveFrom <= at && (notice.effectiveTo === null || at < notice.effectiveTo);

/** Selects exactly one version from an already approved applicability decision. */
export const selectPrivacyNoticeVersion = (input: PrivacyNoticeSelectionInput): PrivacyNoticeSelection => {
  if (input.decision.outcome !== 'APPLICABLE') {
    return { kind: 'INDETERMINATE', reason: 'APPLICABILITY_NOT_APPROVED' };
  }

  const languages = [input.requestedLanguage, ...(input.fallbackLanguages ?? [])];
  if (new Set(languages).size !== languages.length || languages.some((language) => language.trim().length === 0)) {
    return { kind: 'INDETERMINATE', reason: 'INVALID_FALLBACK_CONFIGURATION' };
  }

  const candidates = input.notices.filter(
    (notice) =>
      scopeKey(notice.applicableScope) === scopeKey(input.decision.evaluatedScope) &&
      inEffectivePeriod(notice, input.at),
  );

  for (const language of languages) {
    const matches = candidates.filter((notice) => notice.language === language);
    if (matches.length > 1) {
      return { kind: 'INDETERMINATE', reason: 'NOTICE_CONFIGURATION_CONFLICT' };
    }
    const [notice] = matches;
    if (notice !== undefined) {
      return { decision: input.decision, kind: 'SELECTED', notice, providedLanguage: notice.language };
    }
  }

  return { kind: 'UNCOVERED', reason: languages.length > 1 ? 'NO_VALID_FALLBACK' : 'NO_LANGUAGE_MATCH' };
};
