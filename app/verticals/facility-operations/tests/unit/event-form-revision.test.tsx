// @rstest-environment happy-dom
// Calendar events save only from the shared Save button ("Uložit"). The edit of an own event saves against the
// revision its draft was built on: someone else's newer change is refused instead of overwritten, and "Načíst
// nejnovější" loads it.
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { AgendaStateSchema, emptyAgendaState } from '../../shared/domain/agenda.ts';
import type { AgendaState } from '../../shared/domain/agenda.ts';
import { DeadlineSchema } from '../../shared/domain/ops-overview.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import type { CommandOutcome } from '../../src/ui/use-agenda.ts';
import { CreateEventPanel, DeadlinePanel } from '../../src/routes/[lang]/provoz/agenda/event-panel.tsx';
import {
  agendaAt,
  bodyText,
  changeElsewhere,
  click,
  fieldValue,
  labels,
  mountPanel,
  runnerAt,
  save,
  toPage,
  typeInto,
  unmountPanels,
} from './draft-base-fixture.ts';
import type { FakeAgenda } from './draft-base-fixture.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('../../src/ui/property-options.ts', () => ({
  usePropertyOptions: () => ({ status: 'loading' }),
}));
rstest.mock('../../src/ui/comment-thread.tsx', () => ({
  CommentThread: () => null,
}));

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
const editLabel = 'facility-operations.agenda.event.edit';
const forbidden = 'facility-operations.common.errors.forbidden';

const panelOf = (state: AgendaState, agenda: FakeAgenda, revision: number) =>
  createElement(DeadlinePanel, {
    canWrite: true,
    deadline,
    onClose: toPage,
    onRun: runnerAt(agenda, revision),
    state,
    today: '2026-11-10',
  });

const sentRevisions = (agenda: FakeAgenda) => agenda.applied.map((entry) => entry.expectedRevision);

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('calendar event forms', () => {
  it.live('a new event is sent once by Uložit', () =>
    Effect.gen(function* createEvent() {
      const agenda = agendaAt(3);
      yield* mountPanel(
        createElement(CreateEventPanel, {
          initialDate: '2026-11-20',
          onClose: toPage,
          onRun: runnerAt(agenda, 3),
          open: true,
        }),
      );
      yield* typeInto(title, 'Revize výtahu');
      expect(agenda.applied).toEqual([]);
      yield* save(agenda, 1);
      expect(agenda.applied.map((entry) => entry.command._tag)).toEqual(['AgendaEventCreate']);
    }),
  );

  it.live('a refused new event and a refused edit name the agenda’s reason', () =>
    Effect.gen(function* refusedEvent() {
      const refused: OpsCommand[] = [];
      const refusing = (command: OpsCommand): Effect.Effect<CommandOutcome> =>
        Effect.sync((): CommandOutcome => {
          refused.push(command);
          return { ok: false, reason: 'forbidden' };
        });
      yield* mountPanel(
        createElement(CreateEventPanel, { initialDate: '2026-11-20', onClose: toPage, onRun: refusing, open: true }),
      );
      yield* typeInto(title, 'Revize výtahu');
      yield* click(labels.save);
      expect(refused.map((command) => command._tag)).toEqual(['AgendaEventCreate']);
      expect(bodyText()).toContain(forbidden);
      expect(bodyText()).not.toContain(labels.failed);
      unmountPanels();

      yield* mountPanel(
        createElement(DeadlinePanel, {
          canWrite: true,
          deadline,
          onClose: toPage,
          onRun: refusing,
          state: opened,
          today: '2026-11-10',
        }),
      );
      yield* click(editLabel);
      yield* typeInto(title, 'Porada týmu');
      yield* click(labels.save);
      expect(refused.map((command) => command._tag)).toEqual(['AgendaEventCreate', 'AgendaEventUpdate']);
      expect(bodyText()).toContain(forbidden);
      expect(bodyText()).not.toContain(labels.failed);
    }),
  );

  it.live('an edit over someone else’s newer change is refused, and the newest version can be loaded', () =>
    Effect.gen(function* editEvent() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(panelOf(opened, agenda, 3));
      yield* click(editLabel);
      yield* typeInto(title, 'Porada týmu');
      changeElsewhere(agenda);
      yield* panel.render(panelOf(theirs, agenda, 4));
      expect(fieldValue(title)).toBe('Porada týmu');
      yield* save(agenda, 1);
      expect(sentRevisions(agenda)).toEqual([3]);
      expect(bodyText()).toContain(labels.conflict);
      yield* click(labels.reloadLatest);
      expect(fieldValue(title)).toBe('Porada vedení');
      yield* typeInto(title, 'Porada týmu');
      yield* save(agenda, 2);
      expect(sentRevisions(agenda)).toEqual([3, 4]);
    }),
  );
});
