// @rstest-environment happy-dom
// The client form runs under the real Czech i18n and router. Typing changes only the draft; Save sends it.
import { requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import { acted, settle, unmountAll } from '@app/admin-ui/testing/module-ui';
import { Effect, Option, Predicate, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
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

const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const buttonNamed = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.textContent ?? '').trim() === text,
  );
  expect(found).toBeDefined();
  return Option.getOrThrow(Option.fromUndefinedOr(found));
};

const clickButton = (text: string) => acted(() => buttonNamed(text).click());

const succeeding =
  (sent: CrmCommandInput[]): CrmCommandSubmit =>
  (command) => {
    sent.push(command);
    return Effect.succeed({ entityIds: [client.id], ok: true });
  };

afterEach(unmountAll);

describe('client form', () => {
  it.live('reads the required text of a required field in Czech', () =>
    Effect.gen(function* requiredText() {
      yield* mount({ mode: 'create', submit: succeeding([]) });
      const name = document.querySelector<HTMLInputElement>('[id="crm-client-name"]');
      expect(name?.labels?.[0]?.textContent).toContain(requiredLabelFor('cs'));
      expect(document.body.textContent).not.toContain('(required)');
    }),
  );

  it.live('editing a client sends nothing until Uložit is clicked, and then sends once', () =>
    Effect.gen(function* editSendsOnce() {
      const sent: CrmCommandInput[] = [];
      yield* mount({ client, mode: 'edit', submit: succeeding(sent) });

      yield* typeInto('crm-client-name', 'Akros CZ s.r.o.');
      yield* typeInto('crm-client-phone', '+420 601 000 000');
      yield* Effect.sleep('1 second');
      yield* settle;
      expect(sent).toEqual([]);

      yield* clickButton('Uložit');
      expect(sent).toEqual([
        {
          _tag: 'UpdateClient',
          id: client.id,
          patch: { name: 'Akros CZ s.r.o.', phone: '+420 601 000 000' },
        },
      ]);
    }),
  );

  it.live('leaving an edited client without saving writes nothing', () =>
    Effect.gen(function* leaveWithoutSaving() {
      const sent: CrmCommandInput[] = [];
      yield* mount({ client, mode: 'edit', submit: succeeding(sent) });

      yield* typeInto('crm-client-name', 'Jiný název');
      unmountAll();
      yield* settle;
      expect(sent).toEqual([]);
    }),
  );

  it.live('a new client is sent once by the same Uložit, never by Enter', () =>
    Effect.gen(function* createOnlyOnSave() {
      const sent: CrmCommandInput[] = [];
      yield* mount({ mode: 'create', submit: succeeding(sent) });

      yield* typeInto('crm-client-name', 'Nová firma');
      yield* acted(() => {
        Option.getOrThrow(Option.fromNullOr(document.querySelector('form'))).requestSubmit();
      });
      yield* settle;
      expect(sent).toEqual([]);

      yield* clickButton('Uložit');
      expect(sent.length).toBe(1);
      expect(Predicate.isTagged(sent[0], 'CreateClient')).toBe(true);
      expect(sent[0]).toMatchObject({ kind: 'organization', name: 'Nová firma' });
    }),
  );

  it.live('a new client with only its main contact typed says why Uložit is disabled and marks the name', () =>
    Effect.gen(function* contactOnlyValidation() {
      const sent: CrmCommandInput[] = [];
      yield* mount({ mode: 'create', submit: succeeding(sent) });
      expect(bodyText()).not.toContain(labels.invalid);
      expect(bodyText()).not.toContain(copy.nameRequired);

      yield* typeInto('crm-new-contact-0-name', copy.contactName);
      yield* settle;
      expect(bodyText()).toContain(labels.invalid);
      expect(bodyText()).toContain(copy.nameRequired);
      expect(buttonNamed(labels.save).disabled).toBe(true);

      yield* typeInto('crm-client-name', copy.clientName);
      yield* settle;
      expect(bodyText()).not.toContain(labels.invalid);
      expect(bodyText()).toContain(labels.unsaved);
      expect(buttonNamed(labels.save).disabled).toBe(false);
      expect(sent).toEqual([]);
    }),
  );
});
