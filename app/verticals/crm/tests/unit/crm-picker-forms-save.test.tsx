// @rstest-environment happy-dom
// The CRM picker forms (transfer a client, pair an order, approve a source customer link) send their one command only
// from the shared Save button ("Uložit"); picking and typing change only the draft. The forms run with the real
// module i18n, router blocker and select template; submit is the explicit owner feature port.
import { acted, settleOnFakeTimers, unmountAll } from '@app/admin-ui/testing/module-ui';
import { pinTestDocument } from '@app/shared-contracts/testing/http-double';
import { Deferred, Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { CrmCommandInput } from '../../shared/actions/apply-command.ts';
import { ClientSchema } from '../../shared/domain/clients.ts';
import { crmI18nResources } from '../../src/crm/i18n.ts';
import { mountInRoute } from '../support/module-ui.ts';
import { PairingForm } from '../../src/routes/[lang]/crm/importy/pairing-form.tsx';
import { AssignDialog } from '../../src/routes/[lang]/crm/klienti/assign-dialog.tsx';
import { NewLinkPanel } from '../../src/routes/[lang]/crm/parovani/new-link-panel.tsx';
import { akros, brano, copy, order, records, recording, saveButton } from './crm-form-fixture.tsx';

/** Drive the real UI kit select's native form control. */
const pick = (name: string, value: string) =>
  acted(() => {
    const select = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)),
    );
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, settleOnFakeTimers);

const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLTextAreaElement>(`textarea[id="${id}"]`)),
    );
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, settleOnFakeTimers);

const click = (target: HTMLElement) => acted(() => target.click(), settleOnFakeTimers);

// Drain the whole scheduled queue, including timers scheduled by React's flushed effects. This is not a delay.
const drainScheduledWork: Effect.Effect<void> = Effect.promise(() => act(() => rstest.runAllTimersAsync())).pipe(
  Effect.andThen(Effect.suspend(() => (rstest.getTimerCount() === 0 ? Effect.void : drainScheduledWork))),
);

beforeEach(() => {
  rstest.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
});

afterEach(() => {
  unmountAll();
  rstest.useRealTimers();
});

describe('CRM pickers save from Uložit only', () => {
  it.live('transferring a client sends one AssignClient after picking, the reason and Uložit', () =>
    Effect.gen(function* transferClient() {
      yield* pinTestDocument;
      const completed = yield* Deferred.make<string>();
      const sent: CrmCommandInput[] = [];
      const closed: string[] = [];
      const owned = Schema.decodeSync(ClientSchema)({
        ...Schema.encodeSync(ClientSchema)(akros),
        ownerSalespersonId: 'sp-1',
      });
      yield* mountInRoute(
        <AssignDialog
          client={owned}
          onClose={() => {
            closed.push('closed');
            Deferred.doneUnsafe(completed, Effect.succeed('saved'));
          }}
          records={records}
          submit={recording(sent)}
        />,
        { resources: crmI18nResources, settle: settleOnFakeTimers },
      );
      expect(saveButton().disabled).toBe(true);
      yield* pick('assign-target', 'none');
      // A transfer without a reason is held back.
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('crm-assign-reason', copy.reason);
      // Exhaust scheduled work so a delayed autosave cannot hide behind the synchronous change handler.
      yield* drainScheduledWork;
      expect(sent).toEqual([]);

      yield* click(saveButton());
      // The public success callback runs after the draft-save controller finishes the submission.
      yield* Deferred.await(completed);
      yield* drainScheduledWork;
      expect(sent).toEqual([{ _tag: 'AssignClient', clientId: owned.id, reason: copy.reason }]);
      expect(closed).toEqual(['closed']);
    }),
  );

  it.live('pairing an order sends one PairOrder with the typed reason', () =>
    Effect.gen(function* pairOrder() {
      yield* pinTestDocument;
      const completed = yield* Deferred.make<string>();
      const sent: CrmCommandInput[] = [];
      const saved: string[] = [];
      yield* mountInRoute(
        <PairingForm
          onCancel={constVoid}
          onSaved={() => {
            saved.push('saved');
            Deferred.doneUnsafe(completed, Effect.succeed('saved'));
          }}
          order={order}
          records={records}
          submit={recording(sent)}
        />,
        { resources: crmI18nResources, settle: settleOnFakeTimers },
      );
      expect(saveButton().disabled).toBe(true);
      yield* typeInto(`pairing-reason-${order.id}`, copy.reason);
      yield* click(saveButton());
      // The public success callback runs after the draft-save controller finishes the submission.
      yield* Deferred.await(completed);
      yield* drainScheduledWork;
      expect(sent).toEqual([{ _tag: 'PairOrder', clientId: brano.id, orderId: order.id, reason: copy.reason }]);
      expect(saved).toEqual(['saved']);
    }),
  );

  it.live('a new approved link sends one LinkExternalCustomer after the pickers and Uložit', () =>
    Effect.gen(function* approveLink() {
      yield* pinTestDocument;
      const completed = yield* Deferred.make<string>();
      const sent: CrmCommandInput[] = [];
      const closed: string[] = [];
      yield* mountInRoute(
        <NewLinkPanel
          onClose={() => {
            closed.push('closed');
            Deferred.doneUnsafe(completed, Effect.succeed('saved'));
          }}
          records={records}
          submit={recording(sent)}
        />,
        { resources: crmI18nResources, settle: settleOnFakeTimers },
      );
      yield* pick('externalCustomerId', 'C-77');
      yield* pick('link-client', brano.id);
      // Exhaust scheduled work so a delayed autosave cannot hide behind the synchronous change handler.
      yield* drainScheduledWork;
      expect(sent).toEqual([]);

      yield* click(saveButton());
      // The public success callback runs after the draft-save controller finishes the submission.
      yield* Deferred.await(completed);
      yield* drainScheduledWork;
      expect(sent).toEqual([
        { _tag: 'LinkExternalCustomer', clientId: brano.id, externalCustomerId: 'C-77', source: 'E-shop' },
      ]);
      expect(closed).toEqual(['closed']);
    }),
  );
});
