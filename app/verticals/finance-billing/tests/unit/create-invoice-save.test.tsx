// @rstest-environment happy-dom
// The new-invoice safeguards through the real i18n, router, pickers, VAT client and toast renderer.
import { requiredLabelFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { ToastProvider } from '@techsio/ui-kit/molecules/toast';
import { Effect, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import type { ReactElement } from 'react';
import { VatChoicesApi } from '../../shared/apis/vat-choices.ts';
import { CreateInvoiceDialog } from '../../src/routes/[lang]/finance/create-invoice-dialog.tsx';
import type { FinanceViewModel } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import type { DraftInvoiceInput, DraftInvoiceOutcome } from '../../src/routes/[lang]/finance/use-finance-records.ts';
import { baselineVatChoices } from '../support/finance-tax-rates.ts';
import { moduleCopy, moduleText, mountInRoute } from '../support/module-ui.ts';
import { clickSave, fakeVm, invoiceFixture, leaveQuestion, saveButton, typeInto } from './finance-form-harness.ts';

const czech = moduleText('cs');
const translations = moduleCopy('cs');
const OwnerApi = VatChoicesApi.prefix('/finance-billing-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'finance-billing': '/finance-billing-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'vatChoices', (group) =>
      group.handle('execute', () =>
        Effect.succeed(baselineVatChoices('00000000-0000-4000-8000-0000000000aa', '2026-10-05')),
      ),
    ),
  ),
);

const mount = (element: ReactElement) =>
  Effect.gen(function* mountForm() {
    yield* pinTestDocument;
    yield* mountInRoute(<ToastProvider>{element}</ToastProvider>, { path: 'finance', url: '/cs/finance' });
    yield* waitUntil(() => document.querySelector('[id="invoice-customer-input"]') !== null);
  });

const clickCancel = acted(() => {
  Option.getOrThrow(Option.fromUndefinedOr(buttons(czech('finance-billing.financeUi.common.cancel')).at(-1))).click();
});

/** Rendered toast titles carry the same type the user sees in their icon and styling. */
const visibleToasts = () =>
  [...document.querySelectorAll<HTMLElement>('[data-scope="toast"][data-part="title"]')].map((title) => ({
    title: title.textContent,
    type: title.dataset['type'],
  }));

const invoice = invoiceFixture();
const { tenantId } = invoice.ref;
const customer: FinanceViewModel['references']['customers'][number] = {
  city: null,
  companyId: '12345678',
  counterpartyId: 'c0000000-0000-4000-8000-000000000012',
  counterpartyRef: invoice.counterpartyRef,
  createdAt: '2026-10-01T08:00:00.000Z',
  displayName: 'Kavárna Dolce',
  email: null,
  partyId: 'c0000000-0000-4000-8000-000000000013',
  partyRef: {
    moduleId: 'party.registry',
    resourceId: 'c0000000-0000-4000-8000-000000000013',
    resourceType: 'party.registry.party',
    tenantId,
  },
  partyRevision: 1,
  phone: null,
  status: 'ACTIVE',
  vatId: null,
};

const withCustomer = (vm: FinanceViewModel): FinanceViewModel => ({
  ...vm,
  references: { ...vm.references, customers: [customer] },
});

const closes: boolean[] = [];
const onOpenChange = (open: boolean) => {
  closes.push(open);
};

beforeEach(() => {
  closes.length = 0;
});

const ZERO_PRICE = czech('finance-billing.faktury.form.zeroPriceConfirm');
const CREATE_FAILED = czech('finance-billing.faktury.form.createFailed');
const PENDING_APPROVAL = czech('finance-billing.demo.feedback.pendingApproval');

/** A view model whose `createDraft` records each draft and answers `outcome`. */
const draftVm = (drafts: DraftInvoiceInput[], outcome: () => DraftInvoiceOutcome): FinanceViewModel =>
  withCustomer({
    ...fakeVm([]),
    createDraft: (input: DraftInvoiceInput) =>
      Effect.sync(() => {
        drafts.push(input);
        return outcome();
      }),
    t: (key) => translations.t(key),
  });

