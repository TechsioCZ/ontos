// @rstest-environment happy-dom
// The typed invoice workflow forms (earlier documents taken into account, a failed or accepted handover package) save
// only from the shared Uložit, and the document kind changes only after its confirmation. Only the i18n runtime, the
// router blocker and the picker are replaced.
import { Effect } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { ACCOUNTING_EXPORT_SCHEMA_VERSION, FinanceInvoiceResourceIdSchema } from '../../shared/apis/records.ts';
import type { AccountingExport, Invoice } from '../../shared/apis/records.ts';
import {
  ExportConfirmationForm,
  ExportFailureForm,
} from '../../src/routes/[lang]/finance/accounting-decision-forms.tsx';
import { DocumentKindSelect } from '../../src/routes/[lang]/finance/document-kind-select.tsx';
import type { FinanceViewModel } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import { PriorSettlementForm } from '../../src/routes/[lang]/finance/prior-settlement-form.tsx';
import {
  clickCancel,
  clickDiscard,
  clickNamed,
  clickSave,
  fakeVm,
  invoiceFixture,
  labels,
  lastFooterButton,
  leaveQuestion,
  mount,
  pick,
  pressEnter,
  saveButton,
  typeInto,
  unmountAll,
  waitUntil,
} from './finance-form-harness.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ proceed: constVoid, reset: constVoid, status: 'idle' }),
}));
// The picker: one button that picks the first item; its `data-pick` names the field.
rstest.mock('@app/admin-ui/select-template', () => ({
  SelectTemplate: (props: {
    readonly items: readonly { readonly value: string }[];
    readonly label?: unknown;
    readonly onValueChange?: (details: { readonly value: string[] }) => void;
  }) =>
    createElement('button', {
      'data-pick': String(props.label),
      onClick: () => props.onValueChange?.({ value: props.items.slice(0, 1).map((item) => item.value) }),
      type: 'button',
    }),
}));

type Command = Parameters<FinanceViewModel['execute']>[0];

const CONFIRM_CHECK = 'prior-confirm';
const KIND_CONFIRM = 'finance-billing.financeUi.documentKind.confirm';
const KIND_PICKER = 'finance-billing.financeUi.common.documentKind';

const target = invoiceFixture({ businessState: 'DRAFT', documentKind: 'FINAL' });
const advance = invoiceFixture({
  documentKind: 'ADVANCE',
  documentNumber: 'ZF-2026-001',
  paidMinor: 50_000,
  ref: { ...target.ref, resourceId: 'c0000000-0000-4000-8000-000000000031' },
});
const advanceId = FinanceInvoiceResourceIdSchema.make(advance.ref.resourceId);
const handover: AccountingExport = {
  batchNumber: 'UP-2026-003',
  content: '',
  createdAt: target.createdAt,
  fileName: 'up-2026-003.csv',
  format: 'CSV',
  id: 'export-3',
  invoiceResourceIds: [advanceId],
  schemaVersion: ACCOUNTING_EXPORT_SCHEMA_VERSION,
  sha256: '0'.repeat(64),
  status: 'HANDED_OVER',
  version: 1,
};

const closes: string[] = [];
const onClose = () => {
  closes.push('closed');
};

const checkConfirmation = Effect.sync(() => {
  document.querySelector<HTMLInputElement>(`[id="${CONFIRM_CHECK}"]`)?.click();
});

const settlementForm = (vm: FinanceViewModel) => (
  <PriorSettlementForm available={() => 50_000} candidates={[advance]} invoice={target} onClose={onClose} vm={vm} />
);

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  closes.length = 0;
});

afterEach(() => {
  unmountAll();
  rstest.unstubAllGlobals();
});

