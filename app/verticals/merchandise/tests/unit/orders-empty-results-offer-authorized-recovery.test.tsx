// @rstest-environment happy-dom
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { partyRegistryApi } from '@app/party-registry/api';
import {
  RecordsApi as TagRecordsApi,
  RecordsResponseSchema as TagRecordsResponseSchema,
} from '@app/tagging/contracts/records';
import { pageDataScopeKey } from '@app/shared-contracts/page-data';
import { HttpApi, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { act } from 'react';
import { createRequire } from 'node:module';
import {
  RecordsApi,
  RecordsResponseSchema,
  RecordsForbiddenProblemSchema,
  RecordsUnavailableProblemSchema,
} from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { OrdersPage } from '../../src/routes/[lang]/prodej/objednavky/page.tsx';
import {
  firstOrdersPage,
  orderCountsData,
  orderDetailData,
  ordersPageData,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import { customerDirectoryData } from '../../src/routes/[lang]/prodej/objednavky/customers-directory.ts';
import { mountInRoute, moduleText } from '../support/module-ui.ts';
import csResource from '../../locales/cs/merchandise.json';
import enResource from '../../locales/en/merchandise.json';

const { default: userEvent } = createRequire(new URL('../../../../apps/shell-super-app/package.json', import.meta.url))(
  '@testing-library/user-event',
);

const resources = { cs: { merchandise: csResource }, en: { merchandise: enResource } };
const t = moduleText('en', resources);
const label = (key: string) => t(`merchandise.pages.orders.${key}`);
const context = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const records = (canEditOrders: boolean) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canEditOrders,
    canWrite: canEditOrders,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
    movements: [],
    orders: [],
    products: [],
    revision: 7,
    totalOrders: 0,
  });
const denied = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});
const unavailable = Schema.decodeSync(RecordsUnavailableProblemSchema)({
  _tag: 'RecordsUnavailableProblem',
  detail: 'Try again',
  retryable: true,
  status: 503,
  title: 'Unavailable',
  type: 'urn:test:unavailable',
});
let answer: Effect.Effect<RecordsResponse, typeof denied | typeof unavailable> = Effect.succeed(records(false));
const listReads: NonNullable<RecordsRequest['view']>[] = [];
const MerchApi = RecordsApi.prefix('/merchandise-api');
const CustomersApi = HttpApi.make('CustomerListApi')
  .add(partyRegistryApi.groups.customerList)
  .prefix('/party-registry-api');
