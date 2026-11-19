// @rstest-environment happy-dom
// Client-card forms bind the selected client and primary-contact/default-date values to CRM commands.
import { Deferred, Effect, Predicate } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { unmountAll } from '@app/admin-ui/testing/module-ui';
import { mountInRoute as mount } from '../support/module-ui.ts';
import type { CrmCommandInput } from '../../shared/actions/apply-command.ts';
import { ContactForm } from '../../src/routes/[lang]/crm/klienti/contact-form.tsx';
import { ClientPlanForm, ClientVisitForm } from '../../src/routes/[lang]/crm/navstevy/client-visit-forms.tsx';
import { akros, click, copy, records, recording, saveButton, typeInto } from './crm-form-fixture.tsx';

afterEach(unmountAll);

describe('client card command payloads', () => {
  it.live('the first contact is marked primary and linked to the selected client', () =>
    Effect.gen(function* addContact() {
      const completed = yield* Deferred.make<true>();
      const sent: CrmCommandInput[] = [];
      const closed: string[] = [];
      const saved: string[] = [];
      yield* mount(
        <ContactForm
          clientId={akros.id}
          isFirst
          onClose={() => {
            closed.push('closed');
            Deferred.doneUnsafe(completed, Effect.succeed(true));
          }}
          onSaved={(draft) => {
            saved.push(draft.name);
          }}
          submit={recording(sent)}
        />,
      );
      yield* typeInto('crm-contact-new-name', copy.name);

      yield* click(saveButton());
      // onClose is called by the real afterSave callback, after the injected submit has finished.
      yield* Deferred.await(completed);
      expect(sent).toEqual([{ _tag: 'AddContactPerson', clientId: akros.id, name: copy.name, primary: true }]);
      expect(saved).toEqual([copy.name]);
      expect(closed).toEqual(['closed']);
    }),
  );

  it.live('a visit is recorded for the client whose card is open', () =>
    Effect.gen(function* recordVisit() {
      const completed = yield* Deferred.make<true>();
      const sent: CrmCommandInput[] = [];
      const closed: string[] = [];
      yield* mount(
        <ClientVisitForm
          clientId={akros.id}
          onClose={() => {
            closed.push('closed');
            Deferred.doneUnsafe(completed, Effect.succeed(true));
          }}
          records={records}
          submit={recording(sent)}
        />,
      );
      yield* typeInto('crm-card-visit-result', copy.result);

      yield* click(saveButton());
      // onClose is called by the real afterSave callback, after the injected submit has finished.
      yield* Deferred.await(completed);
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'RecordVisit')).toBe(true);
      expect(sent[0]).toMatchObject({ clientId: akros.id, result: copy.result });
      expect(closed).toEqual(['closed']);
    }),
  );

  it.live('planning a contact defaults to one week after the records date', () =>
    Effect.gen(function* planContact() {
      const completed = yield* Deferred.make<true>();
      const sent: CrmCommandInput[] = [];
      const closed: string[] = [];
      yield* mount(
        <ClientPlanForm
          clientId={akros.id}
          onClose={() => {
            closed.push('closed');
            Deferred.doneUnsafe(completed, Effect.succeed(true));
          }}
          records={records}
          submit={recording(sent)}
        />,
      );
      yield* click(saveButton());
      // onClose is called by the real afterSave callback, after the injected submit has finished.
      yield* Deferred.await(completed);
      expect(sent).toEqual([{ _tag: 'PlanContact', clientId: akros.id, dueDate: '2026-10-22' }]);
      expect(closed).toEqual(['closed']);
    }),
  );
});
