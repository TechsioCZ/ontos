// @rstest-environment happy-dom
// The typed forms around a lease as a person uses them: logging communication, a registration sheet and a prepared
// notice save once from the shared Uložit only; typing and Enter change only the draft; leaving with typed input asks
// first and an untouched form leaves at once. Only the i18n runtime and the router are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Predicate } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
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
import { button, buttons, click, field, mount, text, type, unmountAll, waitUntil } from '../support/occupancy-form.tsx';

interface Navigation {
  shouldBlock: () => boolean;
}
const { navigation } = rstest.hoisted(() => {
  const state: Navigation = { shouldBlock: () => false };
  return { navigation: state };
});
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: (options: { readonly shouldBlockFn: () => boolean }) => {
    navigation.shouldBlock = options.shouldBlockFn;
    return { status: 'idle' };
  },
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const labels = saveLabelsFor('cs');
const CANCEL = 'property-leasing.demo.cancel';
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
const feedback = (reason: string) => `property-leasing.demo.feedback.${reason}`;

/** Enter in a field: the browser submits the field's form. */
const pressEnter = (id: string) =>
  click(field(id)).pipe(Effect.andThen(Effect.sync(() => field(id).form?.requestSubmit())));

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  left.length = 0;
});

afterEach(() => {
  unmountAll();
  rstest.unstubAllGlobals();
});

describe('dossier and stay forms save from Uložit only', () => {
  it.effect('communication: typing and Enter log nothing; Uložit logs once and the form starts empty', () =>
    Effect.gen(function* communication() {
      const logged: DossierChanges[] = [];
      const onSave = answering(logged, [saved]);
      yield* mount(<DossierCommunication activityLabels={activityLabels} canWrite onSave={onSave} />);
      expect(navigation.shouldBlock()).toBe(false);
      yield* type('communication-summary', 'Domluva předání klíčů');
      yield* pressEnter('communication-summary');
      expect(logged).toEqual([]);
      expect(navigation.shouldBlock()).toBe(true);

      yield* click(button(labels.save));
      yield* waitUntil(() => logged.length === 1);
      expect(logged).toEqual([{ activity: { kind: 'CALL', summary: 'Domluva předání klíčů' } }]);
      yield* waitUntil(() => field('communication-summary').value === '');
      expect(navigation.shouldBlock()).toBe(false);
    }),
  );

  it.effect('registration sheet: the suggested sheet closes untouched; Uložit creates it once and closes', () =>
    Effect.gen(function* sheet() {
      const sent: OccupancyCommand[] = [];
      const onSave = answering(sent, [saved]);
      const form = <RegistrationSheetForm context={context} newId={newId} onClose={onClose} onSave={onSave} />;
      yield* mount(form);
      expect(navigation.shouldBlock()).toBe(false);
      yield* click(buttons(CANCEL).at(-1));
      expect(left).toEqual(['closed']);

      unmountAll();
      left.length = 0;
      yield* mount(form);
      yield* type('sheet-name-0', 'Jana Nováková');
      yield* type('sheet-document-0', 'OP 123456');
      yield* pressEnter('sheet-name-0');
      expect(sent).toEqual([]);
      expect(navigation.shouldBlock()).toBe(true);
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

  it.effect('notice: the template text can be stored at once; typed text asks before leaving; Uložit stores once', () =>
    Effect.gen(function* notice() {
      const sent: OccupancyCommand[] = [];
      const onSave = answering(sent, [saved]);
      yield* mount(
        <NoticeEditor
          context={context}
          defaultEmail="najemce@dolce.cz"
          defaultPhone=""
          newId={newId}
          onSave={onSave}
        />,
      );
      expect(navigation.shouldBlock()).toBe(false);
      expect(button(labels.save).disabled).toBe(false);
      yield* type('notice-subject', 'Předání kanceláře');
      yield* pressEnter('notice-subject');
      expect(sent).toEqual([]);
      expect(navigation.shouldBlock()).toBe(true);

      yield* click(button(labels.save));
      yield* waitUntil(() => sent.length === 1);
      expect(Predicate.isTagged(sent[0], 'PrepareNotice')).toBe(true);
      expect(sent[0]).toMatchObject({ channel: 'EMAIL', recipient: 'najemce@dolce.cz', subject: 'Předání kanceláře' });
      yield* waitUntil(() => !navigation.shouldBlock());
      expect(text()).not.toContain(labels.unsaved);
    }),
  );
});

describe('an addition that the server refuses stays in the form with the reason and can be saved again', () => {
  const conflict = ConflictOutcomeSchema.make({});

  it.effect('communication: a conflict after the resend shows why; Uložit logs the typed entry again', () =>
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

  it.effect('registration sheet: a refused save shows its specific reason and Uložit sends it again', () =>
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

  it.effect('notice: a conflict after the resend keeps the typed text savable', () =>
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
