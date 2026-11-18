// @rstest-environment happy-dom
// A new meter and a meter reading are sent by the shared Uložit only: typing changes the draft, one click sends the
// same command as the old button did, and leaving with typed input asks first while an untouched form just closes.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { RecordsApi, RecordsResponseSchema } from '@app/property-portfolio/contracts/records';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import {
  applyCommandActionProblem,
  applyCommandActionSchemaErrorLive,
} from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import { MeterSchema } from '../../shared/domain/meters.ts';
import { MeterForm, ReadingForm } from '../../src/routes/[lang]/provoz/meridla/meter-forms.tsx';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const t = moduleText('cs');
const labels = saveLabelsFor('cs');
const copy = { cancel: t('facility-operations.common.cancel') };
const sent: (typeof ApplyCommandPayloadSchema.Encoded)['command'][] = [];
let refuseNextSave = false;
const created = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds: ['created-1'], revision: 2 });
const properties = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assets: [],
  properties: [],
  revision: 0,
  units: [],
});
const OwnerActionApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const OwnerRecordsApi = RecordsApi.prefix('/property-portfolio-api');
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
          sent.push(payload.command);
          if (refuseNextSave) {
            refuseNextSave = false;
            return Effect.fail(applyCommandActionProblem.unavailable('facility_operations_persistence_unavailable'));
          }
          return Effect.succeed(created);
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(properties)),
    ),
  ),
);
const run = (command: OpsCommand) => runCommand(command, 0);
const saveButton = () => Option.getOrThrow(Option.fromUndefinedOr(buttons(labels.save)[0]));
const click = (name: string) =>
  acted(() => {
    Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0])).click();
  });
const typeInto = (selector: string, value: string) =>
  acted(() => {
    const field = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(selector)));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const leaveQuestionOpen = () => buttons(labels.discard).length > 0;
const saveSent = (count: number) =>
  click(labels.save).pipe(
    Effect.andThen(waitUntil(() => sent.length >= count)),
    Effect.andThen(waitUntil(() => saveButton().textContent.trim() === labels.save)),
  );

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const meter = Schema.decodeUnknownSync(MeterSchema)({
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  id: 'meter-1',
  medium: 'WATER',
  serialNumber: 'VO-1',
  status: 'ACTIVE',
  unit: 'm3',
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
});

const calls: string[] = [];
const record = (name: string) => (value?: string) => {
  calls.push(`${name}:${value ?? ''}`);
};

beforeEach(() => {
  calls.length = 0;
  sent.length = 0;
  refuseNextSave = false;
});

afterEach(unmountAll);

const mountMeter = () => mountInRoute(<MeterForm onCancel={record('cancel')} onSaved={record('saved')} run={run} />);
const mountReading = () =>
  mountInRoute(
    <ReadingForm
      canRecordCosts={false}
      canUploadPhoto={false}
      fixedMeterId={meter.id}
      meters={[meter]}
      onCancel={record('cancel')}
      onSaved={record('saved')}
      run={run}
    />,
  );

describe('new meter', () => {
  it.live('types, saves once with the create command, and goes on to the new meter', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountMeter();
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('#meter-serial', 'EL-77');
      yield* saveSent(1);
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'MeterCreate')).toBe(true);
      expect(sent[0]).toMatchObject({ serialNumber: 'EL-77' });
      expect(calls).toEqual(['saved:created-1']);
    }).pipe(Effect.provide(network)),
  );

  it.live('a refused save keeps the input and says why; the next Uložit sends it again', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      refuseNextSave = true;
      yield* mountMeter();
      yield* typeInto('#meter-serial', 'EL-77');
      yield* saveSent(1);
      expect(text()).toContain(t('facility-operations.common.errors.unavailable'));
      expect(calls).toEqual([]);
      yield* saveSent(2);
      expect(sent[1]).toEqual(sent[0]);
      expect(calls).toEqual(['saved:created-1']);
    }).pipe(Effect.provide(network)),
  );

  it.live('an untouched form closes at once; typed input asks before Zrušit leaves', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountMeter();
      yield* click(copy.cancel);
      expect(calls).toEqual(['cancel:']);
      yield* typeInto('#meter-serial', 'EL-77');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      expect(calls).toEqual(['cancel:']);
      yield* click(labels.discard);
      expect(calls).toEqual(['cancel:', 'cancel:']);
      expect(sent).toEqual([]);
    }).pipe(Effect.provide(network)),
  );
});

describe('meter reading', () => {
  it.live('types a value, saves once with the reading command, and leaves', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountReading();
      yield* typeInto('#reading-value', '12,5');
      yield* saveSent(1);
      expect(sent).toEqual([expect.objectContaining({ _tag: 'MeterReadingRecord', meterId: meter.id, value: 12.5 })]);
      expect(calls).toEqual([`saved:${meter.id}`]);
    }).pipe(Effect.provide(network)),
  );

  it.live('leaving with a typed value asks; Zůstat keeps the input', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountReading();
      yield* typeInto('#reading-value', '3');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.stay);
      expect(calls).toEqual([]);
      yield* saveSent(1);
      expect(calls).toEqual([`saved:${meter.id}`]);
    }).pipe(Effect.provide(network)),
  );
});
