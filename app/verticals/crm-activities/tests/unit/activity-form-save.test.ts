// @rstest-environment happy-dom
// The activity form owns the contact the user chose. A later search only offers other contacts: whether it omits the
// chosen one, finds nobody or fails for now, the choice stays chosen and labelled in the real picker, Uložit stays
// enabled, and the save sends the chosen contact's full reference. A newer name of the chosen contact replaces the kept
// one. When the directory refuses the user, nothing it returned stays chosen or on offer. The picker's own clear action
// drops the contact and keeps the rest of the form. Before a contact and a summary exist, Uložit is held back. The real
// page, picker, router and i18n run; the owner's Records and Action, Work Tasks Records and the Party Registry
// counterparty search answer in process through their HttpApi contracts behind the Shell's gateway issuer.
import { acted, buttons, settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  CounterpartiesProviderForbiddenProblemSchema,
  CounterpartiesProviderResponseSchema,
  CounterpartiesProviderUnavailableProblemSchema,
  CounterpartiesSearchApi,
} from '@app/party-registry/api';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import {
  RecordsApi as WorkRecordsApi,
  RecordsResponseSchema as WorkRecordsResponseSchema,
} from '@app/work-tasks/contracts/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Layer, Match, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import csResource from '../../locales/cs/crm-activities.json';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { RecordsPage } from '../../src/routes/[lang]/aktivity/page.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const legalEntityId = '71000000-0000-4000-8000-000000000020';
const principalId = '72000000-0000-4000-8000-000000000021';
const props: ModulePageProps = { context: { legalEntityId, principalId, tenantId }, routeParams: {}, search: '' };
const key = 'crm-activities.pages.records';
const copy = moduleText('cs', { cs: { 'crm-activities': csResource } });

const contact = (title: string, partyId: string, counterpartyId: string) => ({
  currentRoles: ['CUSTOMER'],
  legalEntity: { legalEntityId, tenantId },
  party: {
    archived: false,
    matchedViaAlias: false,
    ref: { moduleId: 'party.registry', resourceId: partyId, resourceType: 'party.registry.party', tenantId },
    title,
  },
  ref: {
    moduleId: 'party.registry',
    resourceId: counterpartyId,
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
});
const [dolce, novak, dolceRenamed] = Schema.decodeUnknownSync(CounterpartiesProviderResponseSchema)([
  contact('Kavárna Dolce', '44440000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444'),
  contact('Pekárna Novák', '55550000-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555'),
  contact('Kavárna Dolce Vita', '44440000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444'),
]).map((row) => row);
const kept = Option.getOrThrow(Option.fromUndefinedOr(dolce));
const other = Option.getOrThrow(Option.fromUndefinedOr(novak));
/** Dolce under the newer name a later search returns: the same contact. */
const renamed = Option.getOrThrow(Option.fromUndefinedOr(dolceRenamed));

const actorPrincipalRef = { principalId, tenantId };
const activityRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef,
  canWrite: true,
  items: [],
  revision: 3,
});
const workRecords = Schema.decodeUnknownSync(WorkRecordsResponseSchema)({
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
    ref: { moduleId: 'work.tasks', resourceId: 'default', resourceType: 'work.tasks.task-collection', tenantId },
    title: 'Úkoly',
  },
  indicators: { open: 0, openByAssignee: [], overdue: 0 },
  items: [],
  principalNames: [],
  referenceDate: '2026-11-04',
  revision: 1,
});
const recorded = Schema.decodeUnknownSync(ApplyCommandResultSchema)({
  activity: {
    contextRefs: [],
    counterpartyRef: Schema.encodeSync(CounterpartiesProviderResponseSchema)([kept])[0]?.ref,
    createdAt: '2026-10-05T10:00:00Z',
    kind: 'CALL',
    occurredAt: '2026-10-05T10:00:00Z',
    ownerPrincipalRef: actorPrincipalRef,
    ref: {
      moduleId: 'crm.activities',
      resourceId: '66666666-6666-4666-8666-666666666666',
      resourceType: 'crm.activities.activity',
      tenantId,
    },
    summary: 'Domluvená ochutnávka',
  },
  revision: 4,
});
const unavailable = CounterpartiesProviderUnavailableProblemSchema.make({
  detail: 'The counterparty search is unavailable.',
  retryable: true,
  status: 503,
  title: 'Search unavailable',
  type: 'https://ontos.dev/problems/search-unavailable',
});

