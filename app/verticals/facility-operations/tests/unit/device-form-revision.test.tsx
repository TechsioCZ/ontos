// @rstest-environment happy-dom
// The device card edit saves against the revision its draft was built on: a page refresh that brings someone else's
// change never moves a dirty draft onto the newer revision, so that change is refused instead of overwritten.
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
import { Effect, Layer, Option, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import {
  ApplyCommandActionApi,
  ApplyCommandActionConflictProblemSchema,
} from '../../shared/apis/apply-command-action.ts';
import { SecurityDeviceSchema } from '../../shared/domain/security.ts';
import type { SecurityDevice } from '../../shared/domain/security.ts';
import { DeviceFormPanel } from '../../src/routes/[lang]/provoz/bezpecnost/device-forms.tsx';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const OwnerActionApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const PropertyRecordsApi = RecordsApi.prefix('/property-portfolio-api');
const propertyRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assets: [],
  properties: [],
  revision: 0,
  units: [],
});
const conflict = Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
  _tag: 'ApplyCommandActionConflictProblem',
  code: 'facility_operations_revision_conflict',
  detail: 'The device changed after the draft was opened.',
  status: 409,
  title: 'Revision conflict',
  type: 'urn:ontos:test:device-revision-conflict',
});

/** The real Action endpoint records each command and refuses revisions older than the last device change. */
const agendaAt = (initialRevision: number) => {
  const applied: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
  let revision = initialRevision;
  let recordRevision = initialRevision;
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
            applied.push(payload);
            if (payload.expectedRevision < recordRevision) {
              return Effect.fail(conflict);
            }
            revision += 1;
            recordRevision = revision;
            return Effect.succeed({ entityIds: [], revision });
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
  return {
    applied,
    changeElsewhere: () => {
      revision += 1;
      recordRevision = revision;
    },
    network,
  };
};

const fieldOf = (selector: string) =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)));
const fieldValue = (selector: string) => fieldOf(selector).value;
const typeInto = (selector: string, value: string) =>
  acted(() => {
    const field = fieldOf(selector);
    Reflect.set(Object.getPrototypeOf(field), 'value', value, field);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = (name: string) => acted(() => Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0])).click());
const save = (agenda: ReturnType<typeof agendaAt>, count: number) =>
  click(labels.save).pipe(
    Effect.andThen(waitUntil(() => agenda.applied.length >= count)),
    Effect.andThen(waitUntil(() => text().includes(labels.saved) || text().includes(labels.conflict))),
  );
const mountPanel = (element: ReturnType<typeof panelOf>) =>
  mountInRoute(element, {
    language: 'cs',
    path: 'provoz/bezpecnost',
    url: '/cs/provoz/bezpecnost',
  });

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const deviceAt = (updatedAt: string, fields: { readonly note: string; readonly supplier: string }): SecurityDevice =>
  Schema.decodeUnknownSync(SecurityDeviceSchema)({
    createdAt: '2026-10-20T08:00:00Z',
    createdBy: actor,
    deviceType: 'camera',
    id: 'camera-1',
    name: 'Kamera vstup',
    note: fields.note,
    state: 'in_operation',
    supplier: fields.supplier,
    updatedAt,
    updatedBy: actor,
  });
const opened = deviceAt('2026-10-20T08:00:00Z', { note: 'Krytá chodba', supplier: 'Bezpečnost Praha' });
const theirs = deviceAt('2026-10-21T09:30:00Z', { note: 'Jejich poznámka', supplier: 'Bezpečnost Praha' });
const supplier = '#security-supplier';

const panelOf = (device: SecurityDevice, revision: number) =>
  createElement(DeviceFormPanel, {
    device,
    onClose: () => {},
    onSaved: () => {},
    open: true,
    run: (command) => runCommand(command, revision),
  });

const sentRevisions = (agenda: ReturnType<typeof agendaAt>) => agenda.applied.map((entry) => entry.expectedRevision);

afterEach(unmountAll);

describe('device card save against the revision of its draft', () => {
  it.live('a dirty draft keeps its revision through a refresh, so the save is refused as a conflict', () => {
    const agenda = agendaAt(3);
    return Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const panel = yield* mountPanel(panelOf(opened, 3));
      yield* typeInto(supplier, 'Alarm servis');
      agenda.changeElsewhere();
      yield* panel.rerender(panelOf(theirs, 4));
      expect(fieldValue(supplier)).toBe('Alarm servis');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([3]);
      expect(text()).toContain(labels.conflict);
      yield* click(labels.reloadLatest);
      expect(fieldValue('#security-note')).toBe('Jejich poznámka');
      yield* typeInto(supplier, 'Alarm servis');
      yield* save(agenda, 2);
      expect(sentRevisions(agenda)).toEqual([3, 4]);
      expect(text()).toContain(labels.saved);
    }).pipe(Effect.provide(agenda.network));
  });

  it.live('a clean draft takes the refresh, with its revision', () => {
    const agenda = agendaAt(3);
    return Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const panel = yield* mountPanel(panelOf(opened, 3));
      agenda.changeElsewhere();
      yield* panel.rerender(panelOf(theirs, 4));
      expect(fieldValue('#security-note')).toBe('Jejich poznámka');
      yield* typeInto(supplier, 'Alarm servis');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([4]);
      expect(text()).toContain(labels.saved);
    }).pipe(Effect.provide(agenda.network));
  });

  it.live('its own save advances the base, so the next save is not refused', () => {
    const agenda = agendaAt(3);
    return Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const panel = yield* mountPanel(panelOf(opened, 3));
      yield* typeInto(supplier, 'Alarm servis');
      yield* save(agenda, 1);
      // The page re-reads after the save: the record now carries this form's own change.
      yield* panel.rerender(
        panelOf(deviceAt('2026-10-22T10:00:00Z', { note: 'Krytá chodba', supplier: 'Alarm servis' }), 4),
      );
      yield* typeInto(supplier, 'Alarm servis Brno');
      yield* save(agenda, 2);
      expect(sentRevisions(agenda)).toEqual([3, 4]);
      expect(text()).toContain(labels.saved);
    }).pipe(Effect.provide(agenda.network));
  });
});
