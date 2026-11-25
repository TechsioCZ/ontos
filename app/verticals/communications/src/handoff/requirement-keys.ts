/**
 * The operations that ask ANOTHER owner something Now: the intake Action and the two pre-handoff workers (both run the same
 * pre-handoff step, `reconcile-provider-evidence` after it has settled the evidence). Core binds an operation requirement to ONE
 * consuming entrypoint, so each of them names its own requirement for the same ask.
 */
export const OWNER_ASK_CONSUMERS = {
  PREPARE_HANDOFF: 'communications.core.prepare-message-handoff',
  RECONCILE_EVIDENCE: 'communications.core.reconcile-provider-evidence',
  SUBMIT: 'communications.core.submit-communication-request',
} as const;

export type OwnerAskConsumer = (typeof OWNER_ASK_CONSUMERS)[keyof typeof OWNER_ASK_CONSUMERS];

/**
 * The published owner Reads Communications asks. Each names the provider operation the manifest requires, the branch condition
 * and the evidence meanings it relies on, and the requirement key per consuming entrypoint that the adapter sends and Core
 * matches against the manifest's `requirements.operations`. The condition and evidence names are PROPOSED: no owner has
 * confirmed them (R-D9); they are Communications' own vocabulary and Core never evaluates them.
 */
export const OWNER_ASKS = {
  /** Auth's Current state and original endpoint binding of the issuance a Communication Request names. */
  AUTH_ISSUANCE_SOURCE: {
    condition: 'communications.core.condition.current-source-occurrence',
    evidence: [
      'communications.core.evidence.auth.current-issuance-state',
      'communications.core.evidence.auth.original-endpoint-binding',
    ],
    keys: {
      [OWNER_ASK_CONSUMERS.PREPARE_HANDOFF]: 'communications.core.requirement.prepare-handoff-auth-issuance-source',
      [OWNER_ASK_CONSUMERS.RECONCILE_EVIDENCE]:
        'communications.core.requirement.reconcile-evidence-auth-issuance-source',
      [OWNER_ASK_CONSUMERS.SUBMIT]: 'communications.core.requirement.submit-auth-issuance-source',
    },
    provider: {
      entrypointKey: 'commerce.customer-context.api.portal-auth-issuance-source',
      moduleId: 'commerce.customer-context',
      schemaVersion: '1',
    },
  },
  /** Privacy's Current eligibility of a subject Privacy bound before its address was verified. */
  PRIVACY_PRE_VERIFICATION: {
    condition: 'communications.core.condition.current-pre-verification-processing',
    evidence: ['communications.core.evidence.privacy.current-pre-verification-eligibility'],
    keys: {
      [OWNER_ASK_CONSUMERS.PREPARE_HANDOFF]: 'communications.core.requirement.prepare-handoff-privacy-pre-verification',
      [OWNER_ASK_CONSUMERS.RECONCILE_EVIDENCE]:
        'communications.core.requirement.reconcile-evidence-privacy-pre-verification',
      [OWNER_ASK_CONSUMERS.SUBMIT]: 'communications.core.requirement.submit-privacy-pre-verification',
    },
    provider: {
      entrypointKey: 'privacy.core.api.pre-verification-eligibility',
      moduleId: 'privacy.core',
      schemaVersion: '1',
    },
  },
  /** Privacy's Current eligibility of an exact source record or Party target. */
  PRIVACY_SOURCE_PROCESSING: {
    condition: 'communications.core.condition.current-source-processing',
    evidence: ['communications.core.evidence.privacy.current-source-processing-eligibility'],
    keys: {
      [OWNER_ASK_CONSUMERS.PREPARE_HANDOFF]:
        'communications.core.requirement.prepare-handoff-privacy-source-processing',
      [OWNER_ASK_CONSUMERS.RECONCILE_EVIDENCE]:
        'communications.core.requirement.reconcile-evidence-privacy-source-processing',
      [OWNER_ASK_CONSUMERS.SUBMIT]: 'communications.core.requirement.submit-privacy-source-processing',
    },
    provider: {
      entrypointKey: 'privacy.core.api.source-processing-eligibility',
      moduleId: 'privacy.core',
      schemaVersion: '1',
    },
  },
} as const;

export type OwnerAsk = keyof typeof OWNER_ASKS;

/** The requirement the manifest declares for ONE ask made by ONE consuming entrypoint. */
export const ownerAskRequirementKey = (consumer: OwnerAskConsumer, ask: OwnerAsk): string =>
  OWNER_ASKS[ask].keys[consumer];
