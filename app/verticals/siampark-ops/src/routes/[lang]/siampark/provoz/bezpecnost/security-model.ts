// @effect-diagnostics asyncFunction:off
// Security agenda view model: labels, persona names and the linked service task in siampark-work.
// The task is created through siampark-work's PUBLIC apply-command Action (its own gateway audience),
// never by touching that module's tables; the incident only stores the returned TaskRef snapshot.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { executeApplyCommand as executeWorkCommand } from '@app/siampark-work/clients/apply-command';
import { executeRecords as executeWorkRecords } from '@app/siampark-work/clients/records';
import type { ContextRef } from '@app/siampark-work/contracts/records';
import { DateTime, Effect, Random } from 'effect';
import { useEffect, useState } from 'react';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import type { PropertyRef } from '../../../../../../shared/domain/common.ts';
import type { SecurityDevice, SecurityIncident, SecuritySeverity } from '../../../../../../shared/domain/security.ts';
import { browserRuntime } from '../../../../../runtime/browser-effect-runtime.ts';

export const useSecurityLabel = () => {
  const { t } = useModernI18n();
  return (key: string, options?: Record<string, unknown>) => t(`siampark-ops.security.${key}`, options ?? {});
};

export type SecurityLabel = ReturnType<typeof useSecurityLabel>;

const personaByPrincipal: Readonly<Record<string, string>> = {
  '72000000-0000-4000-8000-000000000021': 'management',
  '72000000-0000-4000-8000-000000000022': 'operations',
  '72000000-0000-4000-8000-000000000023': 'finance',
  '72000000-0000-4000-8000-000000000024': 'external',
};

/** Display name of a demo persona; unknown principals show a short id (no invented names). */
export const personaName = (label: SecurityLabel, principal: PrincipalRef) => {
  const persona = personaByPrincipal[principal.principalId];
  return persona === undefined
    ? label('persona.unknown', { id: principal.principalId.slice(0, 8) })
    : label(`persona.${persona}`);
};

const pragueDate = new Intl.DateTimeFormat('sv-SE', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Prague',
  year: 'numeric',
});

/** Today's business date in Prague (YYYY-MM-DD). */
export const todayPrague = () => pragueDate.format(DateTime.toEpochMillis(DateTime.nowUnsafe()));

export const addDays = (iso: string, days: number) =>
  DateTime.makeUnsafe(`${iso}T12:00:00Z`).pipe(DateTime.add({ days }), DateTime.formatIsoDateUtc);

export const severityVariant = (severity: SecuritySeverity) =>
  (({ critical: 'danger', high: 'danger', low: 'outline', medium: 'warning' }) as const)[severity];

export const deviceStateVariant = (state: SecurityDevice['state']) =>
  (({ decommissioned: 'outline', fault: 'danger', in_operation: 'success', in_service: 'warning' }) as const)[state];

export const incidentStateVariant = (state: SecurityIncident['state']) =>
  (({ in_progress: 'info', reported: 'warning', resolved: 'success' }) as const)[state];

export const deviceTypeIcon = (type: SecurityDevice['deviceType']) =>
  (
    ({
      access: 'icon-[mdi--card-account-details-outline]',
      alarm: 'icon-[mdi--alarm-light-outline]',
      camera: 'icon-[mdi--cctv]',
      other: 'icon-[mdi--shield-check-outline]',
    }) as const
  )[type];

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** siampark-work context reference for the device's property/unit (only real property-module ids). */
const contextRefsOf = (location: PropertyRef | undefined, tenantId: string): ContextRef[] => {
  if (location === undefined || !isUuid(location.id) || location.kind === 'asset') {
    return [];
  }
  return location.kind === 'property'
    ? [
        {
          moduleId: 'siampark.property',
          resourceId: location.id,
          resourceType: 'siampark.property.property',
          tenantId,
        },
      ]
    : [{ moduleId: 'siampark.property', resourceId: location.id, resourceType: 'siampark.property.unit', tenantId }];
};

