// @rstest-environment happy-dom
// The typed forms around a lease as a person uses them: logging communication, a registration sheet and a prepared
// notice save once from the shared Uložit only; typing and Enter change only the draft; leaving with typed input asks
// first and an untouched form leaves at once. The module i18n and TanStack router run for real.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import type { AnyRouter } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Predicate } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import type { ReactElement } from 'react';
import type { OccupancyCommand } from '../../shared/actions/apply-command.ts';
import { DossierCommunication } from '../../src/routes/[lang]/najmy/dossier-communication.tsx';
import type { DossierChanges } from '../../src/routes/[lang]/najmy/leasing-save.ts';
import {
  ConflictOutcomeSchema,
  FailedOutcomeSchema,
  SavedOutcomeSchema,
} from '../../src/routes/[lang]/najmy/occupancy-command.ts';
import type { OccupancyOutcome } from '../../src/routes/[lang]/najmy/occupancy-command.ts';
import { NoticeEditor } from '../../src/routes/[lang]/najmy/notice-editor.tsx';
import type { NoticeContext } from '../../src/routes/[lang]/najmy/notice-templates.ts';
import { RegistrationSheetForm } from '../../src/routes/[lang]/najmy/registration-sheet-form.tsx';
import { leaseDraft } from '../fixtures/occupancy-draft.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';
import { button, buttons, click, field, text, type } from '../support/occupancy-form.tsx';

const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const CANCEL = czech('property-leasing.demo.cancel');
const activityLabels = { CALL: 'c', EMAIL: 'e', MEETING: 'm', NOTE: 'n' } as const;
const context: NoticeContext = {
  partyName: 'Kavárna Dolce',
  propertyAddress: 'Dlouhá 1, Praha',
  propertyLabel: 'Dům Dlouhá',
  record: { ...leaseDraft, state: 'ACTIVE' },
  unitLabel: 'Kancelář 2',
};
const newId = Effect.succeed('99999999-9999-4999-8999-999999999999');
const left: string[] = [];
const onClose = () => {
  left.push('closed');
};

const saved = SavedOutcomeSchema.make({ resourceRef: null, revision: 8 });
/** An addition that records what it was given and answers each outcome in turn, the last one from then on. */
const answering =
  <A,>(into: A[], outcomes: readonly OccupancyOutcome[]) =>
  (value: A) =>
    Effect.sync((): OccupancyOutcome => {
      into.push(value);
      return outcomes[Math.min(into.length, outcomes.length) - 1] ?? saved;
    });
const feedback = (reason: string) => czech(`property-leasing.demo.feedback.${reason}`);

const mount = (element: ReactElement) => mountInRoute(element, { path: 'najmy', url: '/cs/najmy' });

/** Try leaving through the real router, then keep the typed draft through the visible dialog. */
const expectBlocked = (router: AnyRouter) =>
  Effect.gen(function* blockedDeparture() {
    const previous = router.state.location.href;
    yield* acted(() => {
      void router.navigate({ to: '/cs' });
    });
    yield* waitUntil(() => buttons(labels.discard).length === 1);
    expect(router.state.location.href).toBe(previous);
    expect(buttons(labels.discard)).toHaveLength(1);
    yield* click(button(labels.stay));
    yield* waitUntil(() => buttons(labels.discard).length === 0);
  });

/** A query change exercises departure without unmounting the form needed by the next assertion. */
const expectAllowed = (router: AnyRouter, destination: string) =>
  Effect.gen(function* allowedDeparture() {
    yield* acted(() => {
      void router.navigate({ to: destination });
    });
    yield* waitUntil(() => router.state.location.href === destination);
    expect(router.state.location.href).toBe(destination);
    expect(buttons(labels.discard)).toHaveLength(0);
  });

/** Enter in a field: the browser submits the field's form. */
const pressEnter = (id: string) =>
  click(field(id)).pipe(Effect.andThen(Effect.sync(() => field(id).form?.requestSubmit())));

beforeEach(() => {
  left.length = 0;
});

afterEach(() => {
  unmountAll();
});

