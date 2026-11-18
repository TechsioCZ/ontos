// @rstest-environment happy-dom
// Calendar events save only from Uložit, against the revision the draft was built on. The real router, i18n,
// property lookup, comments and command clients run against in-process HTTP contracts.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
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
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { constVoid } from 'effect/Function';
import {
  applyCommandActionProblem,
  applyCommandActionSchemaErrorLive,
} from '../../api/apply-command-action-problems.ts';
import type { ApplyCommandPayloadSchema, ApplyCommandResult } from '../../shared/actions/apply-command.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import type { ApplyCommandActionProblem } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { AgendaStateSchema, emptyAgendaState } from '../../shared/domain/agenda.ts';
import type { AgendaState } from '../../shared/domain/agenda.ts';
import { emptyDocumentsState } from '../../shared/domain/documents.ts';
import { DeadlineSchema } from '../../shared/domain/ops-overview.ts';
import { CreateEventPanel, DeadlinePanel } from '../../src/routes/[lang]/provoz/agenda/event-panel.tsx';
import { agendaRecordsData, runCommand } from '../../src/ui/use-agenda.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const stateWith = (updatedAt: string, title: string): AgendaState =>
  Schema.decodeUnknownSync(AgendaStateSchema)({
    ...emptyAgendaState,
    events: [
      {
        createdAt: '2026-10-20T08:00:00Z',
        createdBy: actor,
        date: '2026-11-20',
        id: 'event-1',
        kind: 'MEETING',
        title,
        updatedAt,
        updatedBy: actor,
      },
    ],
  });
const opened = stateWith('2026-10-20T08:00:00Z', 'Porada správy');
const theirs = stateWith('2026-10-21T09:30:00Z', 'Porada vedení');
const deadline = Schema.decodeUnknownSync(DeadlineSchema)({
  category: 'event',
  date: '2026-11-20',
  done: false,
  eventId: 'event-1',
  href: '/provoz/agenda',
  key: 'event:event-1',
  source: 'ops',
  title: 'Porada správy',
});
const title = '#ops-agenda-title';
const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const editLabel = czech('facility-operations.agenda.event.edit');
const forbidden = czech('facility-operations.common.errors.forbidden');

const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
let revision = 3;
let recordRevision = 3;
let refuse = false;

const OwnerActionApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const OwnerRecordsApi = RecordsApi.prefix('/facility-operations-api');
const PropertyApi = PropertyRecordsApi.prefix('/property-portfolio-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'facility-operations': '/facility-operations-api',
    'property-portfolio': '/property-portfolio-api',
  }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend((): Effect.Effect<ApplyCommandResult, ApplyCommandActionProblem> => {
          commands.push(payload);
          if (refuse) {
            return Effect.fail(applyCommandActionProblem.forbidden('facility_operations_permission_denied'));
          }
          if (payload.expectedRevision < recordRevision) {
            return Effect.fail(applyCommandActionProblem.conflict('facility_operations_revision_conflict'));
          }
          revision += 1;
          recordRevision = revision;
          return Effect.succeed({ entityIds: [], revision });
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', () =>
        Schema.decodeUnknownEffect(RecordsResponseSchema)({
          access: [{ agenda: 'documents', canRead: true, canWrite: true }],
          actorPrincipalRef: actor,
          agendas: {
            documents: {
              canWrite: true,
              revision: 0,
              state: emptyDocumentsState,
              updatedAt: '2026-10-20T08:00:00Z',
            },
          },
        }).pipe(Effect.orDie),
      ),
    ),
  ),
  serveApi(
    PropertyApi,
    HttpApiBuilder.group(PropertyApi, 'records', (group) =>
      group.handle('execute', () =>
        Schema.decodeUnknownEffect(PropertyRecordsResponseSchema)({
          assets: [],
          properties: [],
          revision: 0,
          units: [],
        }).pipe(Effect.orDie),
      ),
    ),
  ),
);

