// @rstest-environment happy-dom
// The visit and plan panels send their one command only from the shared Save button ("Uložit"), last in the footer:
// typing and Enter change only the draft. The panels use the real module i18n and TanStack router.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option, Predicate, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { acted, unmountAll } from '@app/admin-ui/testing/module-ui';
import { mountInRoute } from '../support/module-ui.ts';
import { PlanContactPanel } from '../../src/routes/[lang]/crm/k-osloveni/plan-panels.tsx';
import { RecordVisitPanel } from '../../src/routes/[lang]/crm/navstevy/visit-panels.tsx';
import type { CrmCommandSubmit } from '../../src/crm/records.ts';
import type { CrmCommandInput } from '../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { ClientSchema } from '../../shared/domain/clients.ts';
import { IsoTimeSchema } from '../../shared/domain/common.ts';
import { initialCrmState } from '../../shared/domain/state.ts';

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

const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const pressEnter = (id: string) =>
  acted(() => {
    field(id).form?.requestSubmit();
  });

const clickSave = () =>
  acted(() => {
    saveButton().click();
  });

const clickCancel = () =>
  acted(() => {
    const cancel = Option.getOrThrow(
      Option.fromNullishOr(footerButtons().find((button) => (button.textContent ?? '').trim() === 'Zrušit')),
    );
    cancel.click();
  });

/** A submit the server refuses without a message. */
const refusing: CrmCommandSubmit = () => Effect.succeed({ entityIds: [], ok: false });

/** Whether the Uložit / Zahodit změny / Zůstat question is up. */
const leaveQuestion = (): boolean => document.querySelector('[role="alertdialog"]') !== null;

afterEach(unmountAll);

describe('CRM panels save from Uložit only', () => {
  it.live('a visit is recorded once by Uložit, never by Enter', () =>
    Effect.gen(function* recordVisitFromSave() {
      const sent: CrmCommandInput[] = [];
      const closed: boolean[] = [];
      yield* mountInRoute(
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

      yield* typeInto('crm-visit-new-result', 'Objednají v pondělí');
      yield* pressEnter('crm-visit-new-result');
      expect(sent).toEqual([]);

      yield* clickSave();
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'RecordVisit')).toBe(true);
      expect(sent[0]).toMatchObject({ clientId: client.id, result: 'Objednají v pondělí' });
      expect(closed).toEqual([false]);
    }),
  );

  it.live('a contact planned for a known client is sent by the first Uložit', () =>
    Effect.gen(function* planContactFromSave() {
      const sent: CrmCommandInput[] = [];
      yield* mountInRoute(
        <PlanContactPanel clientId={client.id} onClose={constVoid} records={records} submit={recording(sent)} />,
      );
      expect(saveButton().disabled).toBe(false);

      yield* clickSave();
      expect(sent).toEqual([{ _tag: 'PlanContact', clientId: client.id, dueDate: '2026-10-22' }]);
    }),
  );

  it.live('the planned contact closes untouched without asking, but asks once its save failed', () =>
    Effect.gen(function* guardRefusedPlan() {
      const closed: string[] = [];
      yield* mountInRoute(
        <PlanContactPanel
          clientId={client.id}
          onClose={() => {
            closed.push('closed');
          }}
          records={records}
          submit={refusing}
        />,
      );
      yield* clickCancel();
      expect(closed).toEqual(['closed']);
      expect(leaveQuestion()).toBe(false);

      // The opening values were sent and refused: they are now the user's unsaved draft.
      yield* clickSave();
      yield* clickCancel();
      expect(closed).toEqual(['closed']);
      expect(leaveQuestion()).toBe(true);
    }),
  );
});
