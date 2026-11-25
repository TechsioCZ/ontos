import type { OperationalScope } from '@app/core-runtime';

import { defaultPrivacyOwnerCoverageOptions } from './privacy-owner-coverage.service.ts';
import type { PrivacyOwnerCoverageOptions } from './privacy-owner-coverage.service.ts';
import { failClosedOwnerExecutionFacts } from './privacy-owner-execution-receipt.service.ts';
import type { OwnerExecutionFacts } from './privacy-owner-execution-receipt.service.ts';

/**
 * Everything the owner cannot know by itself and that only Privacy, a deployment owner or the owner's own enforcement can
 * supply (audit T3-21, T3-24, R-D11):
 * - `coverage.supplied`, `coverage.eligibility`: Privacy's approved references (purpose, retention rule, controller, legal-hold
 *   applicability, human disposition owner) and its per-right Processing Eligibility;
 * - `coverage.backup`: the deployment owner's authoritative backup evaluation;
 * - `coverage.currentTransportProviderKey`: the configured Messaging Adapter (step 22);
 * - `execution`: Privacy's CURRENT blocker assessment and a real enforcement signal, asked again at every evaluation.
 *
 * Both owner Reads obtain them ONLY through a `PrivacyOwnerInputSource`, so the day an owner publishes a supply Read, one
 * implementation here replaces the default and nothing else changes. Until then the source is the explicit fail-closed form:
 * coverage is never COMPLETE, no input counts as supplied, no hold is assessed and no enforcement exists.
 */
export interface PrivacyOwnerInputs {
  readonly coverage: PrivacyOwnerCoverageOptions;
  readonly execution: OwnerExecutionFacts;
}

export type PrivacyOwnerInputSource = (scope: OperationalScope) => PrivacyOwnerInputs;

export const failClosedPrivacyOwnerInputs: PrivacyOwnerInputs = Object.freeze({
  coverage: defaultPrivacyOwnerCoverageOptions,
  execution: failClosedOwnerExecutionFacts,
});

/** The production source: no owner supplies any input yet (recorded as open owner work, never defaulted to "none needed"). */
export const productionPrivacyOwnerInputSource: PrivacyOwnerInputSource = () => failClosedPrivacyOwnerInputs;