const forbidden = CounterpartiesProviderForbiddenProblemSchema.make({
  detail: 'The counterparty search is not allowed for this principal.',
  status: 403,
  title: 'Search forbidden',
  type: 'https://ontos.dev/problems/search-forbidden',
});

/** The search for Pozdě waits at the server until the test releases it. */
let lateRelease = Deferred.makeUnsafe<boolean>();
const releaseLate = () => Deferred.doneUnsafe(lateRelease, Effect.succeed(true));

/**
 * What the counterparty search answers per query: Dolce lists Dolce and Novák, Novák only Novák, Vita Dolce under its
 * newer name, Pozdě Dolce and Novák once released, Výpadek is unavailable, Zákaz refuses the user, anything else finds
 * nobody.
 */
const answerFor = (query: string) =>
  Match.value(query).pipe(
    Match.when('Výpadek', () => Effect.fail(unavailable)),
    Match.when('Zákaz', () => Effect.fail(forbidden)),
    Match.when('Dolce', () => Effect.succeed([kept, other])),
    Match.when('Novák', () => Effect.succeed([other])),
    Match.when('Vita', () => Effect.succeed([renamed])),
    Match.when('Pozdě', () => Deferred.await(lateRelease).pipe(Effect.as([kept, other]))),
    Match.orElse(() => Effect.succeed([])),
  );

/** Every query the search received and every command the owner's Action received, in order. */
const queries: string[] = [];
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];

const OwnerRecordsApi = RecordsApi.prefix('/crm-activities-api');
const OwnerActionApi = ApplyCommandActionApi.prefix('/crm-activities-api');
const TasksApi = WorkRecordsApi.prefix('/work-tasks-api');
const SearchApi = CounterpartiesSearchApi.prefix('/party-registry-api');
const issuer = shellGatewayIssuer({
  'crm-activities': '/crm-activities-api',
  'party-registry': '/party-registry-api',
  'work-tasks': '/work-tasks-api',
});
const network = browserNetwork(
  issuer.application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(activityRecords)),
    ),
  ),
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return recorded;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    TasksApi,
    HttpApiBuilder.group(TasksApi, 'records', (group) => group.handle('execute', () => Effect.succeed(workRecords))),
  ),
  serveApi(
    SearchApi,
    HttpApiBuilder.group(SearchApi, 'counterpartiesSearch', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          queries.push(payload.query);
          return answerFor(payload.query);
        }),
      ),
    ),
  ),
);

const element = <E extends Element>(selector: string): E =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<E>(selector)));
const button = (name: string) => Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0]));
const saveButton = () => button('Uložit');
const findButton = () => button(copy(`${key}.find`));

/** The real picker's native select for the contact, found through its visible label. */
const contactSelect = () =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...document.querySelectorAll<HTMLSelectElement>('select')].find(
        (candidate) =>
          document.querySelector(`[id="${candidate.getAttribute('aria-labelledby') ?? ''}"]`)?.textContent?.trim() ===
          copy(`${key}.contact`),
      ),
    ),
  );

/** The contacts the picker offers, by id. */
const offered = () => [...contactSelect().options].map((option) => option.value).filter((value) => value !== '');

/** The record form; a failed search says so inside it. */
const form = () => Option.getOrThrow(Option.fromNullOr(element('#activity-summary').closest('form')));

/** What the contact picker's trigger shows. */
const contactShown = () =>
  document
    .querySelector(`[role="combobox"][aria-labelledby="${contactSelect().getAttribute('aria-labelledby') ?? ''}"]`)
    ?.textContent?.trim();

