// @rstest-environment happy-dom
// Client form commands preserve patch semantics and validate separately entered organization contacts.
import { saveLabelsFor } from '@app/admin-ui';
import { unmountAll } from '@app/admin-ui/testing/module-ui';
import { Deferred, Effect, Option, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { act } from 'react';
import { ClientFormDialog } from '../../src/routes/[lang]/crm/klienti/client-form-dialog.tsx';
import type { CrmCommandSubmit } from '../../src/crm/records.ts';
import type { CrmCommandInput } from '../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { ClientSchema } from '../../shared/domain/clients.ts';
import type { Client } from '../../shared/domain/clients.ts';
import { IsoTimeSchema } from '../../shared/domain/common.ts';
import { initialCrmState } from '../../shared/domain/state.ts';
import { mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const copy = { clientName: 'client-name', contactName: 'contact-name', nameRequired: 'Vyplňte název' } as const;

const opened = Schema.decodeSync(IsoTimeSchema)('2026-10-15T10:00:00.000Z');

const client: Client = Schema.decodeSync(ClientSchema)({
  createdAt: '2026-10-15T10:00:00.000Z',
  createdBy: 'principal-1',
  id: 'client-1',
  kind: 'organization',
  name: 'Akros CZ',
  status: 'active',
  updatedAt: '2026-10-15T10:00:00.000Z',
});

const recordsWith = (items: readonly Client[]): RecordsResponse => ({
  assignmentCandidates: [],
  departedPrincipalIds: [],
  now: opened,
  revision: 1,
  state: { ...initialCrmState, clients: { ...initialCrmState.clients, items: [...items] } },
  viewer: Schema.decodeSync(CrmViewerSchema)({
    assign: false,
    principalId: 'principal-1',
    readAll: true,
    readAssigned: false,
    writeAll: true,
    writeAssigned: false,
  }),
});

const bodyText = () => document.body.textContent ?? '';

const mount = (props: {
  readonly client?: Client;
  readonly mode: 'create' | 'edit';
  readonly submit: CrmCommandSubmit;
}) =>
  mountInRoute(
    <ClientFormDialog
      busy={false}
      client={props.client}
      mode={props.mode}
      onClose={() => {}}
      onSaved={() => {}}
      records={recordsWith(props.client === undefined ? [] : [props.client])}
      submit={props.submit}
    />,
    { path: 'crm/klienti', url: '/cs/crm/klienti' },
  );

// Await the input handler and React's commit; these validations do not start network or timer work.
const typeInto = (id: string, value: string) =>
  Effect.promise(() =>
    act(async () => {
      const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }),
  );

const buttonNamed = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.textContent ?? '').trim() === text,
  );
  expect(found).toBeDefined();
  return Option.getOrThrow(Option.fromUndefinedOr(found));
};

const clickButton = (text: string) =>
  Effect.promise(() =>
    act(async () => {
      buttonNamed(text).click();
    }),
  );

const succeeding =
  (sent: CrmCommandInput[], completed: Deferred.Deferred<true>): CrmCommandSubmit =>
  (command) => {
    sent.push(command);
    return Effect.succeed({ entityIds: [client.id], ok: true }).pipe(
      Effect.ensuring(Deferred.succeed(completed, true)),
    );
  };

afterEach(unmountAll);

describe('client form', () => {
  it.live('editing a client sends a patch with only the changed name and phone', () =>
    Effect.gen(function* editSendsOnce() {
      const sent: CrmCommandInput[] = [];
      const completed = yield* Deferred.make<true>();
      yield* mount({ client, mode: 'edit', submit: succeeding(sent, completed) });

      yield* typeInto('crm-client-name', 'Akros CZ s.r.o.');
      yield* typeInto('crm-client-phone', '+420 601 000 000');

      yield* clickButton('Uložit');
      yield* Deferred.await(completed);
      expect(sent).toEqual([
        {
          _tag: 'UpdateClient',
          id: client.id,
          patch: { name: 'Akros CZ s.r.o.', phone: '+420 601 000 000' },
        },
      ]);
    }),
  );

  it.live('creating an organization includes its trimmed main contact and marks it primary', () =>
    Effect.gen(function* createOnlyOnSave() {
      const sent: CrmCommandInput[] = [];
      const completed = yield* Deferred.make<true>();
      yield* mount({ mode: 'create', submit: succeeding(sent, completed) });

      yield* typeInto('crm-client-name', 'Nová firma');
      yield* typeInto('crm-new-contact-0-name', ' Jana Nováková ');
      yield* typeInto('crm-new-contact-0-email', ' jana@example.test ');

      yield* clickButton('Uložit');
      yield* Deferred.await(completed);
      expect(sent).toEqual([
        {
          _tag: 'CreateClient',
          contacts: [{ email: 'jana@example.test', name: 'Jana Nováková', primary: true }],
          kind: 'organization',
          name: 'Nová firma',
        },
      ]);
    }),
  );

  it.live('a new client with only its main contact typed says why Uložit is disabled and marks the name', () =>
    Effect.gen(function* contactOnlyValidation() {
      const sent: CrmCommandInput[] = [];
      const completed = yield* Deferred.make<true>();
      yield* mount({ mode: 'create', submit: succeeding(sent, completed) });
      expect(bodyText()).not.toContain(labels.invalid);
      expect(bodyText()).not.toContain(copy.nameRequired);

      yield* typeInto('crm-new-contact-0-name', copy.contactName);
      expect(bodyText()).toContain(labels.invalid);
      expect(bodyText()).toContain(copy.nameRequired);
      expect(buttonNamed(labels.save).disabled).toBe(true);

      yield* typeInto('crm-client-name', copy.clientName);
      expect(bodyText()).not.toContain(labels.invalid);
      expect(bodyText()).toContain(labels.unsaved);
      expect(buttonNamed(labels.save).disabled).toBe(false);
      expect(sent).toEqual([]);
    }),
  );
});
