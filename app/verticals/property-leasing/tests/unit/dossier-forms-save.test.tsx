// @rstest-environment happy-dom
// Lease-specific communication, registration and notice payloads and refusal reasons.
import { saveLabelsFor } from '@app/admin-ui';
import { unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import type { ReactElement } from 'react';
import type { OccupancyCommand } from '../../shared/actions/apply-command.ts';
import { OccupancyCommandSchema } from '../../shared/actions/apply-command.ts';
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
import { button, click, field, text, type } from '../support/occupancy-form.tsx';

const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
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

beforeEach(() => {
  left.length = 0;
});

afterEach(() => {
  unmountAll();
});

describe('dossier and stay commands', () => {
  it.live('communication logs the activity kind and summary, then starts empty', () =>
    Effect.gen(function* communication() {
      const logged: DossierChanges[] = [];
      const onSave = answering(logged, [saved]);
      yield* mount(<DossierCommunication activityLabels={activityLabels} canWrite onSave={onSave} />);
      yield* type('communication-summary', 'Domluva předání klíčů');

      yield* click(button(labels.save));
      yield* waitUntil(() => logged.length === 1);
      expect(logged).toEqual([{ activity: { kind: 'CALL', summary: 'Domluva předání klíčů' } }]);
      yield* waitUntil(() => field('communication-summary').value === '');
    }),
  );

  it.live('registration sheet stores the occupants and suggested lease purpose', () =>
    Effect.gen(function* sheet() {
      const sent: OccupancyCommand[] = [];
      const onSave = answering(sent, [saved]);
      const form = <RegistrationSheetForm context={context} newId={newId} onClose={onClose} onSave={onSave} />;
      yield* mount(form);
      yield* type('sheet-name-0', 'Jana Nováková');
      yield* type('sheet-document-0', 'OP 123456');
      yield* click(button(labels.save));
      yield* waitUntil(() => left.length === 1);
      expect(sent).toHaveLength(1);
      expect(
        Schema.is(OccupancyCommandSchema.pipe(Schema.toTaggedUnion('_tag')).cases.CreateRegistrationSheet)(sent[0]),
      ).toBe(true);
      expect(sent[0]).toMatchObject({
        note: '',
        occupancyRef: context.record.occupancyRef,
        occupants: [{ identityDocument: 'OP 123456', name: 'Jana Nováková' }],
        purpose: 'Podnikání – nájem',
      });
    }),
  );

  it.live('notice stores the chosen subject, recipient and lease reference', () =>
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
      expect(button(labels.save).disabled).toBe(false);
      yield* type('notice-subject', 'Předání kanceláře');

      yield* click(button(labels.save));
      yield* waitUntil(() => sent.length === 1);
      expect(Schema.is(OccupancyCommandSchema.pipe(Schema.toTaggedUnion('_tag')).cases.PrepareNotice)(sent[0])).toBe(
        true,
      );
      expect(sent[0]).toMatchObject({
        channel: 'EMAIL',
        occupancyRef: context.record.occupancyRef,
        recipient: 'najemce@dolce.cz',
        subject: 'Předání kanceláře',
      });
      yield* waitUntil(() => !text().includes(labels.unsaved));
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
