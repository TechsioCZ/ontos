// @rstest-environment happy-dom
// The client form as the user sees it: typing changes only the draft, and one Save button (or the create button)
// sends it. Only the i18n runtime, the toaster and the browser runtime's clock are replaced.
import { Effect, Option, Schema } from 'effect';
import { afterEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ClientFormDialog } from '../../src/routes/[lang]/crm/klienti/client-form-dialog.tsx';
import type { CrmCommandSubmit } from '../../src/crm/records.ts';
import type { CrmCommandInput } from '../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { ClientSchema } from '../../shared/domain/clients.ts';
import type { Client } from '../../shared/domain/clients.ts';
import { IsoTimeSchema } from '../../shared/domain/common.ts';
import { initialCrmState } from '../../shared/domain/state.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
// Outside a router: no route change is ever blocked here.
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

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

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const views: { readonly unmount: () => void }[] = [];

const mount = async (props: {
  readonly client?: Client;
  readonly mode: 'create' | 'edit';
  readonly submit: CrmCommandSubmit;
}) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  views.push({ unmount });
  await act(async () => {
    root.render(
      <ClientFormDialog
        busy={false}
        client={props.client}
        mode={props.mode}
        onClose={() => {}}
        onSaved={() => {}}
        records={recordsWith(props.client === undefined ? [] : [props.client])}
        submit={props.submit}
      />,
    );
  });
  await settle();
  return { container, unmount };
};

const typeInto = async (_container: HTMLElement, id: string, value: string) => {
  const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const buttonNamed = (_container: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.textContent ?? '').trim() === text,
  );
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const clickButton = async (container: HTMLElement, text: string) => {
  const button = buttonNamed(container, text);
  await act(async () => {
    button.click();
  });
  await settle();
};

const succeeding =
  (sent: CrmCommandInput[]): CrmCommandSubmit =>
  (command) => {
    sent.push(command);
    return Effect.succeed({ entityIds: [client.id], ok: true });
  };

afterEach(() => {
  for (const view of views.splice(0)) {
    view.unmount();
  }
});

describe('client form', () => {
  it.live('editing a client sends nothing until Uložit is clicked, and then sends once', () =>
    Effect.gen(function* editSendsOnce() {
      const sent: CrmCommandInput[] = [];
      const { container } = yield* Effect.promise(() => mount({ client, mode: 'edit', submit: succeeding(sent) }));

      yield* Effect.promise(() => typeInto(container, 'crm-client-name', 'Akros CZ s.r.o.'));
      yield* Effect.promise(() => typeInto(container, 'crm-client-phone', '+420 601 000 000'));
      yield* Effect.sleep('1 second');
      yield* Effect.promise(settle);
      expect(sent).toEqual([]);

      yield* Effect.promise(() => clickButton(container, 'Uložit'));
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
    Effect.promise(async () => {
      const sent: CrmCommandInput[] = [];
      const { container, unmount } = await mount({ client, mode: 'edit', submit: succeeding(sent) });

      await typeInto(container, 'crm-client-name', 'Jiný název');
      unmount();
      await settle();
      expect(sent).toEqual([]);
    }),
  );

  it.live('a new client is sent once by the same Uložit, never by Enter', () =>
    Effect.promise(async () => {
      const sent: CrmCommandInput[] = [];
      const { container } = await mount({ mode: 'create', submit: succeeding(sent) });

      await typeInto(container, 'crm-client-name', 'Nová firma');
      await act(async () => {
        Option.getOrThrow(Option.fromNullOr(document.querySelector('form'))).requestSubmit();
      });
      await settle();
      expect(sent).toEqual([]);

      await clickButton(container, 'Uložit');
      expect(sent.length).toBe(1);
      expect(sent[0]).toMatchObject({ _tag: 'CreateClient', kind: 'organization', name: 'Nová firma' });
    }),
  );
});
