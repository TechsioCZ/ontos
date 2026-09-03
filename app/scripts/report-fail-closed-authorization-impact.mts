#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface WouldDenyEvidence {
  readonly denialReason: string;
  readonly entrypointKey: string;
  readonly inventoryHash: string;
  readonly policyClass: string;
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly surface: string;
  readonly timestamp: string;
  readonly type: 'authorization.would_deny';
}

export interface AuthorizationImpactReport {
  readonly aggregates: readonly {
    readonly count: number;
    readonly denialReason: string;
    readonly entrypointKey: string;
    readonly policyClass: string;
    readonly surface: string;
  }[];
  readonly inventoryHash: string;
  readonly observation: { readonly endedAt: string; readonly startedAt: string };
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly totalWouldDeny: number;
}

export interface EmptyAuthorizationObservation {
  readonly endedAt: string;
  readonly inventoryHash: string;
  readonly sourceRevision: string;
  readonly startedAt: string;
}

const evidenceKeys = [
  'denialReason',
  'entrypointKey',
  'inventoryHash',
  'policyClass',
  'schemaVersion',
  'sourceRevision',
  'surface',
  'timestamp',
  'type',
] as const;

const denialReasons = new Set([
  'cross_tenant',
  'expired_credential',
  'infrastructure_unavailable',
  'malformed_credential',
  'missing_policy',
  'module_disabled',
  'replayed_credential',
  'wrong_audience',
]);
const policyClasses = new Set([
  'action_execution',
  'authenticated_principal',
  'capability_issuance',
  'context_permission',
  'owner_local_background',
  'public',
]);
const surfaces = new Set(['action', 'capability_issuance', 'route', 'worker']);
const validHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const validRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9._-]{1,100}$/u.test(value);
const validEntrypointKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/u.test(value);
const validIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const decodeEvidence = (raw: unknown): WouldDenyEvidence => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('authorization evidence must be an object');
  }
  const record = raw as Record<string, unknown>;
  if (
    Object.keys(record).toSorted().join('\0') !== [...evidenceKeys].toSorted().join('\0') ||
    record['schemaVersion'] !== 1 ||
    record['type'] !== 'authorization.would_deny' ||
    !evidenceKeys
      .filter((key) => key !== 'schemaVersion')
      .every((key) => typeof record[key] === 'string') ||
    !denialReasons.has(record['denialReason'] as string) ||
    !validEntrypointKey(record['entrypointKey']) ||
    !validHash(record['inventoryHash']) ||
    !policyClasses.has(record['policyClass'] as string) ||
    !validRevision(record['sourceRevision']) ||
    !surfaces.has(record['surface'] as string) ||
    !validIsoTimestamp(record['timestamp'])
  ) {
    throw new TypeError('authorization evidence is malformed or contains prohibited fields');
  }
  return record as unknown as WouldDenyEvidence;
};

export const reduceAuthorizationImpact = (
  rawEvents: readonly unknown[],
  emptyObservation?: EmptyAuthorizationObservation,
): AuthorizationImpactReport => {
  if (rawEvents.length === 0) {
    if (
      emptyObservation === undefined ||
      !validIsoTimestamp(emptyObservation.startedAt) ||
      !validIsoTimestamp(emptyObservation.endedAt) ||
      !validHash(emptyObservation.inventoryHash) ||
      !validRevision(emptyObservation.sourceRevision) ||
      Date.parse(emptyObservation.startedAt) > Date.parse(emptyObservation.endedAt)
    ) {
      throw new TypeError('empty authorization impact requires explicit observation bounds');
    }
    return {
      aggregates: [],
      inventoryHash: emptyObservation.inventoryHash,
      observation: {
        endedAt: emptyObservation.endedAt,
        startedAt: emptyObservation.startedAt,
      },
      schemaVersion: 1,
      sourceRevision: emptyObservation.sourceRevision,
      totalWouldDeny: 0,
    };
  }
  const events = rawEvents.map(decodeEvidence);
  const revision = events[0]?.sourceRevision ?? '';
  const inventoryHash = events[0]?.inventoryHash ?? '';
  if (
    events.some(
      (event) => event.sourceRevision !== revision || event.inventoryHash !== inventoryHash,
    )
  ) {
    throw new TypeError('authorization evidence mixes source revisions or inventory hashes');
  }
  const counts = new Map<string, AuthorizationImpactReport['aggregates'][number]>();
  for (const event of events) {
    const key = [event.surface, event.entrypointKey, event.policyClass, event.denialReason].join(
      '\0',
    );
    const current = counts.get(key);
    counts.set(key, {
      count: (current?.count ?? 0) + 1,
      denialReason: event.denialReason,
      entrypointKey: event.entrypointKey,
      policyClass: event.policyClass,
      surface: event.surface,
    });
  }
  const timestamps = events.map((event) => event.timestamp).toSorted();
  return {
    aggregates: [...counts.values()].toSorted(
      (left, right) =>
        left.surface.localeCompare(right.surface) ||
        left.entrypointKey.localeCompare(right.entrypointKey) ||
        left.policyClass.localeCompare(right.policyClass) ||
        left.denialReason.localeCompare(right.denialReason),
    ),
    inventoryHash,
    observation: {
      endedAt: timestamps.at(-1) ?? '',
      startedAt: timestamps[0] ?? '',
    },
    schemaVersion: 1,
    sourceRevision: revision,
    totalWouldDeny: events.length,
  };
};

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === import.meta.filename) {
  const root = process.env.ULTRAMODERN_WORKSPACE_ROOT ?? path.resolve(import.meta.dirname, '..');
  const input = process.argv[2] ?? path.join(root, '.codex/reports/authorization/would-deny.json');
  const output = path.join(root, '.codex/reports/authorization/fail-closed-impact.json');
  const raw = JSON.parse(await readFile(input, 'utf-8')) as unknown;
  const report = Array.isArray(raw)
    ? reduceAuthorizationImpact(raw)
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { events?: unknown }).events)
      ? reduceAuthorizationImpact(
          (raw as { events: unknown[] }).events,
          raw as EmptyAuthorizationObservation,
        )
      : (() => {
          throw new TypeError('authorization evidence must be an event array or bounded batch');
        })();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, undefined, 2)}\n`, 'utf-8');
  process.stdout.write(`${output}\n`);
}
