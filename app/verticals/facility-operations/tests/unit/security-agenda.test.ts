import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FacilityOperationsLifecycleConflict } from '../../shared/errors/facility-operations-lifecycle-conflict.ts';
import { FacilityOperationsNotFound } from '../../shared/errors/facility-operations-not-found.ts';
import { SecurityCommandSchema, evolveSecurity, isInspectionOverdue } from '../../shared/commands/security.ts';
import { SecurityStateSchema, emptySecurityState } from '../../shared/domain/security.ts';
import type { SecurityState } from '../../shared/domain/security.ts';
import type { OpsCommandInput } from '../../shared/domain/common.ts';
import { seedSecurityState } from '../../scripts/seed/security.mts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const input = (resourceId: string, iso = '2026-10-20T08:00:00Z'): OpsCommandInput => ({
  actor,
  now: DateTime.makeUnsafe(iso),
  resourceId,
});

const apply = (state: SecurityState, command: typeof SecurityCommandSchema.Encoded, resourceId = 'cmd') =>
  Schema.decodeUnknownEffect(SecurityCommandSchema)(command).pipe(
    Effect.orDie,
    Effect.flatMap((decoded) => evolveSecurity(state, decoded, input(resourceId))),
  );

const emptyState = Schema.decodeUnknownEffect(SecurityStateSchema)(emptySecurityState).pipe(Effect.orDie);

const withCamera = Effect.gen(function* withCamera() {
  const state = yield* emptyState;
  return yield* apply(
    state,
    {
      _tag: 'SecurityDeviceCreate',
      deviceType: 'camera',
      location: { id: 'p-1', kind: 'property', label: 'Riverside Office Park (RIVERSIDE)' },
      name: 'Kamera K-02 parkoviště',
      nextInspectionDate: '2026-10-01',
    },
    'device-1',
  );
});

it.effect('creates a device card in operation with an audit stamp and history', () =>
  Effect.gen(function* createCard() {
    const change = yield* withCamera;
    const [device] = change.state.devices;
    expect(change.entityIds).toEqual(['device-1']);
    expect(device?.state).toBe('in_operation');
    expect(device?.createdBy).toEqual(actor);
    expect(device?.history?.map((entry) => entry.event)).toEqual(['created']);
    expect(device === undefined ? false : isInspectionOverdue(device, '2026-10-20')).toBe(true);
  }),
);

it.effect('rejects an unknown device type before the reducer runs', () =>
  Effect.gen(function* invalidType() {
    const failed = yield* Schema.decodeUnknownEffect(SecurityCommandSchema)({
      _tag: 'SecurityDeviceCreate',
      deviceType: 'drone',
      name: 'X',
    }).pipe(Effect.flip);
    expect(failed).toBeDefined();
  }),
);

it.effect('S11-01: reporting a fault marks the device faulty, links a task once, resolve restores operation', () =>
  Effect.gen(function* faultFlow() {
    const created = yield* withCamera;
    const reported = yield* apply(
      created.state,
      {
        _tag: 'SecurityIncidentReport',
        deviceId: 'device-1',
        occurredOn: '2026-10-20',
        severity: 'high',
        title: 'Kamera nezobrazuje obraz',
      },
      'incident-1',
    );
    expect(reported.state.devices[0]?.state).toBe('fault');
    expect(reported.state.incidents?.[0]?.state).toBe('reported');

    const task = { resourceId: 'task-9', tenantId, title: 'Servis: Kamera K-02 parkoviště' };
    const linked = yield* apply(reported.state, { _tag: 'SecurityIncidentLinkTask', incidentId: 'incident-1', task });
    expect(linked.state.incidents?.[0]?.task?.resourceId).toBe('task-9');
    expect(
      yield* apply(linked.state, { _tag: 'SecurityIncidentLinkTask', incidentId: 'incident-1', task }).pipe(
        Effect.flip,
      ),
    ).toBeInstanceOf(FacilityOperationsLifecycleConflict);

    const resolved = yield* apply(linked.state, {
      _tag: 'SecurityIncidentChangeState',
      incidentId: 'incident-1',
      resolution: 'Vyměněn PoE switch.',
      state: 'resolved',
    });
    expect(resolved.state.incidents?.[0]?.state).toBe('resolved');
    expect(resolved.state.incidents?.[0]?.resolvedAt).toBeDefined();
    expect(resolved.state.devices[0]?.state).toBe('in_operation');
    expect(resolved.state.devices[0]?.history?.map((entry) => entry.event)).toEqual([
      'created',
      'incident_reported',
      'task_linked',
      'incident_state',
    ]);

    const reopened = yield* apply(resolved.state, {
      _tag: 'SecurityIncidentChangeState',
      incidentId: 'incident-1',
      state: 'in_progress',
    });
    expect(reopened.state.incidents?.[0]?.resolvedAt).toBeUndefined();
    expect(reopened.state.devices[0]?.state).toBe('fault');
  }),
);

