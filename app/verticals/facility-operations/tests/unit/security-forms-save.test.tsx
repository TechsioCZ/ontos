// @rstest-environment happy-dom
// The security panels that create something (device card, fault report, inspection, resolution) send it on the shared
// Uložit only: one click sends the same command as the old button, and leaving with typed input asks first.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { RecordsApi, RecordsResponseSchema } from '@app/property-portfolio/contracts/records';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Toaster, toaster } from '@techsio/ui-kit/molecules/toast';
import { Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { OpsCommandSchema } from '../../shared/agendas.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import {
  ApplyCommandActionApi,
  ApplyCommandActionForbiddenProblemSchema,
} from '../../shared/apis/apply-command-action.ts';
import { inspectionNoteLimit, SecurityDeviceSchema, SecurityIncidentSchema } from '../../shared/domain/security.ts';
import {
  DeviceFormPanel,
  InspectionPanel,
  ReportFaultPanel,
  ResolvePanel,
} from '../../src/routes/[lang]/provoz/bezpecnost/device-forms.tsx';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const OwnerActionApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const PropertyRecordsApi = RecordsApi.prefix('/property-portfolio-api');
const propertyRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assets: [],
  properties: [],
  revision: 0,
  units: [],
});
const forbidden = ApplyCommandActionForbiddenProblemSchema.make({
  code: 'facility_operations_permission_denied',
  detail: 'The command is forbidden.',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/forbidden',
});
let received: OpsCommand[] = [];
let answer: Effect.Effect<typeof ApplyCommandResultSchema.Type, typeof forbidden> = Effect.succeed(
  Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds: ['created-1'], revision: 2 }),
);
const network = browserNetwork(
  shellGatewayIssuer({
    'facility-operations': '/facility-operations-api',
    'property-portfolio': '/property-portfolio-api',
  }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          received.push(Schema.decodeUnknownSync(OpsCommandSchema)(payload.command));
          return answer;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    PropertyRecordsApi,
    HttpApiBuilder.group(PropertyRecordsApi, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(propertyRecords)),
    ),
  ),
);

const recordingRunner = (answers: readonly 'forbidden'[] = [], entityIds: readonly string[] = ['created-1']) => {
  const sent: OpsCommand[] = [];
  received = sent;
  answer =
    answers.length === 0
      ? Effect.succeed(Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds, revision: 2 }))
      : Effect.fail(forbidden);
  return { run: (command: OpsCommand) => runCommand(command, 0), sent };
};
type RecordingRunner = ReturnType<typeof recordingRunner>;
const labels = saveLabelsFor('cs');
const t = moduleText('cs');
const copy = { cancel: t('facility-operations.common.cancel') };
const saveButton = () => Option.getOrThrow(Option.fromUndefinedOr(buttons(labels.save)[0]));
const leaveQuestionOpen = () => buttons(labels.discard).length > 0;
const click = (name: string) => acted(() => Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0])).click());
const typeInto = (selector: string, value: string) =>
  acted(() => {
    const field = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)),
    );
    Reflect.set(Object.getPrototypeOf(field), 'value', value, field);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const mountPanel = (element: ReactElement) =>
  mountInRoute(
    <>
      {element}
      <Toaster />
    </>,
    { path: 'provoz/bezpecnost', url: '/cs/provoz/bezpecnost' },
  );
const saveSent = (runner: RecordingRunner, count: number) =>
  click(labels.save).pipe(
    Effect.andThen(waitUntil(() => runner.sent.length >= count)),
    Effect.andThen(waitUntil(() => saveButton().textContent.trim() === labels.save)),
    Effect.andThen(settle),
  );
const toastTitles = () => [...document.querySelectorAll('[data-scope="toast"][data-part="title"]')];

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const device = Schema.decodeUnknownSync(SecurityDeviceSchema)({
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  deviceType: 'camera',
  id: 'camera-1',
  name: 'Kamera vstup',
  state: 'in_operation',
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
});
const incident = Schema.decodeUnknownSync(SecurityIncidentSchema)({
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  deviceId: device.id,
  id: 'incident-1',
  occurredOn: '2026-10-20',
  severity: 'high',
  state: 'reported',
  title: 'Nefunguje záznam',
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
});

const calls: string[] = [];
const page = (name: string) => () => {
  calls.push(name);
};

const mountCreate = (runner: RecordingRunner) =>
  mountPanel(
    createElement(DeviceFormPanel, {
      onClose: page('close'),
      onSaved: page('saved'),
      open: true,
      run: runner.run,
    }),
  );
