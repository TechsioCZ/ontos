// @rstest-environment happy-dom
// Workflow forms run with the real finance view model, router, translations and controls. The Shell gateway and
// finance HTTP contracts answer in process; assertions record the commands received by the owner.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpRouter, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Match, Option, Schema } from 'effect';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import type { FinanceCommandSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import {
  ACCOUNTING_EXPORT_SCHEMA_VERSION,
  FinanceInvoiceResourceIdSchema,
  RecordsApi,
} from '../../shared/apis/records.ts';
import type { AccountingExport, Invoice, RecordsResponse } from '../../shared/apis/records.ts';
import {
  ExportConfirmationForm,
  ExportFailureForm,
} from '../../src/routes/[lang]/finance/accounting-decision-forms.tsx';
import { DocumentKindSelect } from '../../src/routes/[lang]/finance/document-kind-select.tsx';
import type { FinanceViewModel } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import { PriorSettlementForm } from '../../src/routes/[lang]/finance/prior-settlement-form.tsx';
import { useFinanceRecords } from '../../src/routes/[lang]/finance/use-finance-records.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';
import { invoiceFixture } from './finance-form-harness.ts';

type Command = typeof FinanceCommandSchema.Encoded;
const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const CONFIRM_CHECK = 'prior-confirm';
const KIND_CONFIRM = czech('finance-billing.financeUi.documentKind.confirm');
const KIND_PICKER = czech('finance-billing.financeUi.common.documentKind');
const CANCEL = czech('finance-billing.financeUi.common.cancel');

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
const indicators = {
  costMinor: 0,
  costVarianceMinor: 0,
  draftCount: 0,
  grossOutstandingMinor: 0,
  openIncomingInvoices: 0,
  openInvoices: 0,
  openOutgoingInvoices: 0,
  overdueInvoices: 0,
  payablesOutstandingMinor: 0,
  plannedCostMinor: 0,
  plannedRevenueMinor: 0,
  receivablesOutstandingMinor: 0,
  revenueMinor: 0,
  revenueVarianceMinor: 0,
};
const initialRecords = (): RecordsResponse => ({
  canWrite: true,
  indicators,
  referenceDate: '2026-10-05',
  revision: 1,
  state: { accountingExports: [handover], financialPlanEntries: [], invoices: [target, advance] },
});
let records = initialRecords();
const sent: Command[] = [];
const closes: string[] = [];
const onClose = () => {
  closes.push('closed');
};
const OwnerActionApi = ApplyCommandActionApi.prefix('/finance-billing-api');
const OwnerRecordsApi = RecordsApi.prefix('/finance-billing-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'finance-billing': '/finance-billing-api' }).application,
  HttpRouter.add(
    'GET',
    '/shell-super-app-api/auth/session',
    Effect.succeed(HttpServerResponse.jsonUnsafe({ identity: { displayName: 'Jana Nováková' } })),
  ),
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          sent.push(payload.command);
          return { changed: true, invoice: target, revision: 2 };
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', () => Effect.sync(() => records)),
    ),
  ),
);

const FormKindSchema = Schema.Literals(['settlement', 'failure', 'confirmation', 'kind']);
type FormKind = typeof FormKindSchema.Type;
let model: FinanceViewModel | null = null;
let scopeSequence = 0;
const currentModel = () => Option.getOrThrow(Option.fromNullOr(model));
const FormHarness = ({ kind, scope }: { readonly kind: FormKind; readonly scope: string }) => {
  const vm = useFinanceRecords({ scope });
  useEffect(() => {
    model = vm;
  }, [vm]);
  if (!vm.canWrite || vm.actorLabel === undefined) {
    return null;
  }
  return Match.value(kind).pipe(
    Match.when('settlement', () => (
      <PriorSettlementForm available={() => 50_000} candidates={[advance]} invoice={target} onClose={onClose} vm={vm} />
    )),
    Match.when('failure', () => <ExportFailureForm entry={handover} onClose={onClose} vm={vm} />),
    Match.when('confirmation', () => <ExportConfirmationForm entry={handover} onClose={onClose} vm={vm} />),
    Match.when('kind', () => (
      <DocumentKindSelect
        disabled={false}
        invoice={target}
        kinds={{ ADVANCE: 'a', FINAL: 'f', PARTIAL: 'p', RECURRING: 'r', STANDARD: 's' }}
        vm={vm}
      />
    )),
    Match.exhaustive,
  );
};
const mountForm = (kind: FormKind) =>
  Effect.gen(function* mount() {
    yield* pinTestDocument;
    scopeSequence += 1;
    yield* mountInRoute(<FormHarness kind={kind} scope={`invoice-workflow-${scopeSequence}`} />, {
      path: 'finance',
      url: '/cs/finance',
    });
    yield* waitUntil(() =>
      kind === 'kind' ? document.querySelector('select') !== null : buttons(labels.save).length > 0,
    );
  });