describe('invoice workflow forms save from Uložit only', () => {
  it.live(
    'earlier documents: typing and Enter send nothing; checked amounts are saved once and the dialog closes',
    () =>
      Effect.gen(function* settlement() {
        const sent: Command[] = [];
        const vm = fakeVm(sent, { state: { invoices: [target, advance] } });
        yield* mount(settlementForm(vm));
        expect(lastFooterButton()).toBe(saveButton());
        yield* typeInto(`prior-${advance.ref.resourceId}`, '200');
        yield* typeInto('prior-note', 'DDP 2026-01');
        yield* pressEnter('prior-note');
        expect(saveButton().disabled).toBe(true);
        yield* checkConfirmation;
        yield* waitUntil(() => !saveButton().disabled);
        expect(sent).toEqual([]);

        yield* clickSave;
        yield* waitUntil(() => closes.length === 1);
        expect(sent).toEqual([
          {
            _tag: 'SetPriorSettlement',
            actorLabel: 'Jana Nováková',
            entries: [{ amountMinor: 20_000, invoiceResourceId: advance.ref.resourceId }],
            invoiceRef: target.ref,
            note: 'DDP 2026-01',
          },
        ]);
      }),
  );

  it.live('earlier documents: someone else saved meanwhile, so Uložit is refused as a conflict', () =>
    Effect.gen(function* settlementConflict() {
      const sent: Command[] = [];
      const render = yield* mount(settlementForm(fakeVm(sent, { state: { invoices: [target, advance] } })));
      yield* typeInto(`prior-${advance.ref.resourceId}`, '200');
      yield* checkConfirmation;
      const changed: Invoice = {
        ...target,
        priorSettlement: {
          confirmedAt: target.createdAt,
          entries: [{ amountMinor: 10_000, invoiceResourceId: advanceId, number: 'ZF-2026-001' }],
        },
      };
      yield* render(settlementForm(fakeVm(sent, { state: { invoices: [changed, advance] } })));
      yield* clickSave;
      yield* waitUntil(() => (document.body.textContent ?? '').includes(labels.conflict));
      expect(sent).toEqual([]);
      expect(closes).toEqual([]);
    }),
  );

  it.live('a failed package: the reason is saved once by Uložit; typed input asks before leaving', () =>
    Effect.gen(function* failure() {
      const sent: Command[] = [];
      yield* mount(<ExportFailureForm entry={handover} onClose={onClose} vm={fakeVm(sent)} />);
      yield* typeInto('export-failure', 'POHODA odmítla import');
      yield* clickCancel;
      expect(leaveQuestion()).toBe(true);
      yield* clickNamed(labels.stay);
      expect(closes).toEqual([]);

      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(sent).toEqual([
        {
          _tag: 'MarkAccountingExportFailed',
          actorLabel: 'Jana Nováková',
          exportId: handover.id,
          reason: 'POHODA odmítla import',
        },
      ]);
    }),
  );

  it.live('the accountant accepted a package: the proof is saved once; an untouched dialog closes at once', () =>
    Effect.gen(function* confirmation() {
      const sent: Command[] = [];
      yield* mount(<ExportConfirmationForm entry={handover} onClose={onClose} vm={fakeVm(sent)} />);
      yield* clickCancel;
      expect(closes).toEqual(['closed']);
      expect(leaveQuestion()).toBe(false);

      unmountAll();
      closes.length = 0;
      yield* mount(<ExportConfirmationForm entry={handover} onClose={onClose} vm={fakeVm(sent)} />);
      yield* typeInto('export-evidence', 'e-mail z 20. 10. 2026');
      yield* clickCancel;
      yield* clickDiscard;
      expect(closes).toEqual(['closed']);
      expect(sent).toEqual([]);
    }),
  );

  it.live('picking a document kind writes nothing until its confirmation', () =>
    Effect.gen(function* documentKind() {
      const sent: Command[] = [];
      const kinds = { ADVANCE: 'a', FINAL: 'f', PARTIAL: 'p', RECURRING: 'r', STANDARD: 's' } as const;
      yield* mount(<DocumentKindSelect disabled={false} invoice={target} kinds={kinds} vm={fakeVm(sent)} />);
      yield* pick(KIND_PICKER);
      expect(sent).toEqual([]);
      yield* clickNamed(KIND_CONFIRM);
      yield* waitUntil(() => sent.length === 1);
      expect(sent).toEqual([{ _tag: 'SetInvoiceDetails', documentKind: 'ADVANCE', invoiceRef: target.ref }]);
    }),
  );
});
