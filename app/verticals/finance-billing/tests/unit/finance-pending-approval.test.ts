// @rstest-environment happy-dom
import { Toaster } from '@app/admin-ui';
import { settle, unmountAll } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpRouter, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { Effect, Layer, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { act, createElement } from 'react';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { ActionProposalAcceptedSchema, ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema, RecurringTemplateSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { outcomeNotice } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import { recurringPanelGenerateProgram } from '../../src/routes/[lang]/finance/recurring-panel.tsx';
import { financePageScope } from '../../src/routes/[lang]/finance/finance-page-scope.ts';
import { preloadFinanceRecords, useFinanceRecords } from '../../src/routes/[lang]/finance/use-finance-records.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

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
const committed = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ changed: true, revision: 8 });

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

// Requests reach the real generated clients and both owner HttpApi codecs.
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
const reads: RecordsRequest[] = [];
let answer: typeof proposal | typeof committed = proposal;
const OwnerActions = ApplyCommandActionApi.prefix('/finance-billing-api');
const OwnerRecords = RecordsApi.prefix('/finance-billing-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'finance-billing': '/finance-billing-api' }).application,
  HttpRouter.add(
    'GET',
    '/shell-super-app-api/auth/session',
    HttpServerResponse.json({ identity: { displayName: 'Accountant' } }).pipe(Effect.orDie),
  ),
  serveApi(
    OwnerActions,
    HttpApiBuilder.group(OwnerActions, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return answer;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecords,
    HttpApiBuilder.group(OwnerRecords, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return ledger;
        }),
      ),
    ),
  ),
);

const rendered: ReturnType<typeof useFinanceRecords>[] = [];
const Harness = ({ scope = companyScope }: { readonly scope?: string | undefined }) => {
  rendered.push(useFinanceRecords({ scope }));
  return createElement(Toaster);
};
const current = () => {
  const vm = rendered.at(-1);
  if (vm === undefined) {
    throw new Error('the finance ledger hook did not render');
  }
  return vm;
};
const preparedVm = (partyId: string) =>
  Effect.gen(function* prepared() {
    yield* pinTestDocument;
    yield* preloadFinanceRecords(`?partyId=${partyId}`, companyContext);
    yield* mountInRoute(createElement(Harness), { path: 'finance', url: `/cs/finance?partyId=${partyId}` });
    return current();
  });

// Flush command state changes and the real toaster before observing feedback in the DOM.
const perform = <A>(program: Effect.Effect<A>) => program.pipe(Effect.tap(() => settle));
const toastTitles = () => [...document.querySelectorAll<HTMLElement>('[data-scope="toast"][data-part="title"]')];
// The toaster renders newest first; the baseline asserts the feedback's creation order.
const toastTypes = () =>
  toastTitles()
    .toReversed()
    .map((title) => title.dataset['type']);
const copy = moduleText('cs');