const fillInvoice = (price: string) =>
  Effect.gen(function* fill() {
    yield* acted(() => {
      Option.getOrThrow(
        Option.fromNullOr(document.querySelector<HTMLInputElement>('[id="invoice-customer-input"]')),
      ).click();
    });
    yield* waitUntil(() => document.querySelector('[data-scope="combobox"][data-part="item"]') !== null);
    yield* acted(() => {
      Option.getOrThrow(
        Option.fromNullOr(document.querySelector<HTMLElement>('[data-scope="combobox"][data-part="item"]')),
      ).click();
    });
    yield* typeInto('invoice-line-description-line-1', 'Pronájem kavárny');
    yield* typeInto('invoice-line-price-line-1', price);
    yield* waitUntil(() => !saveButton().disabled);
  });

afterEach(() => {
  unmountAll();
});

describe('new invoice safeguards', () => {
  it.live('reads the required text of a required field in Czech', () =>
    Effect.gen(function* requiredText() {
      const drafts: DraftInvoiceInput[] = [];
      yield* mount(
        <CreateInvoiceDialog onOpenChange={onOpenChange} open vm={draftVm(drafts, () => ({ invoice, ok: true }))} />,
      );
      expect(text()).toContain(requiredLabelFor('cs'));
      expect(text()).not.toContain('(required)');
      const issueDateLabel = [...document.querySelectorAll('label')].find((label) =>
        label.textContent?.includes(czech('finance-billing.faktury.form.issueDate')),
      );
      expect(issueDateLabel?.textContent ?? '').toContain(requiredLabelFor('cs'));
    }).pipe(Effect.provide(network)),
  );

  it.live('a 0 Kč line needs a second Uložit: the first only warns, a changed line asks again', () =>
    Effect.gen(function* zeroPrice() {
      const drafts: DraftInvoiceInput[] = [];
      yield* mount(
        <CreateInvoiceDialog onOpenChange={onOpenChange} open vm={draftVm(drafts, () => ({ invoice, ok: true }))} />,
      );
      yield* fillInvoice('0');
      expect(text()).not.toContain(ZERO_PRICE);
      yield* clickSave;
      expect(drafts).toEqual([]);
      expect(text()).toContain(ZERO_PRICE);

      yield* typeInto('invoice-line-description-line-1', 'Dárek');
      expect(text()).not.toContain(ZERO_PRICE);
      yield* clickSave;
      expect(drafts).toEqual([]);
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(drafts).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('a failed create keeps the form and its input and shows the error toast', () =>
    Effect.gen(function* failed() {
      const drafts: DraftInvoiceInput[] = [];
      yield* mount(
        <CreateInvoiceDialog
          onOpenChange={onOpenChange}
          open
          vm={draftVm(drafts, () => ({ feedback: 'unavailable', ok: false }))}
        />,
      );
      yield* fillInvoice('1000');
      yield* clickSave;
      yield* waitUntil(() => visibleToasts().length === 1);
      expect(visibleToasts()[0]).toMatchObject({ title: CREATE_FAILED, type: 'error' });
      expect(closes).toEqual([]);
      expect(drafts).toHaveLength(1);
      yield* clickCancel;
      expect(leaveQuestion()).toBe(true);
    }).pipe(Effect.provide(network)),
  );

  it.live('a draft sent for approval announces it and closes the panel', () =>
    Effect.gen(function* proposed() {
      const drafts: DraftInvoiceInput[] = [];
      yield* mount(
        <CreateInvoiceDialog
          onOpenChange={onOpenChange}
          open
          vm={draftVm(drafts, () => ({ feedback: 'pendingApproval', ok: false }))}
        />,
      );
      yield* fillInvoice('1000');
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(closes).toEqual([false]);
      expect(visibleToasts()).toEqual([{ title: PENDING_APPROVAL, type: 'info' }]);
      expect(drafts).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );
});