const mountReport = (runner: RecordingRunner) =>
  mountPanel(
    createElement(ReportFaultPanel, {
      devices: [device],
      initialDeviceId: device.id,
      onClose: page('close'),
      onSaved: page('saved'),
      open: true,
      run: runner.run,
      tenantId: actor.tenantId,
    }),
  );
const mountInspection = (runner: RecordingRunner) =>
  mountPanel(
    createElement(InspectionPanel, {
      device,
      onClose: page('close'),
      onSaved: page('saved'),
      open: true,
      run: runner.run,
    }),
  );
const mountResolve = (runner: RecordingRunner) =>
  mountPanel(
    createElement(ResolvePanel, {
      incident,
      onClose: page('close'),
      onSaved: page('saved'),
      open: true,
      run: runner.run,
    }),
  );

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  toaster.dismiss();
  unmountAll();
});

describe('new device card', () => {
  it.live('types a name, saves once with the create command, toasts and goes on', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const runner = recordingRunner();
      yield* mountCreate(runner);
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('#security-name', 'Kamera dvůr');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([expect.objectContaining({ _tag: 'SecurityDeviceCreate', name: 'Kamera dvůr' })]);
      expect(calls).toEqual(['saved']);
      yield* waitUntil(() => toastTitles().length === 1);
      expect(toastTitles()).toHaveLength(1);
      expect(toastTitles()[0]?.textContent).toBe(t('facility-operations.security.created'));
    }).pipe(Effect.provide(network)),
  );

  it.live('a refused save keeps the input; Zrušit with typed input asks, Zahodit změny leaves', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const runner = recordingRunner(['forbidden']);
      yield* mountCreate(runner);
      yield* typeInto('#security-name', 'Kamera dvůr');
      yield* saveSent(runner, 1);
      expect(calls).toEqual([]);
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.discard);
      expect(calls).toEqual(['close']);
      expect(runner.sent).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );
});

describe('fault report', () => {
  it.live('types a title, saves once with the report command and leaves', () =>
    Effect.gen(function* scenario() {
      // No created id comes back, so no follow-up task is created here.
      yield* pinTestDocument;
      const runner = recordingRunner([], []);
      yield* mountReport(runner);
      yield* typeInto('#security-incident-title', 'Nefunguje záznam');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({ _tag: 'SecurityIncidentReport', deviceId: device.id, title: 'Nefunguje záznam' }),
      ]);
      expect(calls).toEqual(['saved']);
    }).pipe(Effect.provide(network)),
  );

  it.live('an untouched report closes without asking', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountReport(recordingRunner());
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(false);
      expect(calls).toEqual(['close']);
    }).pipe(Effect.provide(network)),
  );
});

describe('inspection and resolution', () => {
  it.live('refuses an inspection note that cannot be retained and keeps the full typed text for correction', () =>
    Effect.gen(function* refuseLongInspectionNote() {
      yield* pinTestDocument;
      const runner = recordingRunner();
      yield* mountInspection(runner);
      const longNote = 'x'.repeat(500);
      const selector = '#security-inspection-note';
      yield* typeInto(selector, longNote);
      yield* click(labels.save);
      expect(runner.sent).toEqual([]);
      expect(document.querySelector<HTMLTextAreaElement>(selector)?.value).toBe(longNote);
      expect(document.body.textContent).toContain(
        t('facility-operations.security.inspection.noteTooLong', { limit: inspectionNoteLimit }),
      );
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(network)),
  );
  it.live('the inspection opens filled in: Uložit records it at once, with the same command', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const runner = recordingRunner();
      yield* mountInspection(runner);
      expect(saveButton().disabled).toBe(false);
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({ _tag: 'SecurityDeviceRecordInspection', deviceId: device.id }),
      ]);
      expect(calls).toEqual(['saved']);
    }).pipe(Effect.provide(network)),
  );

  it.live('a typed inspection note asks before Zrušit; an untouched one closes', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountInspection(recordingRunner());
      yield* typeInto('#security-inspection-note', 'Vyčištěn objektiv');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.stay);
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(network)),
  );

  it.live('resolves the fault with the typed note on Uložit', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const runner = recordingRunner();
      yield* mountResolve(runner);
      yield* typeInto('#security-resolution', 'Vyměněn disk');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        {
          _tag: 'SecurityIncidentChangeState',
          incidentId: incident.id,
          resolution: 'Vyměněn disk',
          state: 'resolved',
        },
      ]);
      expect(calls).toEqual(['saved']);
    }).pipe(Effect.provide(network)),
  );
});