const runnerAt = (baseRevision: number) => (command: OpsCommand) => runCommand(command, baseRevision);
const panelOf = (state: AgendaState, baseRevision: number) => (
  <DeadlinePanel
    canWrite
    deadline={deadline}
    onClose={constVoid}
    onRun={runnerAt(baseRevision)}
    state={state}
    today="2026-11-10"
  />
);
const mountPanel = (element: Parameters<typeof mountInRoute>[0]) =>
  mountInRoute(element, { path: 'provoz/agenda', url: '/cs/provoz/agenda' });
const sentRevisions = () => commands.map((entry) => entry.expectedRevision);
const field = () => Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(title)));
const typeInto = (value: string) =>
  acted(() => {
    const input = field();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = (name: string) =>
  acted(() => {
    Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0])).click();
  });
const save = (count: number) =>
  click(labels.save).pipe(
    Effect.andThen(waitUntil(() => commands.length >= count)),
    Effect.andThen(networkIdle),
    Effect.andThen(settle),
  );

beforeEach(() => {
  commands.length = 0;
  revision = 3;
  recordRevision = 3;
  refuse = false;
  agendaRecordsData.invalidate();
});
afterEach(unmountAll);

describe('calendar event forms', () => {
  it.live('a new event is sent once by Uložit', () =>
    Effect.gen(function* createEvent() {
      yield* pinTestDocument;
      yield* mountPanel(<CreateEventPanel initialDate="2026-11-20" onClose={constVoid} onRun={runnerAt(3)} open />);
      yield* typeInto('Revize výtahu');
      yield* networkIdle;
      expect(commands).toEqual([]);
      yield* save(1);
      expect(commands).toHaveLength(1);
      expect(Predicate.isTagged(commands[0]?.command, 'AgendaEventCreate')).toBe(true);
    }).pipe(Effect.provide(network)),
  );

  it.live('a refused new event and a refused edit name the agenda’s reason', () =>
    Effect.gen(function* refusedEvent() {
      yield* pinTestDocument;
      refuse = true;
      yield* mountPanel(<CreateEventPanel initialDate="2026-11-20" onClose={constVoid} onRun={runnerAt(3)} open />);
      yield* typeInto('Revize výtahu');
      yield* save(1);
      yield* waitUntil(() => text().includes(forbidden));
      yield* networkIdle;
      expect(commands).toHaveLength(1);
      expect(Predicate.isTagged(commands[0]?.command, 'AgendaEventCreate')).toBe(true);
      expect(text()).toContain(forbidden);
      expect(text()).not.toContain(labels.failed);
      unmountAll();

      yield* mountPanel(panelOf(opened, 3));
      yield* click(editLabel);
      yield* typeInto('Porada týmu');
      yield* save(2);
      yield* waitUntil(() => text().includes(forbidden));
      yield* networkIdle;
      expect(commands).toHaveLength(2);
      expect(Predicate.isTagged(commands[0]?.command, 'AgendaEventCreate')).toBe(true);
      expect(Predicate.isTagged(commands[1]?.command, 'AgendaEventUpdate')).toBe(true);
      expect(text()).toContain(forbidden);
      expect(text()).not.toContain(labels.failed);
    }).pipe(Effect.provide(network)),
  );

  it.live('an edit over someone else’s newer change is refused, and the newest version can be loaded', () =>
    Effect.gen(function* editEvent() {
      yield* pinTestDocument;
      const panel = yield* mountPanel(panelOf(opened, 3));
      yield* click(editLabel);
      yield* typeInto('Porada týmu');
      revision = 4;
      recordRevision = revision;
      yield* panel.rerender(panelOf(theirs, 4));
      expect(field().value).toBe('Porada týmu');
      yield* save(1);
      yield* waitUntil(() => text().includes(labels.conflict));
      yield* networkIdle;
      expect(sentRevisions()).toEqual([3]);
      expect(text()).toContain(labels.conflict);
      yield* click(labels.reloadLatest);
      expect(field().value).toBe('Porada vedení');
      yield* typeInto('Porada týmu');
      yield* save(2);
      expect(sentRevisions()).toEqual([3, 4]);
    }).pipe(Effect.provide(network)),
  );
});
