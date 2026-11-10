// @rstest-environment happy-dom
// The visit and plan panels send their one command only from the shared Save button ("Uložit"), last in the footer:
// typing and Enter change only the draft. Only the i18n runtime and the router blocker are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PlanContactPanel } from '../../src/routes/[lang]/crm/k-osloveni/plan-panels.tsx';
import { RecordVisitPanel } from '../../src/routes/[lang]/crm/navstevy/visit-panels.tsx';
import type { CrmCommandSubmit } from '../../src/crm/records.ts';
import type { CrmCommandInput } from '../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { ClientSchema } from '../../shared/domain/clients.ts';
import { IsoTimeSchema } from '../../shared/domain/common.ts';
import { initialCrmState } from '../../shared/domain/state.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const labels = saveLabelsFor('cs');
const client = Schema.decodeSync(ClientSchema)({
  createdAt: '2026-10-15T10:00:00.000Z',
  createdBy: 'principal-1',
  id: 'client-1',
  kind: 'organization',
  name: 'Akros CZ',
  status: 'active',
  updatedAt: '2026-10-15T10:00:00.000Z',
});

const records: RecordsResponse = {
  assignmentCandidates: [],
  departedPrincipalIds: [],
  now: Schema.decodeSync(IsoTimeSchema)('2026-10-15T10:00:00.000Z'),
  revision: 1,
  state: { ...initialCrmState, clients: { ...initialCrmState.clients, items: [client] } },
  viewer: Schema.decodeSync(CrmViewerSchema)({
    assign: false,
    principalId: 'principal-1',
    readAll: true,
    readAssigned: false,
    writeAll: true,
    writeAssigned: false,
  }),
};

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const views: (() => void)[] = [];

const mount = async (element: ReactElement) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  views.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(element);
  });
  await settle();
};

const recording =
  (sent: CrmCommandInput[]): CrmCommandSubmit =>
  (command) =>
    Effect.sync(() => {
      sent.push(command);
      return { entityIds: [], ok: true };
    });

const footerButtons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.closest('form') === null);

const saveButton = (): HTMLButtonElement =>
  Option.getOrThrow(
    Option.fromNullishOr(footerButtons().find((button) => (button.textContent ?? '').trim() === labels.save)),
  );

const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));

const typeInto = async (id: string, value: string) => {
  const input = field(id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

const pressEnter = async (id: string) => {
  await act(async () => {
    field(id).form?.requestSubmit();
  });
  await settle();
};

const clickSave = async () => {
  await act(async () => {
    saveButton().click();
  });
  await settle();
};

const clickCancel = async () => {
  const cancel = Option.getOrThrow(
    Option.fromNullishOr(footerButtons().find((button) => (button.textContent ?? '').trim() === 'Zrušit')),
  );
  await act(async () => {
    cancel.click();
  });
  await settle();
};

/** A submit the server refuses without a message. */
const refusing: CrmCommandSubmit = () => Effect.succeed({ entityIds: [], ok: false });

/** Whether the Uložit / Zahodit změny / Zůstat question is up. */
const leaveQuestion = (): boolean => document.querySelector('[role="alertdialog"]') !== null;

afterEach(() => {
  for (const unmount of views.splice(0)) {
    unmount();
  }
});

describe('CRM panels save from Uložit only', () => {
  it.live('a visit is recorded once by Uložit, never by Enter', () =>
    Effect.promise(async () => {
      const sent: CrmCommandInput[] = [];
      const closed: boolean[] = [];
      await mount(
        <RecordVisitPanel
          clientId={client.id}
          onOpenChange={(open) => {
            closed.push(open);
          }}
          open
          records={records}
          submit={recording(sent)}
        />,
      );
      expect(saveButton().disabled).toBe(true);
      expect(footerButtons().at(-1)).toBe(saveButton());

      await typeInto('crm-visit-new-result', 'Objednají v pondělí');
      await pressEnter('crm-visit-new-result');
      expect(sent).toEqual([]);

      await clickSave();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ _tag: 'RecordVisit', clientId: client.id, result: 'Objednají v pondělí' });
      expect(closed).toEqual([false]);
    }),
  );

  it.live('a contact planned for a known client is sent by the first Uložit', () =>
    Effect.promise(async () => {
      const sent: CrmCommandInput[] = [];
      await mount(
        <PlanContactPanel clientId={client.id} onClose={constVoid} records={records} submit={recording(sent)} />,
      );
      expect(saveButton().disabled).toBe(false);

      await clickSave();
      expect(sent).toEqual([{ _tag: 'PlanContact', clientId: client.id, dueDate: '2026-10-22' }]);
    }),
  );

  it.live('the planned contact closes untouched without asking, but asks once its save failed', () =>
    Effect.promise(async () => {
      const closed: string[] = [];
      await mount(
        <PlanContactPanel
          clientId={client.id}
          onClose={() => {
            closed.push('closed');
          }}
          records={records}
          submit={refusing}
        />,
      );
      await clickCancel();
      expect(closed).toEqual(['closed']);
      expect(leaveQuestion()).toBe(false);

      // The opening values were sent and refused: they are now the user's unsaved draft.
      await clickSave();
      await clickCancel();
      expect(closed).toEqual(['closed']);
      expect(leaveQuestion()).toBe(true);
    }),
  );
});