describe('dossier and stay forms save from Uložit only', () => {
  it.live('communication: typing and Enter log nothing; Uložit logs once and the form starts empty', () =>
    Effect.gen(function* communication() {
      const logged: DossierChanges[] = [];
      const onSave = answering(logged, [saved]);
      const { router } = yield* mount(
        <DossierCommunication activityLabels={activityLabels} canWrite onSave={onSave} />,
      );
      yield* expectAllowed(router, '/cs/najmy?clean=1');
      yield* type('communication-summary', 'Domluva předání klíčů');
      yield* pressEnter('communication-summary');
      expect(logged).toEqual([]);
      yield* expectBlocked(router);

      yield* click(button(labels.save));
      yield* waitUntil(() => logged.length === 1);
      expect(logged).toEqual([{ activity: { kind: 'CALL', summary: 'Domluva předání klíčů' } }]);
      yield* waitUntil(() => field('communication-summary').value === '');
      yield* expectAllowed(router, '/cs/najmy?clean=2');
    }),
  );

  it.live('registration sheet: the suggested sheet closes untouched; Uložit creates it once and closes', () =>
    Effect.gen(function* sheet() {
      const sent: OccupancyCommand[] = [];
      const onSave = answering(sent, [saved]);
      const form = <RegistrationSheetForm context={context} newId={newId} onClose={onClose} onSave={onSave} />;
      const untouched = yield* mount(form);
      yield* expectAllowed(untouched.router, '/cs/najmy?clean=1');
      yield* click(buttons(CANCEL).at(-1));
      expect(left).toEqual(['closed']);

      unmountAll();
      left.length = 0;
      const { router } = yield* mount(form);
      yield* type('sheet-name-0', 'Jana Nováková');
      yield* type('sheet-document-0', 'OP 123456');
      yield* pressEnter('sheet-name-0');
      expect(sent).toEqual([]);
      yield* expectBlocked(router);
      yield* click(button(labels.save));
      yield* waitUntil(() => left.length === 1);
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'CreateRegistrationSheet')).toBe(true);
      expect(sent[0]).toMatchObject({
        note: '',
        occupants: [{ identityDocument: 'OP 123456', name: 'Jana Nováková' }],
        purpose: 'Podnikání – nájem',
      });
    }),
  );

  it.live('notice: the template text can be stored at once; typed text asks before leaving; Uložit stores once', () =>
    Effect.gen(function* notice() {
      const sent: OccupancyCommand[] = [];
      const onSave = answering(sent, [saved]);
      const { router } = yield* mount(
        <NoticeEditor
          context={context}
          defaultEmail="najemce@dolce.cz"
          defaultPhone=""
          newId={newId}
          onSave={onSave}
        />,
      );
      yield* expectAllowed(router, '/cs/najmy?clean=1');
      expect(button(labels.save).disabled).toBe(false);
      yield* type('notice-subject', 'Předání kanceláře');
      yield* pressEnter('notice-subject');
      expect(sent).toEqual([]);
      yield* expectBlocked(router);

      yield* click(button(labels.save));
      yield* waitUntil(() => sent.length === 1);
      expect(Predicate.isTagged(sent[0], 'PrepareNotice')).toBe(true);
      expect(sent[0]).toMatchObject({ channel: 'EMAIL', recipient: 'najemce@dolce.cz', subject: 'Předání kanceláře' });
      yield* waitUntil(() => !text().includes(labels.unsaved));
      yield* expectAllowed(router, '/cs/najmy?clean=2');
      expect(text()).not.toContain(labels.unsaved);
    }),
  );
});

describe('an addition that the server refuses stays in the form with the reason and can be saved again', () => {
  const conflict = ConflictOutcomeSchema.make({});

  it.live('communication: a conflict after the resend shows why; Uložit logs the typed entry again', () =>
    Effect.gen(function* communication() {
      const logged: DossierChanges[] = [];
      yield* mount(
        <DossierCommunication activityLabels={activityLabels} canWrite onSave={answering(logged, [conflict, saved])} />,
      );
      yield* type('communication-summary', 'Domluva předání klíčů');
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(feedback('conflict')));
      expect(field('communication-summary').value).toBe('Domluva předání klíčů');
      expect(button(labels.save).disabled).toBe(false);

      yield* click(button(labels.save));
      yield* waitUntil(() => logged.length === 2);
      yield* waitUntil(() => field('communication-summary').value === '');
      expect(text()).not.toContain(feedback('conflict'));
    }),
  );

  it.live('registration sheet: a refused save shows its specific reason and Uložit sends it again', () =>
    Effect.gen(function* sheet() {
      const sent: OccupancyCommand[] = [];
      const forbidden = FailedOutcomeSchema.make({ reason: 'forbidden' });
      yield* mount(
        <RegistrationSheetForm
          context={context}
          newId={newId}
          onClose={onClose}
          onSave={answering(sent, [forbidden, conflict, saved])}
        />,
      );
      yield* type('sheet-name-0', 'Jana Nováková');
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(feedback('forbidden')));
      expect(text()).not.toContain(labels.failed);
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(feedback('conflict')));
      expect(button(labels.save).disabled).toBe(false);
      yield* click(button(labels.save));
      yield* waitUntil(() => left.length === 1);
      expect(sent).toHaveLength(3);
    }),
  );

  it.live('notice: a conflict after the resend keeps the typed text savable', () =>
    Effect.gen(function* notice() {
      const sent: OccupancyCommand[] = [];
      yield* mount(
        <NoticeEditor
          context={context}
          defaultEmail="najemce@dolce.cz"
          defaultPhone=""
          newId={newId}
          onSave={answering(sent, [conflict, saved])}
        />,
      );
      yield* type('notice-subject', 'Předání kanceláře');
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(feedback('conflict')));
      expect(field('notice-subject').value).toBe('Předání kanceláře');
      yield* click(button(labels.save));
      yield* waitUntil(() => sent.length === 2);
      expect(sent[1]).toMatchObject({ subject: 'Předání kanceláře' });
    }),
  );
});
