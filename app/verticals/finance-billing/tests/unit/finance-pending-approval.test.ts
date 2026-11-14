import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement, useState } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionProposalAcceptedSchema } from '../../shared/apis/apply-command-action.ts';
import { RecordsResponseSchema, RecurringTemplateSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { outcomeNotice } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import { recurringPanelGenerateProgram } from '../../src/routes/[lang]/finance/recurring-panel.tsx';
import { financePageScope } from '../../src/routes/[lang]/finance/finance-page-scope.ts';
import { preloadFinanceRecords, useFinanceRecords } from '../../src/routes/[lang]/finance/use-finance-records.ts';

/**
 * An owner command the policy parks for approval answers 202 `ActionProposalAccepted`: nothing was written. These
 * tests drive the real ledger hook (and the real recurring generation program) against a mocked command transport,
 * so the screen must report "waiting for approval" as information, never as a saved change or a failure, and must
 * not propose the same intent twice while it still waits. A genuinely new edit is still sent.
 */

const mocks = rstest.hoisted(() => ({
  apply: rstest.fn(),
  location: { search: {}, searchStr: '' },
  records: rstest.fn(),
  toast: rstest.fn(),
}));

rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: mocks.apply }));
rstest.mock('@techsio/ui-kit/molecules/toast', () => ({
  // The shared admin toaster configures the kit's singleton at import time; it only needs somewhere to write.
  toaster: { attrs: {} },
  useToast: () => ({ create: mocks.toast, dismiss: () => {} }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  // Finance reads the router only through a selector, so the mock answers with exactly what that selector returns.
  useRouterState: <Selected>(options: {
    readonly select: (state: { readonly location: typeof mocks.location }) => Selected;
  }): Selected => options.select({ location: mocks.location }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({
    language: 'cs',
    t: (key: string, _options?: Readonly<Record<string, string | number>>) => key,
  }),
}));
// The store is deliberately browser-gated; in the node test the render reads the current entry directly.
rstest.mock('react', () => ({
  ...rstest.requireActual('react'),
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));

/** What the recurring generation program reports to its panel. */
type GenerationUpdate = Parameters<Parameters<typeof recurringPanelGenerateProgram>[0]['setResult']>[0];

const pendingKey = 'finance-billing.demo.feedback.pendingApproval';
const tenantId = 'a0000000-0000-4000-8000-000000000001';

const ledger = Schema.decodeSync(RecordsResponseSchema)({
  businessDate: '2026-10-05',
  canWrite: true,
  indicators: {
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
  },
  referenceDate: '2026-10-05',
  revision: 7,
  state: { financialPlanEntries: [], invoices: [] },
}) satisfies RecordsResponse;

const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2099-01-01T00:00:00Z',
  proposalId: 'f0000000-0000-4000-8000-000000000501',
});
const committed = { changed: true, revision: 8 };

const priceItem = (unitPriceMinor: number) => ({
  _tag: 'UpsertPriceListItem' as const,
  active: true,
  name: 'Úklid společných prostor',
  unitPriceMinor,
  vatRate: 21 as const,
});

const template = Schema.decodeUnknownSync(RecurringTemplateSchema)({
  active: true,
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'e0000000-0000-4000-8000-000000000401',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: '2026-10-01T08:00:00Z',
  dueDays: 14,
  id: 'template-rent',
  issueDay: 1,
  lines: [{ description: 'Nájem', quantity: 1, unitPriceMinor: 2_500_000, vatRate: 21 }],
  name: 'Nájem kancelář',
});

/** Two verified Shell contexts that see the same ledger revision; the commands below name nothing scope-specific. */
const companyContext = {
  legalEntityId: 'b0000000-0000-4000-8000-000000000011',
  principalId: 'principal-accountant',
  tenantId,
};
const otherCompanyContext = { ...companyContext, legalEntityId: 'b0000000-0000-4000-8000-000000000012' };
const companyScope = financePageScope(companyContext);
const otherCompanyScope = financePageScope(otherCompanyContext);

const rendered: ReturnType<typeof useFinanceRecords>[] = [];
const Harness = () => {
  rendered.push(useFinanceRecords({ scope: companyScope }));
  return null;
};
const renderVm = () => {
  rendered.length = 0;
  renderToStaticMarkup(createElement(Harness));
  const vm = rendered.at(-1);
  if (vm === undefined) {
    throw new Error('the finance ledger hook did not render');
  }
  return vm;
};

const preparedVm = (partyId: string) =>
  Effect.gen(function* prepared() {
    mocks.location.search = { partyId };
    mocks.records.mockReturnValue(Effect.succeed(ledger));
    yield* preloadFinanceRecords(`?partyId=${partyId}`, companyContext);
    return renderVm();
  });

/**
 * One mounted hook whose Shell scope changes: the render-phase update re-runs the same component instance, so its
 * hook state (the remembered proposals) persists while the scope switches, as a live page switching company would.
 */
const scopedRendered: ReturnType<typeof useFinanceRecords>[] = [];
const ScopeSwitchHarness = () => {
  const [scope, setScope] = useState(companyScope);
  scopedRendered.push(useFinanceRecords({ scope }));
  if (scope === companyScope) {
    setScope(otherCompanyScope);
  }
  return null;
};

/** The toasts the hook raised, read through the shape it passes to the toaster. */
const ToastCallsSchema = Schema.Array(Schema.Tuple([Schema.Struct({ type: Schema.optional(Schema.String) })]));
const toastTypes = () =>
  Schema.decodeUnknownSync(ToastCallsSchema)(mocks.toast.mock.calls).map(([toast]) => toast.type);

describe('finance commands parked for approval', () => {
  beforeEach(() => {
    rstest.stubGlobal('document', {});
    rstest.stubGlobal('addEventListener', () => {});
    rstest.stubGlobal('removeEventListener', () => {});
    rstest.stubGlobal('dispatchEvent', () => true);
    rstest.stubGlobal('React', rstest.requireActual('react'));
  });

  afterEach(() => {
    mocks.apply.mockReset();
    mocks.records.mockReset();
    mocks.toast.mockReset();
  });

  it.live('reports a parked command as pending approval and never re-proposes the same intent', () =>
    Effect.gen(function* parked() {
      const vm = yield* preparedVm('pending-approval-dedupe');
      const readsBefore = mocks.records.mock.calls.length;
      mocks.apply.mockReturnValue(Effect.succeed(proposal));

      const first = yield* vm.execute(priceItem(150_000), 'Položka ceníku přidána');
      expect(first).toEqual({ feedback: 'pendingApproval', ok: false });
      // An informational toast, not the saved-success one, and no ledger reload for a write that did not happen.
      expect(toastTypes()).toEqual(['info']);
      expect(mocks.toast.mock.calls[0]?.[0]).toEqual({ title: pendingKey, type: 'info' });
      expect(mocks.records.mock.calls.length).toBe(readsBefore);

      const repeated = yield* vm.execute(priceItem(150_000), 'Položka ceníku přidána');
      expect(repeated).toEqual({ feedback: 'pendingApproval', ok: false });
      expect(mocks.apply).toHaveBeenCalledTimes(1);

      // A different edit is a new intent and is sent.
      mocks.apply.mockReturnValue(Effect.succeed(committed));
      const edited = yield* vm.execute(priceItem(160_000), 'Položka ceníku přidána');
      expect(edited).toEqual({ ok: true });
      expect(mocks.apply).toHaveBeenCalledTimes(2);
      expect(toastTypes()).toEqual(['info', 'info', 'success']);
    }),
  );

  it.live('does not let another scope reuse a proposal with the same revision and command', () =>
    Effect.gen(function* switched() {
      expect(companyScope).toBeDefined();
      expect(otherCompanyScope).not.toBe(companyScope);
      mocks.location.search = { partyId: 'pending-approval-scope' };
      mocks.records.mockReturnValue(Effect.succeed(ledger));
      yield* preloadFinanceRecords('?partyId=pending-approval-scope', companyContext);
      yield* preloadFinanceRecords('?partyId=pending-approval-scope', otherCompanyContext);
      scopedRendered.length = 0;
      renderToStaticMarkup(createElement(ScopeSwitchHarness));
      const [inCompany, inOtherCompany] = [scopedRendered[0], scopedRendered.at(-1)];
      if (inCompany === undefined || inOtherCompany === undefined || inCompany === inOtherCompany) {
        throw new Error('the scope switch did not re-render the finance hook');
      }
      expect(inCompany.snapshot?.revision).toBe(inOtherCompany.snapshot?.revision);
      mocks.apply.mockReturnValue(Effect.succeed(proposal));

      expect(yield* inCompany.execute(priceItem(150_000))).toEqual({ feedback: 'pendingApproval', ok: false });
      expect(mocks.apply).toHaveBeenCalledTimes(1);

      // The other company's identical intent is its own proposal, sent once and then suppressed in that scope.
      expect(yield* inOtherCompany.execute(priceItem(150_000))).toEqual({ feedback: 'pendingApproval', ok: false });
      expect(mocks.apply).toHaveBeenCalledTimes(2);
      expect(yield* inOtherCompany.execute(priceItem(150_000))).toEqual({ feedback: 'pendingApproval', ok: false });
      expect(mocks.apply).toHaveBeenCalledTimes(2);
    }),
  );

  it.live('keeps a genuine direct write a success that refreshes the ledger', () =>
    Effect.gen(function* direct() {
      const vm = yield* preparedVm('pending-approval-direct');
      const readsBefore = mocks.records.mock.calls.length;
      mocks.apply.mockReturnValue(Effect.succeed(committed));

      const outcome = yield* vm.execute(priceItem(150_000), 'Položka ceníku přidána');
      expect(outcome).toEqual({ ok: true });
      expect(toastTypes()).toEqual(['success']);
      expect(mocks.records.mock.calls.length).toBe(readsBefore + 1);
    }),
  );

  it.live('shows a parked outcome as neutral information and a refusal as an error', () =>
    Effect.gen(function* notices() {
      const vm = yield* preparedVm('pending-approval-notice');
      expect(outcomeNotice(vm, { feedback: 'pendingApproval', ok: false })).toEqual({
        status: 'default',
        text: pendingKey,
      });
      expect(outcomeNotice(vm, { feedback: 'forbidden', ok: false })).toEqual({
        status: 'error',
        text: 'finance-billing.demo.feedback.forbidden',
      });
    }),
  );

  it.live('lists a parked recurring invoice as pending, not as a failed template', () =>
    Effect.gen(function* recurring() {
      const vm = yield* preparedVm('pending-approval-recurring');
      mocks.apply.mockReturnValue(Effect.succeed(proposal));
      const results: GenerationUpdate[] = [];
      const context = {
        period: '2026-12',
        setDuplicateTarget: () => {},
        setResult: (next: GenerationUpdate) => {
          results.push(next);
        },
        setRunning: () => {},
        vm,
      };

      yield* recurringPanelGenerateProgram(context, [template]);
      expect(results).toEqual([{ created: [], duplicates: [], failed: [], pending: ['Nájem kancelář'] }]);

      // Running the same period again does not send a second proposal for the approver.
      yield* recurringPanelGenerateProgram(context, [template]);
      expect(mocks.apply).toHaveBeenCalledTimes(1);
      expect(results.at(-1)).toEqual({ created: [], duplicates: [], failed: [], pending: ['Nájem kancelář'] });
    }),
  );
});