it.effect('refuses invalid transitions, unknown records and faults on decommissioned devices', () =>
  Effect.gen(function* refusals() {
    const created = yield* withCamera;
    expect(
      yield* apply(created.state, { _tag: 'SecurityIncidentChangeState', incidentId: 'nope', state: 'resolved' }).pipe(
        Effect.flip,
      ),
    ).toBeInstanceOf(FacilityOperationsNotFound);
    const retired = yield* apply(created.state, {
      _tag: 'SecurityDeviceUpdate',
      deviceId: 'device-1',
      state: 'decommissioned',
    });
    expect(retired.state.devices[0]?.history?.at(-1)?.event).toBe('state_changed');
    expect(
      yield* apply(retired.state, {
        _tag: 'SecurityIncidentReport',
        deviceId: 'device-1',
        occurredOn: '2026-10-20',
        severity: 'low',
        title: 'X',
      }).pipe(Effect.flip),
    ).toBeInstanceOf(FacilityOperationsLifecycleConflict);
    expect(
      yield* apply(created.state, {
        _tag: 'SecurityDeviceRecordInspection',
        deviceId: 'device-1',
        inspectionDate: '2026-10-20',
        nextInspectionDate: '2026-10-19',
      }).pipe(Effect.flip),
    ).toBeInstanceOf(FacilityOperationsLifecycleConflict);
  }),
);

it.effect('records inspections, attaches files once and clears optional fields', () =>
  Effect.gen(function* cardEdits() {
    const created = yield* withCamera;
    const inspected = yield* apply(created.state, {
      _tag: 'SecurityDeviceRecordInspection',
      deviceId: 'device-1',
      inspectionDate: '2026-10-20',
      nextInspectionDate: '2027-10-20',
    });
    expect(inspected.state.devices[0]?.lastInspectionDate).toBe('2026-10-20');
    expect(inspected.state.devices[0]?.nextInspectionDate).toBe('2027-10-20');
    const file = { id: 'file-1', mime: 'application/pdf', name: 'revize-2026.pdf', size: 1200 };
    const attached = yield* apply(inspected.state, {
      _tag: 'SecurityDeviceAttach',
      deviceId: 'device-1',
      file,
      kind: 'revision_protocol',
    });
    expect(attached.state.devices[0]?.attachments?.[0]?.kind).toBe('revision_protocol');
    expect(
      yield* apply(attached.state, { _tag: 'SecurityDeviceAttach', deviceId: 'device-1', file, kind: 'manual' }).pipe(
        Effect.flip,
      ),
    ).toBeInstanceOf(FacilityOperationsLifecycleConflict);
    const cleared = yield* apply(attached.state, {
      _tag: 'SecurityDeviceUpdate',
      administrator: 'Petr Dvořák',
      clear: ['location'],
      deviceId: 'device-1',
    });
    expect(cleared.state.devices[0]?.location).toBeUndefined();
    expect(cleared.state.devices[0]?.administrator).toBe('Petr Dvořák');
  }),
);

it.effect('the demo seed decodes and keeps device states consistent with open incidents', () =>
  Effect.gen(function* seedIsValid() {
    const state = yield* Schema.decodeUnknownEffect(SecurityStateSchema)(seedSecurityState());
    expect(state.devices.length).toBeGreaterThanOrEqual(8);
    const open = (state.incidents ?? []).filter((incident) => incident.state !== 'resolved');
    for (const incident of open) {
      expect(state.devices.find((device) => device.id === incident.deviceId)?.state).toBe('fault');
    }
  }),
);