const correlation = Effect.map(
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }),
  ([first, second]) => `siampark-ops:security:${first}:${second}`,
);

const priorityOf = (severity: SecuritySeverity) =>
  severity === 'critical' || severity === 'high'
    ? ('HIGH' as const)
    : severity === 'medium'
      ? ('NORMAL' as const)
      : ('LOW' as const);

export interface LinkedTaskDraft {
  readonly description: string;
  readonly dueDate: string;
  readonly severity: SecuritySeverity;
  readonly title: string;
}

export type TaskCreation =
  | {
      readonly ok: true;
      readonly task: { readonly resourceId: string; readonly tenantId: string; readonly title: string };
    }
  | { readonly ok: false };

/**
 * Creates one task in siampark-work: reads its current revision, sends CreateTask with a fresh idempotency key and
 * the device's property/unit as context. If the context reference is refused, retries once without it.
 */
export const createServiceTask = async (
  draft: LinkedTaskDraft,
  device: SecurityDevice,
  tenantId: string,
): Promise<TaskCreation> => {
  const attempt = (contextRefs: ContextRef[]) =>
    correlation.pipe(
      Effect.flatMap((requestId) => executeWorkRecords({ state: 'NEW' }, requestId)),
      Effect.flatMap((records) =>
        correlation.pipe(
          Effect.flatMap((idempotencyKey) =>
            executeWorkCommand(
              {
                command: {
                  _tag: 'CreateTask',
                  ...(contextRefs.length === 0 ? {} : { contextRefs }),
                  description: draft.description.slice(0, 2000),
                  dueDate: draft.dueDate,
                  priority: priorityOf(draft.severity),
                  title: draft.title.slice(0, 200),
                },
                expectedRevision: records.revision,
              },
              idempotencyKey,
              { idempotencyKey },
            ),
          ),
        ),
      ),
    );
  const refs = contextRefsOf(device.location, tenantId);

  // One retry covers a concurrent revision bump; the last one drops a refused context reference.
  const program = Effect.firstSuccessOf([
    attempt(refs),
    Effect.suspend(() => attempt(refs)),
    Effect.suspend(() => attempt([])),
  ]).pipe(
    Effect.map((result): TaskCreation =>
      result.task === undefined
        ? { ok: false }
        : {
            ok: true,
            task: {
              resourceId: result.task.ref.resourceId,
              tenantId: result.task.ref.tenantId,
              title: result.task.title,
            },
          },
    ),
    Effect.orElseSucceed((): TaskCreation => ({ ok: false })),
  );
  return browserRuntime.runPromise(program);
};

export type LiveTaskState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly state: string | undefined };

/** Reads the current state of linked tasks from siampark-work (one governed read for the open detail). */
export const useLiveTaskStates = (resourceIds: readonly string[]) => {
  const key = resourceIds.toSorted().join(',');
  const [states, setStates] = useState<Readonly<Record<string, LiveTaskState>>>({});
  useEffect(() => {
    if (key === '') {
      return;
    }
    let alive = true;
    const ids = key.split(',');
    void browserRuntime.runPromise(
      correlation.pipe(
        Effect.flatMap((requestId) => executeWorkRecords({}, requestId)),
        Effect.match({
          onFailure: () => Object.fromEntries(ids.map((id) => [id, { status: 'failed' } as const])),
          onSuccess: (records) =>
            Object.fromEntries(
              ids.map((id) => [
                id,
                {
                  state: records.items.find((task) => task.ref.resourceId === id)?.state,
                  status: 'ready',
                } as const,
              ]),
            ),
        }),
        Effect.map((next) => {
          if (alive) {
            setStates(next);
          }
        }),
      ),
    );
    return () => {
      alive = false;
    };
  }, [key]);
  return states;
};

export const locationText = (device: SecurityDevice, missing: string) =>
  [device.location?.label, device.locationDetail].filter((part) => part !== undefined && part !== '').join(' · ') ||
  missing;
