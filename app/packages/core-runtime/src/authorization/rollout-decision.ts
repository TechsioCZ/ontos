import { DateTime } from 'effect';

export const AUTHORIZATION_WOULD_DENY_SCHEMA_VERSION = 1 as const;

export type AuthorizationRolloutMode = 'enforced' | 'report_only';
export type AuthorizationDenialReason =
  | 'cross_tenant'
  | 'expired_credential'
  | 'infrastructure_unavailable'
  | 'malformed_credential'
  | 'missing_policy'
  | 'module_disabled'
  | 'replayed_credential'
  | 'wrong_audience';

export interface AuthorizationRolloutRuntimeContract {
  readonly activatedAtEpochMs: number;
  readonly compatibilityEntrypoints: ReadonlySet<string>;
  readonly expiresAtEpochMs: number;
  readonly inventoryHash: string;
  readonly mode: AuthorizationRolloutMode;
  readonly sourceRevision: string;
}

export interface AuthorizationWouldDenyEvent {
  readonly denialReason: AuthorizationDenialReason;
  readonly entrypointKey: string;
  readonly inventoryHash: string;
  readonly policyClass: string;
  readonly schemaVersion: typeof AUTHORIZATION_WOULD_DENY_SCHEMA_VERSION;
  readonly sourceRevision: string;
  readonly surface: 'action' | 'capability_issuance' | 'route' | 'worker';
  readonly timestamp: string;
  readonly type: 'authorization.would_deny';
}

export interface AuthorizationRolloutDecisionInput {
  readonly candidate: 'allowed' | 'denied';
  readonly current: 'allowed' | 'denied';
  readonly denialReason?: AuthorizationDenialReason;
  readonly entrypointKey: string;
  readonly nowEpochMs: number;
  readonly policyClass: string;
  readonly surface: AuthorizationWouldDenyEvent['surface'];
}

export interface AuthorizationRolloutDecisionOptions {
  readonly contract: AuthorizationRolloutRuntimeContract;
  readonly emit: (event: AuthorizationWouldDenyEvent) => void;
}

const nonBypassableReasons = new Set<AuthorizationDenialReason>([
  'cross_tenant',
  'expired_credential',
  'infrastructure_unavailable',
  'malformed_credential',
  'module_disabled',
  'replayed_credential',
  'wrong_audience',
]);

export const decideAuthorizationRollout = (
  input: AuthorizationRolloutDecisionInput,
  options: AuthorizationRolloutDecisionOptions,
): 'allowed' | 'denied' => {
  if (input.current === 'denied') {
    return 'denied';
  }
  if (input.candidate === 'allowed') {
    return 'allowed';
  }
  const reason = input.denialReason ?? 'infrastructure_unavailable';
  if (nonBypassableReasons.has(reason)) {
    return 'denied';
  }
  const active =
    options.contract.mode === 'report_only' &&
    input.nowEpochMs >= options.contract.activatedAtEpochMs &&
    input.nowEpochMs < options.contract.expiresAtEpochMs;
  const compatible =
    active &&
    input.current === 'allowed' &&
    reason === 'missing_policy' &&
    options.contract.compatibilityEntrypoints.has(input.entrypointKey);
  if (!compatible) {
    return 'denied';
  }
  options.emit({
    denialReason: reason,
    entrypointKey: input.entrypointKey,
    inventoryHash: options.contract.inventoryHash,
    policyClass: input.policyClass,
    schemaVersion: AUTHORIZATION_WOULD_DENY_SCHEMA_VERSION,
    sourceRevision: options.contract.sourceRevision,
    surface: input.surface,
    timestamp: DateTime.formatIso(DateTime.makeUnsafe(input.nowEpochMs)),
    type: 'authorization.would_deny',
  });
  return 'allowed';
};