const TagsApi = TagRecordsApi.prefix('/tagging-api');
const network = browserNetwork(
  shellGatewayIssuer({
    merchandise: '/merchandise-api',
    'party-registry': '/party-registry-api',
    tagging: '/tagging-api',
  }).application,
  serveApi(
    MerchApi,
    HttpApiBuilder.group(MerchApi, 'records', (group) =>
      group.handle('execute', ({ payload: { view } }) =>
        Effect.suspend(() => {
          if (view !== undefined && view.ordersLimit !== 0) {
            listReads.push(view);
          }
          return answer;
        }),
      ),
    ),
  ),
  serveApi(
    CustomersApi,
    HttpApiBuilder.group(CustomersApi, 'customerList', (group) =>
      group.handle('execute', () => Effect.succeed({ items: [] })),
    ),
  ),
  serveApi(
    TagsApi,
    HttpApiBuilder.group(TagsApi, 'records', (group) =>
      group.handle('execute', () =>
        Effect.succeed(
          Schema.decodeSync(TagRecordsResponseSchema)({
            assignments: [],
            canWrite: false,
            indicators: { assignmentCount: 0, tagCount: 0 },
            revision: 1,
            tags: [
              {
                color: 'red',
                counts: { customer: 0, employee: 0, opportunity: 0, order: 0, product: 0 },
                createdAt: '2026-10-15T10:00:00Z',
                id: 'priority',
                name: 'Priority',
                subjectKinds: ['order'],
                updatedAt: '2026-10-15T10:00:00Z',
              },
            ],
          }),
        ),
      ),
    ),
  ),
);
const open = Effect.gen(function* openPage() {
  yield* pinTestDocument;
  yield* mountInRoute(<OrdersPage context={context} />, {
    language: 'en',
    path: '/prodej/objednavky',
    resources,
    url: '/en/prodej/objednavky',
  });
  yield* networkIdle;
});
beforeEach(() => {
  ordersPageData.invalidate();
  orderCountsData.invalidate();
  orderDetailData.invalidate();
  customerDirectoryData.invalidate();
  answer = Effect.succeed(records(false));
  listReads.length = 0;
});
afterEach(unmountAll);
it.live('an order read failure offers retry and retry replaces it with the first-order empty state', () =>
  Effect.gen(function* retry() {
    answer = Effect.fail(unavailable);
    yield* open;
    expect(text()).toContain(label('states.errorTitle'));
    answer = Effect.succeed(records(false));
    yield* acted(() => buttons(label('states.retry'))[0]?.click());
    yield* networkIdle;
    yield* waitUntil(() => text().includes(label('states.firstTitle')));
    expect(text()).not.toContain(label('states.errorTitle'));
  }).pipe(Effect.provide(network)),
);
it.live('a denied order read displays access denial rather than a first-order creation prompt', () =>
  Effect.gen(function* forbidden() {
    answer = Effect.fail(denied);
    yield* open;
    expect(text()).toContain(label('states.forbiddenTitle'));
    expect(text()).not.toContain(label('states.firstTitle'));
    expect(buttons(label('create.title'))).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);
it.live('a filtered empty order list clears the search and returns to the first-order empty state', () =>
  Effect.gen(function* clearFilters() {
    yield* open;
    const search = document.querySelector('input');
    expect(search).not.toBeNull();
    if (search === null) {
      throw new Error('Orders search input missing');
    }
    yield* acted(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'No matching order');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    yield* waitUntil(() => text().includes(label('states.filteredTitle')));
    yield* networkIdle;
    yield* acted(() => buttons(label('states.clearFilters'))[0]?.click());
    yield* waitUntil(() => text().includes(label('states.firstTitle')));
    yield* networkIdle;
    expect(search.value).toBe('');
    expect(text()).not.toContain(label('states.filteredTitle'));
  }).pipe(Effect.provide(network)),
);
it.live('a first-order empty state hides creation from read-only staff', () =>
  Effect.gen(function* readOnly() {
    yield* open;
    expect(text()).toContain(label('states.firstTitle'));
    expect(buttons(label('create.title'))).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);
it.live('a first-order empty state lets authorized staff open order creation', () =>
  Effect.gen(function* create() {
    answer = Effect.succeed(records(true));
    yield* open;
    expect(text()).toContain(label('states.firstTitle'));
    const createButton = buttons(label('create.title')).at(-1);
    expect(createButton).toBeDefined();
    yield* acted(() => createButton?.click());
    yield* networkIdle;
    yield* waitUntil(() => document.querySelector('[role="dialog"]') !== null);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(label('create.description'));
  }).pipe(Effect.provide(network)),
);

it.live('clearing empty-order filters resets the selected status and tag and restores the unfiltered state', () =>
  Effect.gen(function* clearStatusAndTag() {
    answer = Effect.succeed(records(true));
    yield* open;
    const select = document.querySelector('select[name="statusFilter"]');
    const trigger = select?.parentElement?.querySelector<HTMLButtonElement>('[data-part="trigger"]');
    expect(trigger).toBeDefined();
    yield* acted(() => trigger?.click());
    yield* waitUntil(() => document.querySelector('[role="option"][data-value="NEW"]') !== null);
    yield* acted(() => document.querySelector<HTMLElement>('[role="option"][data-value="NEW"]')?.click());
    yield* networkIdle;
    const tag = document.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(tag).not.toBeNull();
    const user = userEvent.setup();
    const tagTrigger = document.querySelector<HTMLButtonElement>('[data-scope="combobox"][data-part="trigger"]');
    if (tagTrigger === null) {
      throw new Error('Tag filter trigger missing');
    }
    yield* Effect.promise(() => act(() => user.click(tagTrigger)));
    yield* waitUntil(() => document.querySelector('[role="option"][data-value="priority"]') !== null);
    const priority = document.querySelector<HTMLElement>('[role="option"][data-value="priority"]');
    if (priority === null) {
      throw new Error('Priority tag option missing');
    }
    yield* Effect.promise(() => act(() => user.click(priority)));
    yield* waitUntil(() => document.querySelector<HTMLInputElement>('input[role="combobox"]')?.value === 'Priority');
    yield* networkIdle;
    expect(listReads.at(-1)?.orderStatus).toBe('NEW');
    expect(document.querySelector<HTMLInputElement>('input[role="combobox"]')?.value).toBe('Priority');
    expect(text()).toContain(label('states.filteredTitle'));
    listReads.length = 0;
    yield* acted(() => buttons(label('states.clearFilters'))[0]?.click());
    yield* networkIdle;
    yield* waitUntil(() => text().includes(label('states.firstTitle')));
    yield* networkIdle;
    expect(document.querySelector<HTMLSelectElement>('select[name="statusFilter"]')?.value).toBe('__all__');
    expect(document.querySelector<HTMLInputElement>('input[role="combobox"]')?.value).not.toBe('Priority');
    const unfiltered = ordersPageData.snapshot({
      legalEntityId: context.legalEntityId,
      query: firstOrdersPage(50),
      scope: pageDataScopeKey(context, 'demo.merchandise'),
    });
    expect(unfiltered.state).toBe('ready');
    expect(listReads.every((view) => view.orderStatus === undefined && view.taggedOrderIds === undefined)).toBe(true);
    expect(text()).toContain(label('states.firstTitle'));
  }).pipe(Effect.provide(network)),
);
