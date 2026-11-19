// @rstest-environment happy-dom
import { makeModuleUi, unmountAll } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import {
  RecordsApi as OpportunityApi,
  RecordsResponseSchema as OpportunityResponse,
} from '@app/sales-pipeline/contracts/records';
import {
  RecordsApi as FinanceApi,
  RecordsResponseSchema as FinanceResponse,
} from '@app/finance-billing/contracts/records';
import { RecordsApi as TaskApi, RecordsResponseSchema as TaskResponse } from '@app/work-tasks/contracts/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { FederatedI18nBoundary } from '@modern-js/i18n-integration/federation';
import { I18nNavigationProvider } from '@modern-js/plugin-i18n/runtime';
import { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import { RuntimeComponentResolverContext } from '@modern-js/runtime/context';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import Dashboard, { preloadPage } from '../../src/components/crm-dashboard.tsx';
import { dashboardData } from '../../src/dashboard/dashboard-data.ts';
import runtimeConfig from '../../src/modern.runtime.ts';

const { mountInRoute } = makeModuleUi({
  FederatedI18nBoundary,
  I18nNavigationProvider,
  ModernI18nProvider,
  RuntimeComponentResolverContext,
  runtimeConfig,
});
const actorPrincipalRef = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const opportunities = Schema.decodeUnknownSync(OpportunityResponse)({
  actorPrincipalRef,
  canWrite: true,
  indicators: {
    byStage: [],
    lostCount: 0,
    openCount: 0,
    openValueMinor: 0,
    weightedValueMinor: 0,
    winRate: null,
    wonCount: 0,
    wonValueMinor: 0,
  },
  items: [],
  revision: 17,
});
const finance = Schema.decodeUnknownSync(FinanceResponse)({
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
  revision: 2,
  state: { financialPlanEntries: [], invoices: [], priceList: [] },
});
const tasks = Schema.decodeUnknownSync(TaskResponse)({
  actorPrincipalRef,
  assignablePrincipals: [],
  canWrite: true,
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: {
      moduleId: 'work.tasks',
      resourceId: 'default',
      resourceType: 'work.tasks.task-collection',
      tenantId: actorPrincipalRef.tenantId,
    },
    title: 'Tasks',
  },
  indicators: { open: 0, openByAssignee: [], overdue: 0 },
  items: [],
  lookupAccess: { contracts: 'denied', customers: 'denied', opportunities: 'denied', properties: 'denied' },
  principalNames: [],
  referenceDate: '2026-11-04',
  revision: 1,
});
const OpportunityOwner = OpportunityApi.prefix('/sales-pipeline-api');
const FinanceOwner = FinanceApi.prefix('/finance-billing-api');
const TaskOwner = TaskApi.prefix('/work-tasks-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'finance-billing': '/finance-billing-api',
    'sales-pipeline': '/sales-pipeline-api',
    'work-tasks': '/work-tasks-api',
  }).application,
  serveApi(
    OpportunityOwner,
    HttpApiBuilder.group(OpportunityOwner, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(opportunities)),
    ),
  ),
  serveApi(
    FinanceOwner,
    HttpApiBuilder.group(FinanceOwner, 'records', (group) => group.handle('execute', () => Effect.succeed(finance))),
  ),
  serveApi(
    TaskOwner,
    HttpApiBuilder.group(TaskOwner, 'records', (group) => group.handle('execute', () => Effect.succeed(tasks))),
  ),
);

afterEach(unmountAll);

it.live('Home prepares the selected company and renders real links to each metric owner', () =>
  Effect.gen(function* preparedCompanyDashboard() {
    yield* pinTestDocument;
    const props = {
      context: {
        legalEntityId: 'home-prepared-company',
        principalId: actorPrincipalRef.principalId,
        tenantId: actorPrincipalRef.tenantId,
      },
      routeParams: {},
      search: '',
    };
    yield* Effect.promise(() => preloadPage(props));
    const snapshot = dashboardData.snapshot({ legalEntityId: 'home-prepared-company' });
    expect(snapshot).toMatchObject({
      state: 'ready',
      value: expect.arrayContaining([
        { href: '/finance', id: 'unpaid_amount', source: 'invoices', state: 'empty', unit: 'CZK', value: 0 },
      ]),
    });
    expect(dashboardData.snapshot({ legalEntityId: 'not-prepared-company' }).state).toBe('pending');
    yield* mountInRoute(createElement(Dashboard, props), { path: 'home', url: '/cs/home' });
    const links = [...document.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(links).toEqual([
      '/cs/prodej/prilezitosti',
      '/cs/prodej/prilezitosti',
      '/cs/finance',
      '/cs/ukoly',
      '/cs/ukoly',
    ]);
  }).pipe(Effect.provide(network)),
);
