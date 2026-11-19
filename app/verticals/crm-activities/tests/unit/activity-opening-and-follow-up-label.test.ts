// @rstest-environment happy-dom
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { CounterpartiesProviderResponseSchema, CounterpartiesSearchApi } from '@app/party-registry/api';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { RecordsApi as TasksApi, RecordsResponseSchema as TasksResponse } from '@app/work-tasks/contracts/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Option, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { activities, followUpTasks, preloadPage, RecordsPage } from '../../src/routes/[lang]/aktivity/page.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const tenantId = '70000000-0000-4000-8000-000000000061';
const legalEntityId = '71000000-0000-4000-8000-000000000061';
const principalId = '72000000-0000-4000-8000-000000000061';
const resourceId = '73000000-0000-4000-8000-000000000061';
const props: ModulePageProps = {
  context: { legalEntityId, principalId, tenantId },
  routeParams: {},
  search: `?resourceId=${resourceId}`,
};
const actorPrincipalRef = { principalId, tenantId };
const activityResponse = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef,
  canWrite: true,
  items: [
    {
      contextRefs: [],
      createdAt: '2026-11-10T09:00:00Z',
      kind: 'CALL',
      occurredAt: '2026-11-10T09:00:00Z',
      ownerPrincipalRef: actorPrincipalRef,
      partyRef: {
        moduleId: 'party.registry',
        resourceId: '74000000-0000-4000-8000-000000000061',
        resourceType: 'party.registry.party',
        tenantId,
      },
      ref: { moduleId: 'crm.activities', resourceId, resourceType: 'crm.activities.activity', tenantId },
      summary: 'Domluvená prohlídka',
    },
  ],
  revision: 6,
});
const collection = {
  properties: {
    dueDate: { locked: true, type: 'DATE' },
    ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
    status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
    title: { locked: true, type: 'TEXT' },
  },
  ref: { moduleId: 'work.tasks', resourceId: 'default', resourceType: 'work.tasks.task-collection', tenantId },
  title: 'Úkoly',
};
const tasksResponse = Schema.decodeUnknownSync(TasksResponse)({
  actorPrincipalRef,
  assignablePrincipals: [],
  canWrite: true,
  collection,
  indicators: { open: 1, openByAssignee: [], overdue: 0 },
  items: [
    {
      collectionRef: collection.ref,
      contextRefs: [],
      createdAt: '2026-11-10T09:00:00Z',
      priority: 'NORMAL',
      ref: { moduleId: 'work.tasks', resourceId: 'task-456', resourceType: 'work.tasks.task', tenantId },
      state: 'NEW',
      title: 'Domluvit prohlídku Nájemparku',
      updatedAt: '2026-11-10T09:00:00Z',
    },
  ],
  principalNames: [],
  referenceDate: '2026-11-10',
  revision: 2,
});
const counterparties = Schema.decodeUnknownSync(CounterpartiesProviderResponseSchema)([
  {
    currentRoles: ['CUSTOMER'],
    legalEntity: { legalEntityId, tenantId },
    party: {
      archived: false,
      matchedViaAlias: false,
      ref: {
        moduleId: 'party.registry',
        resourceId: '74000000-0000-4000-8000-000000000061',
        resourceType: 'party.registry.party',
        tenantId,
      },
      title: 'Jiří Šťastný',
    },
    ref: {
      moduleId: 'party.registry',
      resourceId: '75000000-0000-4000-8000-000000000061',
      resourceType: 'party.registry.counterparty',
      tenantId,
    },
  },
]);
const reads: (typeof RecordsResponseSchema.Type | typeof TasksResponse.Type)[] = [];
const requests: RecordsRequest[] = [];
const Owner = RecordsApi.prefix('/crm-activities-api');
const Tasks = TasksApi.prefix('/work-tasks-api');
const Search = CounterpartiesSearchApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'crm-activities': '/crm-activities-api',
    'party-registry': '/party-registry-api',
    'work-tasks': '/work-tasks-api',
  }).application,
  serveApi(
    Owner,
    HttpApiBuilder.group(Owner, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          requests.push(payload);
          reads.push(activityResponse);
          return activityResponse;
        }),
      ),
    ),
  ),
  serveApi(
    Search,
    HttpApiBuilder.group(Search, 'counterpartiesSearch', (group) =>
      group.handle('execute', () => Effect.succeed(counterparties)),
    ),
  ),
  serveApi(
    Tasks,
    HttpApiBuilder.group(Tasks, 'records', (group) =>
      group.handle('execute', () =>
        Effect.sync(() => {
          reads.push(tasksResponse);
          return tasksResponse;
        }),
      ),
    ),
  ),
);

