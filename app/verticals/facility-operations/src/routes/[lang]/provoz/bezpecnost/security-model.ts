// Security agenda view model: labels and the linked service task in work-tasks.
// The task is created through work-tasks's PUBLIC apply-command Action (its own gateway audience),
// never by touching that module's tables; the incident only stores the returned TaskRef snapshot.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { CalendarDateWireSchema } from '@app/shared-contracts';
import type { TOptions } from 'i18next';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { executeApplyCommand as executeWorkCommand } from '@app/work-tasks/clients/apply-command';
import { executeRecords as executeWorkRecords } from '@app/work-tasks/clients/records';
import type { ContextRef } from '@app/work-tasks/contracts/records';
import { DateTime, Effect, Predicate, Random } from 'effect';
import { useEffect, useState } from 'react';
import type { PropertyRef } from '../../../../../shared/domain/common.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
import type { SecurityDevice, SecurityIncident, SecuritySeverity } from '../../../../../shared/domain/security.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

export const useSecurityLabel = () => {
  const { t } = useModernI18n();
  return (key: string, options?: TOptions) => t(`facility-operations.security.${key}`, options ?? {});
};

export type SecurityLabel = ReturnType<typeof useSecurityLabel>;

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

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);

/** work-tasks context reference for the device's property/unit (only real property-module ids). */
const contextRefsOf = (location: PropertyRef | undefined, tenantId: string): ContextRef[] => {
  if (location === undefined || !isUuid(location.id) || location.kind === 'asset') {
    return [];
  }
  return location.kind === 'property'
    ? [
        {
          moduleId: 'property.portfolio',
          resourceId: location.id,
          resourceType: 'property.portfolio.property',
          tenantId,
        },
      ]
    : [{ moduleId: 'property.portfolio', resourceId: location.id, resourceType: 'property.portfolio.unit', tenantId }];
};

const correlation = Effect.map(
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }),
  ([first, second]) => `facility-operations:security:${first}:${second}`,
);

const priorities = { critical: 'HIGH', high: 'HIGH', low: 'LOW', medium: 'NORMAL' } as const;
const priorityOf = (severity: SecuritySeverity) => priorities[severity];

export interface LinkedTaskDraft {
  readonly description: string;
  readonly dueDate: typeof CalendarDateWireSchema.Type;
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
 * Creates one task with its structured property/unit link and a same-principal owner-read credential.
 * Only a revision conflict is retried. Never hide a refused reference by creating an unlinked task.
 */
export const createServiceTask = (draft: LinkedTaskDraft, device: SecurityDevice, tenantId: string) => {
  const attempt = Effect.fn('Security.createServiceTaskAttempt')(function* attempt(contextRefs: ContextRef[]) {
    const requestId = yield* correlation;
    const records = yield* executeWorkRecords({ state: 'NEW' }, requestId);
    const idempotencyKey = yield* correlation;
    const referenceCredentials = yield* makeReferenceGatewayCredentials(contextRefs.map(() => 'property-portfolio'));
    return yield* executeWorkCommand(
      {
        command: {
          _tag: 'CreateTask',
          ...optionalField('contextRefs', contextRefs.length === 0 ? undefined : contextRefs),
          description: draft.description.slice(0, 2000),
          dueDate: draft.dueDate,
          priority: priorityOf(draft.severity),
          title: draft.title.slice(0, 200),
        },
        expectedRevision: records.revision,
      },
      idempotencyKey,
      { idempotencyKey, referenceCredentials },
    );
  });
  const refs = contextRefsOf(device.location, tenantId);

  const program = attempt(refs).pipe(
    Effect.retry({ times: 1, while: (error) => Predicate.isTagged(error, 'ApplyCommandActionConflictProblem') }),
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
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logWarning('Service task creation failed', error).pipe(Effect.as({ ok: false } as const)),
      onSuccess: Effect.succeed,
    }),
  );
  return program;
};

export type LiveTaskState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly state: string | undefined; readonly status: 'ready' };

const failedTaskStates = (ids: readonly string[]) =>
  Object.fromEntries(ids.map((id) => [id, { status: 'failed' } as const]));
const readyTaskStates = (ids: readonly string[], records: Effect.Success<ReturnType<typeof executeWorkRecords>>) =>
  Object.fromEntries(
    ids.map((id) => [
      id,
      {
        state: records.items.find((task) => task.ref.resourceId === id)?.state,
        status: 'ready',
      } as const,
    ]),
  );
const readTaskStates = (ids: readonly string[]) =>
  correlation.pipe(
    Effect.flatMap((requestId) => executeWorkRecords({}, requestId)),
    Effect.map((records) => readyTaskStates(ids, records)),
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logWarning('Linked service task read failed', error).pipe(Effect.as(failedTaskStates(ids))),
      onSuccess: Effect.succeed,
    }),
  );

/** Reads the current state of linked tasks from work-tasks (one governed read for the open detail). */
export const useLiveTaskStates = (resourceIds: readonly string[]) => {
  const key = resourceIds.toSorted().join(',');
  const [states, setStates] = useState<Readonly<Record<string, LiveTaskState>>>({});
  useEffect(() => {
    let alive = true;
    if (key !== '') {
      void browserRuntime.runPromise(
        readTaskStates(key.split(',')).pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              if (alive) {
                setStates(next);
              }
            }),
          ),
        ),
      );
    }
    return () => {
      alive = false;
    };
  }, [key]);
  return states;
};

export const locationText = (device: SecurityDevice, missing: string) =>
  [device.location?.label, device.locationDetail].filter((part) => part !== undefined && part !== '').join(' · ') ||
  missing;
