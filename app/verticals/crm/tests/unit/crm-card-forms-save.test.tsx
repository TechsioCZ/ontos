// @rstest-environment happy-dom
// The client card's inline forms send their one command only from the shared Save button ("Uložit"): typing and
// Enter change only the draft, an untouched form closes without asking, and a refused save keeps the input. The i18n
// runtime, router blocker and select template all run through the real module UI harness.
import { Effect, Option, Predicate } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { unmountAll } from '@app/admin-ui/testing/module-ui';
import { mountInRoute as mount } from '../support/module-ui.ts';
import type { CrmCommandInput } from '../../shared/actions/apply-command.ts';
import { ContactForm } from '../../src/routes/[lang]/crm/klienti/contact-form.tsx';
import { ClientPlanForm, ClientVisitForm } from '../../src/routes/[lang]/crm/navstevy/client-visit-forms.tsx';
import {
  akros,
  buttons,
  click,
  copy,
  field,
  leaveQuestion,
  pressEnter,
  records,
  recording,
  saveButton,
  typeInto,
} from './crm-form-fixture.tsx';

afterEach(unmountAll);

describe('client card forms save from Uložit only', () => {
  it.live('a new contact person is added once by Uložit, never by Enter', () =>
    Effect.gen(function* addContact() {
      const sent: CrmCommandInput[] = [];
      const closed: string[] = [];
      const saved: string[] = [];
      yield* mount(
        <ContactForm
          clientId={akros.id}
          isFirst
          onClose={() => {
            closed.push('closed');
          }}
          onSaved={(draft) => {
            saved.push(draft.name);
          }}
          submit={recording(sent)}
        />,
      );
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('crm-contact-new-name', copy.name);
      yield* pressEnter('crm-contact-new-name');
      expect(sent).toEqual([]);

      yield* click(saveButton());
      expect(sent).toEqual([{ _tag: 'AddContactPerson', clientId: akros.id, name: copy.name, primary: true }]);
      expect(saved).toEqual([copy.name]);
      expect(closed).toEqual(['closed']);
    }),
  );

  it.live('a refused contact keeps the typed name and asks before leaving', () =>
    Effect.gen(function* refusedContact() {
      const sent: CrmCommandInput[] = [];
      const closed: string[] = [];
      yield* mount(
        <ContactForm
          clientId={akros.id}
          isFirst={false}
          onClose={() => {
            closed.push('closed');
          }}
          onSaved={constVoid}
          submit={recording(sent, false)}
        />,
      );
      yield* typeInto('crm-contact-new-name', copy.name);
      yield* click(saveButton());
      expect(sent).toHaveLength(1);
      expect(field('crm-contact-new-name').value).toBe(copy.name);
      expect(closed).toEqual([]);

      yield* click(Option.getOrThrow(Option.fromNullishOr(buttons(copy.cancel).at(0))));
      expect(leaveQuestion()).toBe(true);
      expect(closed).toEqual([]);
    }),
  );

  it.live('a visit from the client card is recorded once by Uložit', () =>
    Effect.gen(function* recordVisit() {
      const sent: CrmCommandInput[] = [];
      const closed: string[] = [];
      yield* mount(
        <ClientVisitForm
          clientId={akros.id}
          onClose={() => {
            closed.push('closed');
          }}
          records={records}
          submit={recording(sent)}
        />,
      );
      yield* typeInto('crm-card-visit-result', copy.result);
      yield* pressEnter('crm-card-visit-result');
      expect(sent).toEqual([]);

      yield* click(saveButton());
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'RecordVisit')).toBe(true);
      expect(sent[0]).toMatchObject({ clientId: akros.id, result: copy.result });
      expect(closed).toEqual(['closed']);
    }),
  );

  it.live(
    'a planned contact from the client card is sent by the first Uložit; untouched it closes without asking',
    () =>
      Effect.gen(function* planContact() {
        const sent: CrmCommandInput[] = [];
        const closed: string[] = [];
        yield* mount(
          <ClientPlanForm
            clientId={akros.id}
            onClose={() => {
              closed.push('closed');
            }}
            records={records}
            submit={recording(sent)}
          />,
        );
        yield* click(Option.getOrThrow(Option.fromNullishOr(buttons(copy.cancel).at(0))));
        expect(leaveQuestion()).toBe(false);
        expect(closed).toEqual(['closed']);

        yield* click(saveButton());
        expect(sent).toEqual([{ _tag: 'PlanContact', clientId: akros.id, dueDate: '2026-10-22' }]);
      }),
  );
});
