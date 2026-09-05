import { readFile } from 'node:fs/promises';

export const AUTHORIZATION_ROLLOUT_SCHEMA_VERSION = 1 as const;

export interface AuthorizationRolloutContract {
  readonly activatedAt: string;
  readonly baselineInventoryHash: string;
  readonly baselineSourceRevision: string;
  readonly compatibilityEligibleEntrypoints: readonly string[];
  readonly decisionReference: string;
  readonly expiresAt: string;
  readonly mode: 'enforced' | 'report_only';
  readonly schemaVersion: typeof AUTHORIZATION_ROLLOUT_SCHEMA_VERSION;
}

const exactKeys = [
  'activatedAt',
  'baselineInventoryHash',
  'baselineSourceRevision',
  'compatibilityEligibleEntrypoints',
  'decisionReference',
  'expiresAt',
  'mode',
  'schemaVersion',
] as const;

export interface RolloutValidationContext {
  readonly entrypointKeys?: ReadonlySet<string>;
  readonly inventoryHash: string;
  readonly nowEpochMs: number;
}

export const validateAuthorizationRolloutContract = (
  raw: unknown,
  context: RolloutValidationContext,
): AuthorizationRolloutContract => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('authorization rollout contract must be an object');
  }
  const record = raw as Record<string, unknown>;
  if (
    Object.keys(record).toSorted().join('\0') !== [...exactKeys].toSorted().join('\0') ||
    record['schemaVersion'] !== AUTHORIZATION_ROLLOUT_SCHEMA_VERSION ||
    (record['mode'] !== 'report_only' && record['mode'] !== 'enforced') ||
    typeof record['activatedAt'] !== 'string' ||
    typeof record['expiresAt'] !== 'string' ||
    typeof record['baselineInventoryHash'] !== 'string' ||
    typeof record['baselineSourceRevision'] !== 'string' ||
    typeof record['decisionReference'] !== 'string' ||
    !Array.isArray(record['compatibilityEligibleEntrypoints']) ||
    !record['compatibilityEligibleEntrypoints'].every((value) => typeof value === 'string')
  ) {
    throw new TypeError('authorization rollout contract is malformed');
  }
  const activatedAtEpochMs = Date.parse(record['activatedAt']);
  const expiresAtEpochMs = Date.parse(record['expiresAt']);
  if (
    !Number.isFinite(activatedAtEpochMs) ||
    !Number.isFinite(expiresAtEpochMs) ||
    activatedAtEpochMs >= expiresAtEpochMs ||
    context.nowEpochMs < activatedAtEpochMs ||
    (record['mode'] === 'report_only' && context.nowEpochMs >= expiresAtEpochMs)
  ) {
    throw new TypeError('authorization rollout contract is inactive or expired');
  }
  if (
    record['baselineInventoryHash'] !== context.inventoryHash ||
    !/^[a-zA-Z0-9._-]{1,100}$/u.test(record['baselineSourceRevision'])
  ) {
    throw new TypeError('authorization rollout contract does not match the classified inventory');
  }
  if (
    !/^(?:https:\/\/github\.com\/TechsioCZ\/ontos\/issues\/\d+|ADR-\d{4})$/u.test(
      record['decisionReference'],
    )
  ) {
    throw new TypeError('authorization rollout contract requires an auditable decision reference');
  }
  const compatibilityEligibleEntrypoints = [
    ...new Set(record['compatibilityEligibleEntrypoints']),
  ].toSorted();
  if (
    compatibilityEligibleEntrypoints.length !== record['compatibilityEligibleEntrypoints'].length
  ) {
    throw new TypeError('authorization rollout compatibility baseline contains duplicates');
  }
  if (
    context.entrypointKeys !== undefined &&
    compatibilityEligibleEntrypoints.some((entrypoint) => !context.entrypointKeys?.has(entrypoint))
  ) {
    throw new TypeError(
      'authorization rollout compatibility baseline contains an unknown entrypoint',
    );
  }
  return {
    activatedAt: record['activatedAt'],
    baselineInventoryHash: record['baselineInventoryHash'],
    baselineSourceRevision: record['baselineSourceRevision'],
    compatibilityEligibleEntrypoints,
    decisionReference: record['decisionReference'],
    expiresAt: record['expiresAt'],
    mode: record['mode'],
    schemaVersion: AUTHORIZATION_ROLLOUT_SCHEMA_VERSION,
  };
};

export const loadAuthorizationRolloutContract = async (
  file: string,
  context: RolloutValidationContext,
): Promise<AuthorizationRolloutContract> =>
  validateAuthorizationRolloutContract(JSON.parse(await readFile(file, 'utf-8')), context);