it.layer(network, { excludeTestServices: true })('finance commands parked for approval', (suite) => {
  beforeEach(() => {
    commands.length = 0;
    reads.length = 0;
    rendered.length = 0;
    answer = proposal;
  });
  afterEach(() => {
    act(() => {
      toaster.remove();
    });
    unmountAll();
  });

  suite.effect('reports a parked command as pending approval and never re-proposes the same intent', () =>
    Effect.gen(function* parked() {
      const vm = yield* preparedVm('pending-approval-dedupe');
      const readsBefore = reads.length;
      answer = proposal;

      const first = yield* perform(vm.execute(priceItem(150_000), 'Položka ceníku přidána'));
      expect(first).toEqual({ feedback: 'pendingApproval', ok: false });
      // An informational toast, not the saved-success one, and no ledger reload for a write that did not happen.
      expect(toastTypes()).toEqual(['info']);
      expect(toastTitles().map((title) => ({ title: title.textContent, type: title.dataset['type'] }))).toEqual([
        { title: copy(pendingKey), type: 'info' },
      ]);
      expect(reads.length).toBe(readsBefore);

      const repeated = yield* perform(vm.execute(priceItem(150_000), 'Položka ceníku přidána'));
      expect(repeated).toEqual({ feedback: 'pendingApproval', ok: false });
      expect(commands).toHaveLength(1);

      // A different edit is a new intent and is sent.
      answer = committed;
      const edited = yield* perform(vm.execute(priceItem(160_000), 'Položka ceníku přidána'));
      expect(edited).toEqual({ ok: true });
      expect(commands).toHaveLength(2);
      expect(toastTypes()).toEqual(['info', 'info', 'success']);
    }),
  );

  suite.effect('does not let another scope reuse a proposal with the same revision and command', () =>
    Effect.gen(function* switched() {
      expect(companyScope).toBeDefined();
      expect(otherCompanyScope).not.toBe(companyScope);
      yield* pinTestDocument;
      yield* preloadFinanceRecords('?partyId=pending-approval-scope', companyContext);
      yield* preloadFinanceRecords('?partyId=pending-approval-scope', otherCompanyContext);
      const mounted = yield* mountInRoute(createElement(Harness), {
        path: 'finance',
        url: '/cs/finance?partyId=pending-approval-scope',
      });
      const inCompany = current();
      yield* mounted.rerender(createElement(Harness, { scope: otherCompanyScope }));
      const inOtherCompany = current();
      expect(inOtherCompany).not.toBe(inCompany);
      expect(inCompany.snapshot?.revision).toBe(inOtherCompany.snapshot?.revision);
      answer = proposal;

      expect(yield* perform(inCompany.execute(priceItem(150_000)))).toEqual({ feedback: 'pendingApproval', ok: false });
      expect(commands).toHaveLength(1);

      // The other company's identical intent is its own proposal, sent once and then suppressed in that scope.
      expect(yield* perform(inOtherCompany.execute(priceItem(150_000)))).toEqual({
        feedback: 'pendingApproval',
        ok: false,
      });
      expect(commands).toHaveLength(2);
      expect(yield* perform(inOtherCompany.execute(priceItem(150_000)))).toEqual({
        feedback: 'pendingApproval',
        ok: false,
      });
      expect(commands).toHaveLength(2);
    }),
  );

  suite.effect('keeps a genuine direct write a success that refreshes the ledger', () =>
    Effect.gen(function* direct() {
      const vm = yield* preparedVm('pending-approval-direct');
      const readsBefore = reads.length;
      answer = committed;

      const outcome = yield* perform(vm.execute(priceItem(150_000), 'Položka ceníku přidána'));
      expect(outcome).toEqual({ ok: true });
      expect(toastTypes()).toEqual(['success']);
      expect(reads.length).toBe(readsBefore + 1);
    }),
  );

  suite.effect('shows a parked outcome as neutral information and a refusal as an error', () =>
    Effect.gen(function* notices() {
      const vm = yield* preparedVm('pending-approval-notice');
      expect(outcomeNotice(vm, { feedback: 'pendingApproval', ok: false })).toEqual({
        status: 'default',
        text: copy(pendingKey),
      });
      expect(outcomeNotice(vm, { feedback: 'forbidden', ok: false })).toEqual({
        status: 'error',
        text: copy('finance-billing.demo.feedback.forbidden'),
      });
    }),
  );

  suite.effect('lists a parked recurring invoice as pending, not as a failed template', () =>
    Effect.gen(function* recurring() {
      const vm = yield* preparedVm('pending-approval-recurring');
      answer = proposal;
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

      yield* perform(recurringPanelGenerateProgram(context, [template]));
      expect(results).toEqual([{ created: [], duplicates: [], failed: [], pending: ['Nájem kancelář'] }]);

      // Running the same period again does not send a second proposal for the approver.
      yield* perform(recurringPanelGenerateProgram(context, [template]));
      expect(commands).toHaveLength(1);
      expect(results.at(-1)).toEqual({ created: [], duplicates: [], failed: [], pending: ['Nájem kancelář'] });
    }),
  );
});
