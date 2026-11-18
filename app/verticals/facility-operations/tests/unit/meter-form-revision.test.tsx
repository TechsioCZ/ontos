// @rstest-environment happy-dom
// The meter card edit saves against the revision its draft was built on: a page refresh that brings someone else's
// change never moves a dirty draft onto the newer revision, so that change is refused instead of overwritten.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  RecordsApi as PropertyRecordsApi,
  RecordsResponseSchema as PropertyRecordsResponseSchema,
} from '@app/property-portfolio/contracts/records';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import {
  ApplyCommandActionApi,
  ApplyCommandActionConflictProblemSchema,
} from '../../shared/apis/apply-command-action.ts';
import { MeterSchema } from '../../shared/domain/meters.ts';
import type { Meter } from '../../shared/domain/meters.ts';
import { MeterForm } from '../../src/routes/[lang]/provoz/meridla/meter-forms.tsx';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const applied: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
let revision = 3;
let recordRevision = 3;
const OwnerApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const PropertyApi = PropertyRecordsApi.prefix('/property-portfolio-api');
const propertyRecords = Schema.decodeUnknownSync(PropertyRecordsResponseSchema)({
  assets: [],
  properties: [],
  revision: 1,
  units: [],
});
const conflict = Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
  _tag: 'ApplyCommandActionConflictProblem',
  code: 'facility_operations_revision_conflict',
  detail: 'The meter changed after this draft was opened.',
  status: 409,
  title: 'Revision conflict',
  type: 'urn:ontos:test:meter-revision-conflict',
});
const network = browserNetwork(
  shellGatewayIssuer({
    'facility-operations': '/facility-operations-api',
    'property-portfolio': '/property-portfolio-api',
  }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.gen(function* apply() {
          applied.push(payload);
          if (payload.expectedRevision < recordRevision) {
            return yield* Effect.fail(conflict);
          }
          revision += 1;
          recordRevision = revision;
          return Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds: [], revision });
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    PropertyApi,
    HttpApiBuilder.group(PropertyApi, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(propertyRecords)),
    ),
  ),
);

const changeElsewhere = () => {
  revision += 1;
  recordRevision = revision;
};
const sentRevisions = () => applied.map((entry) => entry.expectedRevision);
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
const save = (count: number) =>
  click(labels.save).pipe(
    Effect.andThen(waitUntil(() => applied.length >= count)),
    Effect.andThen(waitUntil(() => text().includes(labels.saved) || text().includes(labels.conflict))),
    Effect.andThen(networkIdle),
  );

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const meterAt = (updatedAt: string, note: string): Meter =>
  Schema.decodeUnknownSync(MeterSchema)({
    createdAt: '2026-10-20T08:00:00Z',
    createdBy: actor,
    id: 'meter-1',
    medium: 'ELECTRICITY',
    note,
    serialNumber: 'EL-2026-001',
    status: 'ACTIVE',
    supplier: 'PRE',
    unit: 'kWh',
    updatedAt,
    updatedBy: actor,
  });
const opened = meterAt('2026-10-20T08:00:00Z', 'Hlavní elektroměr');
const theirs = meterAt('2026-10-21T09:30:00Z', 'Jejich poznámka');
const supplier = '#meter-supplier';

const form = (meter: Meter, expectedRevision: number) =>
  createElement(MeterForm, {
    meter,
    onCancel: constVoid,
    onSaved: constVoid,
    run: (command) => runCommand(command, expectedRevision),
  });

beforeEach(() => {
  applied.length = 0;
  revision = 3;
  recordRevision = 3;
});

afterEach(unmountAll);

describe('meter card save against the revision of its draft', () => {
  it.live('a dirty draft keeps its revision through a refresh, so the save is refused as a conflict', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const panel = yield* mountInRoute(form(opened, 3), { path: 'provoz/meridla', url: '/cs/provoz/meridla' });
      yield* typeInto(supplier, 'ČEZ');
      changeElsewhere();
      yield* panel.rerender(form(theirs, 4));
      expect(fieldValue(supplier)).toBe('ČEZ');
      yield* save(1);
      expect(sentRevisions()).toEqual([3]);
      expect(text()).toContain(labels.conflict);
      // „Načíst aktuální verzi“ takes their version and its revision.
      yield* click(labels.reloadLatest);
      expect(fieldValue(supplier)).toBe('PRE');
      yield* typeInto(supplier, 'ČEZ');
      yield* save(2);
      expect(sentRevisions()).toEqual([3, 4]);
      expect(text()).toContain(labels.saved);
    }).pipe(Effect.provide(network)),
  );

  it.live('a clean draft takes the refresh, with its revision', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const panel = yield* mountInRoute(form(opened, 3), { path: 'provoz/meridla', url: '/cs/provoz/meridla' });
      changeElsewhere();
      yield* panel.rerender(form(theirs, 4));
      expect(fieldValue('#meter-note')).toBe('Jejich poznámka');
      yield* typeInto(supplier, 'ČEZ');
      yield* save(1);
      expect(sentRevisions()).toEqual([4]);
      expect(text()).toContain(labels.saved);
    }).pipe(Effect.provide(network)),
  );

  it.live('its own save advances the base, so the next save is not refused', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const panel = yield* mountInRoute(form(opened, 3), { path: 'provoz/meridla', url: '/cs/provoz/meridla' });
      yield* typeInto(supplier, 'ČEZ');
      yield* save(1);
      // The page re-reads after the save: the record now carries this form's own change.
      const ours = { ...meterAt('2026-10-22T10:00:00Z', 'Hlavní elektroměr'), supplier: 'ČEZ' };
      yield* panel.rerender(form(ours, 4));
      yield* typeInto(supplier, 'E.ON');
      yield* save(2);
      expect(sentRevisions()).toEqual([3, 4]);
      expect(text()).toContain(labels.saved);
    }).pipe(Effect.provide(network)),
  );
});