const comboboxNamed = (name: string) =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...document.querySelectorAll<HTMLElement>('[role="combobox"]')].find(
        (element) =>
          element
            .getAttribute('aria-labelledby')
            ?.split(/\s+/u)
            .map((id) => document.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim())
            .join(' ') === name,
      ),
    ),
  );
const optionNamed = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (element) => element.closest('[hidden]') === null && element.textContent?.trim() === name,
  );
const choose = (label: string, name: string) =>
  Effect.gen(function* chooseVisibleOption() {
    yield* acted(() => comboboxNamed(label).click());
    yield* waitUntil(() => optionNamed(name) !== undefined);
    yield* acted(() => Option.getOrThrow(Option.fromUndefinedOr(optionNamed(name))).click());
  });

const shown = (select: HTMLSelectElement) =>
  document
    .querySelector(`[role="combobox"][aria-labelledby="${select.getAttribute('aria-labelledby') ?? ''}"]`)
    ?.textContent?.trim();

afterEach(unmountAll);

it.live('opening an activity link preloads its records, leaving follow-up tasks until the form is shown', () =>
  Effect.gen(function* opensActivity() {
    yield* pinTestDocument;
    activities.invalidate();
    followUpTasks.invalidate();
    reads.length = 0;
    requests.length = 0;
    yield* Effect.promise(() => preloadPage(props));
    yield* networkIdle;
    expect(requests).toEqual([{ resourceId }]);
    expect(reads).toEqual([activityResponse]);
    expect(activities.snapshot({ legalEntityId, resourceId })).toMatchObject({
      refreshing: false,
      state: 'ready',
      value: {
        items: [{ ref: { resourceId }, summary: 'Domluvená prohlídka' }],
        revision: 6,
      },
    });
  }).pipe(Effect.provide(network)),
);

it.live(
  'a follow-up task keeps its Czech title in the native option and selected trigger without changing its ID',
  () =>
    Effect.gen(function* selectsFollowUp() {
      yield* pinTestDocument;
      activities.invalidate();
      followUpTasks.invalidate();
      yield* mountInRoute(createElement(RecordsPage, props), {
        path: 'aktivity',
        url: `/cs/aktivity?resourceId=${resourceId}`,
      });
      yield* waitUntil(() => [...document.querySelectorAll('option')].some((option) => option.value === 'task-456'));
      const option = Option.getOrThrow(
        Option.fromUndefinedOr([...document.querySelectorAll('option')].find((entry) => entry.value === 'task-456')),
      );
      expect(option.textContent).toBe('Domluvit prohlídku Nájemparku');
      const select = Option.getOrThrow(Option.fromNullOr(option.closest('select')));
      yield* choose(moduleText('cs')('crm-activities.pages.records.followUp'), 'Domluvit prohlídku Nájemparku');
      yield* waitUntil(() => select.value === 'task-456' && shown(select) === 'Domluvit prohlídku Nájemparku');
      expect(select.value).toBe('task-456');
      expect(shown(select)).toBe('Domluvit prohlídku Nájemparku');
    }).pipe(Effect.provide(network)),
);

it.live(
  'a contact keeps its Czech name in the native option and selected trigger without changing its reference ID',
  () =>
    Effect.gen(function* selectsContact() {
      yield* pinTestDocument;
      activities.invalidate();
      followUpTasks.invalidate();
      yield* mountInRoute(createElement(RecordsPage, props), {
        path: 'aktivity',
        url: `/cs/aktivity?resourceId=${resourceId}`,
      });
      yield* waitUntil(() => document.querySelector('#counterparty-query') !== null);
      const input = Option.getOrThrow(
        Option.fromNullOr(document.querySelector<HTMLInputElement>('#counterparty-query')),
      );
      yield* acted(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Šťastný');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const find = Option.getOrThrow(
        Option.fromUndefinedOr(buttons(moduleText('cs')('crm-activities.pages.records.find'))[0]),
      );
      yield* acted(() => find.click());
      const contactId = '75000000-0000-4000-8000-000000000061';
      yield* waitUntil(() => [...document.querySelectorAll('option')].some((option) => option.value === contactId));
      const option = Option.getOrThrow(
        Option.fromUndefinedOr([...document.querySelectorAll('option')].find((entry) => entry.value === contactId)),
      );
      expect(option.textContent).toBe('Jiří Šťastný');
      const select = Option.getOrThrow(Option.fromNullOr(option.closest('select')));
      yield* choose(moduleText('cs')('crm-activities.pages.records.contact'), 'Jiří Šťastný');
      yield* waitUntil(() => select.value === contactId && shown(select) === 'Jiří Šťastný');
      expect(select.value).toBe(contactId);
      expect(shown(select)).toBe('Jiří Šťastný');
    }).pipe(Effect.provide(network)),
);
