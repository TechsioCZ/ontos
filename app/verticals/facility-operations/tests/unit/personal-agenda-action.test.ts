import { NodeCrypto } from '@effect/platform-node';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { DateTime, Effect, Schema, Layer } from 'effect';
import { expect, it } from 'effect-rstest';
import { updatePersonalAgendaAction } from '../../src/actions/update-personal-agenda.action.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import {
  UpdatePersonalAgendaPayloadSchema,
  PersonalAgendaCommandSchema,
} from '../../shared/actions/personal-agenda.ts';
import { evolveAgenda } from '../../shared/commands/agenda.ts';
import { AgendaStateSchema } from '../../shared/domain/agenda.ts';
import { facilityOperationsRegistration } from '../../vertical.registration.ts';
import { FacilityOperationsRevisionConflict } from '../../shared/actions/apply-command.ts';
import { UpdatePersonalAgendaActionApi } from '../../shared/apis/update-personal-agenda-action.ts';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { updatePersonalAgendaActionSchemaErrorLive } from '../../api/update-personal-agenda-action-problems.ts';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000024', tenantId };
const other = { principalId: '72000000-0000-4000-8000-000000000022', tenantId };
const principal = {
  ...actor,
  authBindingId: '70000000-0000-4000-8000-000000000001',
  authContextRef: 'session:facility-partner',
  authMethod: 'session' as const,
  legalEntityId: '71000000-0000-4000-8000-000000000021',
};
const notification = (id: string, recipient: typeof actor) => ({
  category: 'DEADLINE',
  createdAt: '2026-11-07T00:00:00Z',
  createdBy: recipient,
  eventKey: id,
  id,
  recipient,
  source: 'agenda',
  title: id,
});
const snapshot = () =>
  Schema.decodeUnknownSync(AgendaStateSchema)({
    events: [],
    notifications: [notification('own', actor), notification('foreign', other)],
  });

it('the registered granular carrier and payload do not include exports, delivery, calendar management or broad writes', () => {
  expect(updatePersonalAgendaAction.descriptor.accessDeclaration?.key).toBe(
    'facility.operations.personal-agenda.update',
  );
  expect(applyCommandAction.descriptor.actionKey).not.toBe(updatePersonalAgendaAction.descriptor.actionKey);
  expect(updatePersonalAgendaAction.descriptor.accessDeclaration?.modes).toEqual(['run', 'propose']);
  for (const tag of [
    'AgendaEventCreate',
    'AgendaEventUpdate',
    'AgendaExportRecord',
    'AgendaNotificationsDeliver',
    'MeterReadingRecord',
    'FileUpload',
  ]) {
    expect(Schema.is(PersonalAgendaCommandSchema)({ _tag: tag })).toBe(false);
  }
});