const saveButton = (): HTMLButtonElement =>
  Option.getOrThrow(
    Option.fromUndefinedOr(buttons(labels.save).find((button) => button.closest('[role="alertdialog"]') === null)),
  );
const field = (id: string) =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));
const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const pressEnter = (id: string) => acted(() => field(id).form?.requestSubmit());
const checkConfirmation = acted(() => field(CONFIRM_CHECK).click());
const clickNamed = (name: string) =>
  acted(() => Option.getOrThrow(Option.fromUndefinedOr(buttons(name).at(-1))).click());
const clickSave = acted(() => saveButton().click());
const clickCancel = clickNamed(CANCEL);
const leaveQuestion = () =>
  [...document.querySelectorAll('[role="alertdialog"]')].some((dialog) =>
    dialog.textContent?.includes(labels.leaveTitle),
  );
const pick = (label: string, value: string) =>
  acted(() => {
    const select = Option.getOrThrow(
      Option.fromUndefinedOr(
        [...document.querySelectorAll<HTMLSelectElement>('select')].find(
          (candidate) =>
            document.querySelector(`[id="${candidate.getAttribute('aria-labelledby') ?? ''}"]`)?.textContent?.trim() ===
            label,
        ),
      ),
    );
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

beforeEach(() => {
  closes.length = 0;
  sent.length = 0;
  model = null;
  records = initialRecords();
});
afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })('invoice workflow forms save from Uložit only', (suite) => {
  suite.effect(
    'earlier documents: typing and Enter send nothing; checked amounts are saved once and the dialog closes',
    () =>
      Effect.gen(function* settlement() {
        yield* mountForm('settlement');

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

  suite.effect('earlier documents: someone else saved meanwhile, so Uložit is refused as a conflict', () =>
    Effect.gen(function* settlementConflict() {
      yield* mountForm('settlement');
      yield* typeInto(`prior-${advance.ref.resourceId}`, '200');
      yield* checkConfirmation;
      const changed: Invoice = {
        ...target,
        priorSettlement: {
          confirmedAt: target.createdAt,
          entries: [{ amountMinor: 10_000, invoiceResourceId: advanceId, number: 'ZF-2026-001' }],
        },
      };
      records = { ...records, revision: 2, state: { ...records.state, invoices: [changed, advance] } };
      yield* acted(() => currentModel().reload());
      yield* waitUntil(() => currentModel().snapshot?.revision === 2);
      yield* clickSave;
      yield* waitUntil(() => (document.body.textContent ?? '').includes(labels.conflict));
      expect(sent).toEqual([]);
      expect(closes).toEqual([]);
    }),
  );

  suite.effect('a failed package: the reason is saved once by Uložit; typed input asks before leaving', () =>
    Effect.gen(function* failure() {
      yield* mountForm('failure');
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

  suite.effect('the accountant accepted a package: its proof and export identity are saved', () =>
    Effect.gen(function* confirmation() {
      yield* mountForm('confirmation');
      yield* typeInto('export-evidence', 'e-mail z 20. 10. 2026');
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(sent).toEqual([
        {
          _tag: 'ConfirmAccountingExport',
          actorLabel: 'Jana Nováková',
          evidence: 'e-mail z 20. 10. 2026',
          exportId: handover.id,
        },
      ]);
    }),
  );

  suite.effect('picking a document kind writes nothing until its confirmation', () =>
    Effect.gen(function* documentKind() {
      yield* mountForm('kind');
      yield* pick(KIND_PICKER, 'ADVANCE');
      yield* waitUntil(() => buttons(KIND_CONFIRM).length > 0);
      expect(sent).toEqual([]);
      yield* clickNamed(KIND_CONFIRM);
      yield* waitUntil(() => sent.length === 1);
      expect(sent).toEqual([{ _tag: 'SetInvoiceDetails', documentKind: 'ADVANCE', invoiceRef: target.ref }]);
    }),
  );
});
