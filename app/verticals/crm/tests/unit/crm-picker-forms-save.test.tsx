// @rstest-environment happy-dom
// The CRM picker forms (transfer a client, pair an order, approve a source customer link) send their one command only
// from the shared Save button ("Uložit"); picking and typing change only the draft. The i18n runtime, the router
// blocker and the select template (by a native select) are replaced.
import { Effect, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import type { CrmCommandInput } from '../../shared/actions/apply-command.ts';
import { ClientSchema } from '../../shared/domain/clients.ts';
import { PairingForm } from '../../src/routes/[lang]/crm/importy/pairing-form.tsx';
import { AssignDialog } from '../../src/routes/[lang]/crm/klienti/assign-dialog.tsx';
import { NewLinkPanel } from '../../src/routes/[lang]/crm/parovani/new-link-panel.tsx';
import {
  akros,
  brano,
  click,
  copy,
  mount,
  order,
  pick,
  records,
  recording,
  saveButton,
  typeInto,
  unmountAll,
} from './crm-form-fixture.tsx';

/** The props the native stand-in of the select template reads. */
interface NativeSelectProps {
  readonly items: readonly { readonly label: string; readonly value: string }[];
  readonly name?: string;
  readonly onValueChange: (details: { readonly value: string[] }) => void;
  readonly value?: readonly string[];
}

rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@app/admin-ui/select-template', () => ({
  SelectTemplate: ({ items, name, onValueChange, value }: NativeSelectProps) =>
    createElement(
      'select',
      {
        name,
        onChange: (event: { readonly target: { readonly value: string } }) =>
          onValueChange({ value: event.target.value === '' ? [] : [event.target.value] }),
        value: value?.[0] ?? '',
      },
      createElement('option', { value: '' }),
      ...items.map((item) => createElement('option', { key: item.value, value: item.value }, item.label)),
    ),
}));

afterEach(unmountAll);

describe('CRM pickers save from Uložit only', () => {
  it.live('transferring a client sends one AssignClient after picking, the reason and Uložit', () =>
    Effect.gen(function* transferClient() {
      const sent: CrmCommandInput[] = [];
      const closed: string[] = [];
      const owned = Schema.decodeSync(ClientSchema)({
        ...Schema.encodeSync(ClientSchema)(akros),
        ownerSalespersonId: 'sp-1',
      });
      yield* mount(
        <AssignDialog
          client={owned}
          onClose={() => {
            closed.push('closed');
          }}
          records={records}
          submit={recording(sent)}
        />,
      );
      expect(saveButton().disabled).toBe(true);
      yield* pick('assign-target', 'none');
      // A transfer without a reason is held back.
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('crm-assign-reason', copy.reason);
      expect(sent).toEqual([]);

      yield* click(saveButton());
      expect(sent).toEqual([{ _tag: 'AssignClient', clientId: owned.id, reason: copy.reason }]);
      expect(closed).toEqual(['closed']);
    }),
  );

  it.live('pairing an order sends one PairOrder with the typed reason', () =>
    Effect.gen(function* pairOrder() {
      const sent: CrmCommandInput[] = [];
      const saved: string[] = [];
      yield* mount(
        <PairingForm
          onCancel={constVoid}
          onSaved={() => {
            saved.push('saved');
          }}
          order={order}
          records={records}
          submit={recording(sent)}
        />,
      );
      expect(saveButton().disabled).toBe(true);
      yield* typeInto(`pairing-reason-${order.id}`, copy.reason);
      yield* click(saveButton());
      expect(sent).toEqual([{ _tag: 'PairOrder', clientId: brano.id, orderId: order.id, reason: copy.reason }]);
      expect(saved).toEqual(['saved']);
    }),
  );

  it.live('a new approved link sends one LinkExternalCustomer after the pickers and Uložit', () =>
    Effect.gen(function* approveLink() {
      const sent: CrmCommandInput[] = [];
      const closed: string[] = [];
      yield* mount(
        <NewLinkPanel
          onClose={() => {
            closed.push('closed');
          }}
          records={records}
          submit={recording(sent)}
        />,
      );
      yield* pick('externalCustomerId', 'C-77');
      yield* pick('link-client', brano.id);
      expect(sent).toEqual([]);

      yield* click(saveButton());
      expect(sent).toEqual([
        { _tag: 'LinkExternalCustomer', clientId: brano.id, externalCustomerId: 'C-77', source: 'E-shop' },
      ]);
      expect(closed).toEqual(['closed']);
    }),
  );
});