/** Types like a user: React sees a native input event. */
const typeInto = (selector: string, value: string) =>
  acted(() => {
    const input = element<HTMLInputElement>(selector);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

/** Asks the search for `query` and waits until the search received it. */
const ask = (query: string) =>
  Effect.gen(function* askContacts() {
    const asked = queries.length;
    yield* typeInto('#counterparty-query', query);
    yield* acted(() => findButton().click());
    yield* waitUntil(() => queries.length === asked + 1);
  });

/** Searches the contacts and waits until the answer arrived and the page took it. */
const search = (query: string) =>
  ask(query).pipe(Effect.andThen(networkIdle), Effect.andThen(waitUntil(() => !findButton().disabled)));

/**
 * Picks a contact through the real picker's native control and waits until the trigger shows it. The picker reports the
 * pick after its own event turn, so one more settle lets the render's effects run, as they do long before a person can
 * click again.
 */
const chooseContact = (resourceId: string, label: string) =>
  acted(() => {
    const select = contactSelect();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, resourceId);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }).pipe(Effect.andThen(waitUntil(() => contactShown() === label)), Effect.andThen(settle));

/** Mounts the page, picks Dolce from a search and types the summary. */
const chooseDolce = Effect.gen(function* chooseDolce() {
  yield* pinTestDocument;
  yield* mountInRoute(createElement(RecordsPage, props), { path: 'aktivity', url: '/cs/aktivity' });
  yield* waitUntil(() => document.querySelector('#activity-summary') !== null);
  // Nothing chosen, nothing typed: Uložit is held back.
  expect(saveButton().disabled).toBe(true);
  yield* search('Dolce');
  yield* chooseContact(kept.ref.resourceId, 'Kavárna Dolce');
  // A contact without a summary is held back too.
  expect(saveButton().disabled).toBe(true);
  yield* typeInto('#activity-summary', 'Domluvená ochutnávka');
  expect(saveButton().disabled).toBe(false);
  expect(contactShown()).toBe('Kavárna Dolce');
});

/** The choice as the user sees it: chosen in the native control, labelled in the trigger, Uložit enabled. */
const expectKept = () => {
  expect(contactSelect().value).toBe(kept.ref.resourceId);
  expect(contactShown()).toBe('Kavárna Dolce');
  expect(saveButton().disabled).toBe(false);
};

beforeEach(() => {
  lateRelease = Deferred.makeUnsafe<boolean>();
  queries.length = 0;
  commands.length = 0;
});

afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })('the activity form', (suite) => {
  suite.effect('a chosen contact survives a search that omits it and one that finds nobody', () =>
    Effect.gen(function* survivesOmission() {
      yield* chooseDolce;

      yield* search('Novák');
      expectKept();

      yield* search('Nikdo');
      expectKept();

      expect(queries).toEqual(['Dolce', 'Novák', 'Nikdo']);
      // Searching and choosing never record anything: only Uložit does.
      expect(commands).toEqual([]);
    }),
  );

  suite.effect('a search that fails for now keeps the contact, says so in the form and offers no earlier hit', () =>
    Effect.gen(function* survivesOutage() {
      yield* chooseDolce;
      yield* search('Novák');
      expect(offered()).toEqual([kept.ref.resourceId, other.ref.resourceId]);

      yield* search('Výpadek');
      expect(form().textContent).toContain(copy(`${key}.searchUnavailable`));
      expectKept();
      // Novák came from the earlier search: only the chosen contact is still offered.
      expect(offered()).toEqual([kept.ref.resourceId]);
      expect(commands).toEqual([]);
    }),
  );

  suite.effect('a refused search drops the chosen contact and every earlier hit and keeps the summary', () =>
    Effect.gen(function* refusalClears() {
      yield* chooseDolce;
      yield* search('Novák');

      yield* search('Zákaz');
      expect(text()).toContain(copy(`${key}.forbidden`));
      expect(contactSelect().value).toBe('');
      expect(contactShown()).toBe(copy(`${key}.choose`));
      expect(offered()).toEqual([]);
      expect(saveButton().disabled).toBe(true);
      expect(element<HTMLInputElement>('#activity-summary').value).toBe('Domluvená ochutnávka');
      expect(commands).toEqual([]);
    }),
  );

  suite.effect('no earlier search answers after a refusal: Find waits until the outstanding search answered', () =>
    Effect.gen(function* noLateAnswer() {
      yield* chooseDolce;
      yield* ask('Pozdě');
      // While Pozdě is outstanding no other search can be asked, so none can be refused before Pozdě answers.
      yield* typeInto('#counterparty-query', 'Zákaz');
      expect(findButton().disabled).toBe(true);
      yield* acted(() => findButton().click());
      expect(queries).toEqual(['Dolce', 'Pozdě']);

      releaseLate();
      yield* networkIdle;
      yield* waitUntil(() => !findButton().disabled);
      yield* search('Zákaz');
      yield* networkIdle;
      expect(contactSelect().value).toBe('');
      expect(offered()).toEqual([]);
      expect(saveButton().disabled).toBe(true);
      expect(queries).toEqual(['Dolce', 'Pozdě', 'Zákaz']);
    }),
  );

  suite.effect("the chosen contact's newer name stays after a later search omits it", () =>
    Effect.gen(function* renameSticks() {
      yield* chooseDolce;
      yield* search('Vita');
      expect(contactShown()).toBe('Kavárna Dolce Vita');

      yield* search('Novák');
      expect(contactSelect().value).toBe(kept.ref.resourceId);
      expect(contactShown()).toBe('Kavárna Dolce Vita');
      expect(saveButton().disabled).toBe(false);
    }),
  );

  suite.effect("Uložit sends the kept contact's full reference after searches that no longer list it", () =>
    Effect.gen(function* savesKeptReference() {
      yield* chooseDolce;
      yield* search('Novák');
      yield* search('Výpadek');
      expectKept();

      yield* acted(() => saveButton().click());
      yield* waitUntil(() => commands.length > 0);
      yield* networkIdle;
      expect(commands).toEqual([
        {
          command: {
            _tag: 'RecordActivity',
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: kept.ref.resourceId,
              resourceType: 'party.registry.counterparty',
              tenantId,
            },
            kind: 'CALL',
            occurredAt: '2026-10-05T10:00:00.000Z',
            ownerPrincipalRef: actorPrincipalRef,
            summary: 'Domluvená ochutnávka',
          },
          expectedRevision: 3,
        },
      ]);
      yield* waitUntil(() => text().includes(copy(`${key}.saved`)));
    }),
  );

  suite.effect('picking another contact replaces the kept one', () =>
    Effect.gen(function* picksAnother() {
      yield* chooseDolce;
      yield* search('Novák');
      yield* chooseContact(other.ref.resourceId, 'Pekárna Novák');
      expect(contactSelect().value).toBe(other.ref.resourceId);
      expect(contactShown()).toBe('Pekárna Novák');
      // Dolce is no longer kept: the picker offers only what the last search found.
      expect([...contactSelect().options].map((option) => option.value).filter((value) => value !== '')).toEqual([
        other.ref.resourceId,
      ]);

      yield* acted(() => saveButton().click());
      yield* waitUntil(() => commands.length > 0);
      yield* networkIdle;
      expect(commands.map((sent) => sent.command.counterpartyRef?.resourceId)).toEqual([other.ref.resourceId]);
    }),
  );

  suite.effect("the picker's clear action drops the contact, holds Uložit back and keeps the rest of the form", () =>
    Effect.gen(function* clearsContact() {
      yield* chooseDolce;
      yield* search('Novák');
      yield* acted(() => button(copy(`${key}.clearContact`)).click());
      yield* waitUntil(() => contactSelect().value === '' && contactShown() === copy(`${key}.choose`));
      expect(saveButton().disabled).toBe(true);
      expect(element<HTMLInputElement>('#activity-summary').value).toBe('Domluvená ochutnávka');
      expect(element<HTMLInputElement>('#counterparty-query').value).toBe('Novák');
      // Nothing is kept any more: the picker offers only what the last search found.
      expect(offered()).toEqual([other.ref.resourceId]);
      expect(commands).toEqual([]);
    }),
  );
});