const personalTestLayer = Layer.mergeAll(
  NodeCrypto.layer,
  Layer.succeed(AccessDecisionGate, makeTestAccessDecision({ defaultAnswer: { outcome: 'DENIED' } })),
);
const operationTime = DateTime.makeUnsafe('2026-11-07T00:00:00Z');
it.layer(personalTestLayer)('Facility personal agenda', (suite) => {
  suite.effect(
    'the actual registered Action commits only own preference data, retains native replay identity and cannot replay as broad apply-command',
    () =>
      Effect.gen(function* nativePersonal() {
        let state = snapshot();
        let revision = 0;
        let calls = 0;
        const harness = yield* makeActionTestHarness({
          access: {
            'facility.operations.apply-command.write': 'denied',
            'facility.operations.personal-agenda.update': 'allowed',
          },
          ownerRegistration: facilityOperationsRegistration,
          services: [
            bindActionTestServices(updatePersonalAgendaAction, {
              apply: (command, expectedRevision, resourceId) =>
                Effect.gen(function* ownReducer() {
                  calls += 1;
                  if (revision !== expectedRevision) {
                    return yield* new FacilityOperationsRevisionConflict({
                      code: 'facility_operations_revision_conflict',
                      reason: 'stale',
                    });
                  }
                  const personal = yield* Schema.decodeUnknownEffect(PersonalAgendaCommandSchema)(command).pipe(
                    Effect.orDie,
                  );
                  const change = yield* evolveAgenda(state, personal, { actor, now: operationTime, resourceId });
                  ({ state } = change);
                  revision += 1;
                  return { agenda: 'agenda' as const, entityIds: [...change.entityIds], revision };
                }),
              loadRecords: () => Effect.die('Personal Action cannot read arbitrary records'),
            }),
          ],
        });
        const payload = yield* Schema.decodeUnknownEffect(UpdatePersonalAgendaPayloadSchema)({
          command: { _tag: 'AgendaPreferencesSet', emailOptIn: true, leadDays: 3 },
          expectedRevision: 0,
        });
        const input = {
          payload,
          principal,
          registration: updatePersonalAgendaAction,
          transport: { correlationId: 'personal', idempotencyKey: 'personal:1' },
        };
        const result = yield* harness.runtime.runAction(input);
        expect(result.revision).toBe(1);
        expect(state.preferences?.map((entry) => entry.principal)).toEqual([actor]);
        expect(state.notifications?.every((entry) => entry.readAt === undefined)).toBe(true);
        expect(harness.snapshot().committed).toHaveLength(1);
        expect(harness.snapshot().committed[0]?.actionKey).toBe('facility.operations.update-personal-agenda');
        yield* harness.runtime.runAction(input).pipe(
          Effect.flip,
          Effect.tap((failure) => Effect.sync(() => expect(failure._tag).toBe('ActionAlreadyCommitted'))),
        );
        expect(calls).toBe(1);
        const broad = yield* harness.runtime
          .runAction({ ...input, registration: applyCommandAction })
          .pipe(Effect.flip);
        expect(broad._tag).toBe('ActionPermissionDenied');
        expect(calls).toBe(1);
      }),
  );

  suite.effect('own inbox reducer rejects another recipient and keeps own and foreign tenants separate', () =>
    Effect.gen(function* ownInbox() {
      for (const command of [
        { _tag: 'AgendaNotificationsMarkRead', notificationIds: ['foreign'] },
        { _tag: 'AgendaNotificationsMarkRead', notificationIds: ['missing'] },
      ]) {
        const decoded = yield* Schema.decodeUnknownEffect(PersonalAgendaCommandSchema)(command);
        const error = yield* evolveAgenda(snapshot(), decoded, {
          actor,
          now: operationTime,
          resourceId: 'personal',
        }).pipe(Effect.flip);
        expect(error._tag).toBe('FacilityOperationsNotFound');
      }
      const command = yield* Schema.decodeUnknownEffect(PersonalAgendaCommandSchema)({
        _tag: 'AgendaNotificationsMarkAllRead',
      });
      const changed = yield* evolveAgenda(snapshot(), command, {
        actor,
        now: operationTime,
        resourceId: 'personal',
      });
      expect(
        changed.state.notifications?.filter((entry) => entry.readAt !== undefined).map((entry) => entry.id),
      ).toEqual(['own']);
      const foreignTenant = yield* evolveAgenda(snapshot(), command, {
        actor: { ...actor, tenantId: '70000000-0000-4000-8000-000000000099' },
        now: operationTime,
        resourceId: 'personal',
      });
      expect(foreignTenant.entityIds).toEqual([]);
    }),
  );

  suite.effect('new native HTTP contract refuses a broad command before Action execution', () =>
    Effect.gen(function* httpPayload() {
      let executions = 0;
      const handlers = HttpApiBuilder.group(UpdatePersonalAgendaActionApi, 'updatePersonalAgendaAction', (routes) =>
        routes.handle('execute', () => {
          executions += 1;
          return Effect.die('Broad payload reached personal Action');
        }),
      );
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(UpdatePersonalAgendaActionApi).pipe(
              Layer.provide(handlers),
              Layer.provide(updatePersonalAgendaActionSchemaErrorLive),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
      );
      const response = yield* Effect.promise(() =>
        runtime.handler(
          new Request('https://facility.example/facility-operations/actions/update-personal-agenda', {
            body: JSON.stringify({ command: { _tag: 'AgendaNotificationsDeliver', items: [] }, expectedRevision: 0 }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }),
        ),
      );
      expect(response.status).toBe(400);
      expect(executions).toBe(0);
    }),
  );
});
