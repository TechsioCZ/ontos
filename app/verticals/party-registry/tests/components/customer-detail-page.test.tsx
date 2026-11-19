// @rstest-environment happy-dom
// The customer detail: the same complete body in the side panel and on its own page, the exact Counterparty of the
// selected company with a current CUSTOMER role, refused, foreign and stale states that never show a record they should
// not, one Save that sends the edited draft once, and the customer's name handed to the Shell frame for the tab. The
// page runs on its real i18n, router and generated clients; the Shell's gateway issuer and Party Registry's reads and
// commands answer in process through their HttpApi contracts.
import { useDocumentTitle } from '@app/admin-ui';
import { acted, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  networkIdle,
  networkQuietExcept,
  networkSteady,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { DateTime, Deferred, Effect, Layer, Option, Predicate, Schema } from 'effect';
import type { ReactElement, ReactNode } from 'react';

import { partyCommandSchemaErrorLive } from '../../api/party-command-problems.ts';
import { CustomerListApi, CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import type { CustomerListRequest } from '../../shared/apis/customer-list.ts';
import {
  CounterpartyReadApi,
  CounterpartyReadForbiddenProblemSchema,
  CounterpartyReadInternalProblemSchema,
  CounterpartyReadNotFoundProblemSchema,
  CounterpartyReadResponseSchema,
} from '../../shared/apis/counterparty-read.ts';
import type { CounterpartyReadRequest } from '../../shared/apis/counterparty-read.ts';
import { PartyContactPointsApi } from '../../shared/apis/party-contact-points.ts';
import { PartyDetailApi } from '../../shared/apis/party-detail.ts';
import type { PartyDetailRequest } from '../../shared/apis/party-detail.ts';
import { PartyOfficialIdentifierHistoryApi } from '../../shared/apis/party-official-identifier-history.ts';
import { partyRegistryCommandsApi } from '../../shared/command-api.ts';
import type { UpdatePartyPayloadSchema } from '../../shared/command-api.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { partyRegistryI18nResources } from '../../src/i18n/resources.ts';
import { CustomerDetailDialog } from '../../src/routes/[lang]/prodej/zakaznici/customer-detail-dialog.tsx';
import {
  CustomerDetailPage,
  CustomerDetailPageNotice,
  CustomerDetailPageRecordView,
  CustomerDetailPageRouteParams,
} from '../../src/routes/[lang]/prodej/zakaznici/[id]/page.tsx';
import { routeMeta } from '../../src/routes/[lang]/prodej/zakaznici/[id]/route.meta.ts';
import {
  customerDetailPageData,
  customerDetailPageInput,
  loadCustomerDetailPageRecord,
} from '../../src/routes/[lang]/prodej/zakaznici/customer-detail-page-data.ts';
import type { CustomerDetailPageRecord } from '../../src/routes/[lang]/prodej/zakaznici/customer-detail-page-data.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';
import { expectHumanReadable } from '../support/visible-text.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const otherLegalEntityId = '30000000-0000-4000-8000-000000000009';
const counterpartyId = '40000000-0000-4000-8000-000000000001';
const rolePeriodId = '50000000-0000-4000-8000-000000000001';
const principalId = '70000000-0000-4000-8000-000000000001';
const instant = '2026-10-15T10:00:00.000Z';

const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: partyId,
  resourceType: 'party.registry.party' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const legalEntityRef = {
  moduleId: 'core.identity' as const,
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity' as const,
  tenantId,
};
const provenance = {
  evidenceReference: 'contract:2026-42',
  method: 'SIGNED_CONTRACT',
  reason: 'Signed commercial agreement establishes the context.',
  source: 'contracts.core',
};
const customerRole = {
  endProvenance: null,
  provenance,
  recordedAt: instant,
  rolePeriodRef: {
    moduleId: 'party.registry' as const,
    resourceId: rolePeriodId,
    resourceType: 'party.registry.counterparty-role-period' as const,
    tenantId,
  },
  roleType: 'CUSTOMER' as const,
  state: 'ACTIVE' as const,
  validFrom: instant,
  validTo: null,
};
const context = { displayName: 'Staff', legalEntityId, principalId, tenantId };
const routeParams = Schema.decodeSync(CustomerDetailPageRouteParams)({ id: counterpartyId });
const pageInput = Option.getOrThrow(customerDetailPageInput(context, { id: counterpartyId }));
const customer = Schema.decodeSync(CustomerListItemSchema)({
  city: null,
  companyId: null,
  counterpartyId,
  counterpartyRef,
  createdAt: instant,
  displayName: 'Eva Bílá',
  email: null,
  partyId,
  partyRef,
  partyRevision: 1,
  phone: null,
  status: 'ACTIVE',
  vatId: null,
});

const party = Schema.decodeSync(PartySchema)({
  archivedAt: null,
  businessName: null,
  createdAt: instant,
  displayName: 'Eva Bílá',
  firstName: 'Eva Bílá',
  lastName: null,
  partyRef,
  partyType: 'PERSON',
  revision: 1,
  updatedAt: instant,
});
const counterparty = Schema.decodeSync(CounterpartyReadResponseSchema)({
  counterpartyRef,
  createdAt: instant,
  currentRoles: [customerRole],
  legalEntityRef,
  party: {
    archived: false,
    canonicalPartyRef: partyRef,
    displayName: 'Eva Bílá',
    partyType: 'PERSON',
    storedPartyRef: partyRef,
  },
});
const identity = {
  currentFactAssertions: [],
  party,
  resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT' as const, requestedPartyRef: partyRef },
};
const record: CustomerDetailPageRecord = {
  contacts: { status: 'ready', value: { items: [] } },
  counterparty,
  identifiers: { status: 'ready', value: { items: [] } },
  identity: { status: 'ready', value: identity },
  now: DateTime.makeUnsafe(instant),
};
const endedIdentifier = {
  identifierType: 'ICO' as const,
  namespace: 'CZ:ICO',
  normalizedValue: '01000004',
  officialIdentifierRef: {
    moduleId: 'party.registry' as const,
    resourceId: '60000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.party-official-identifier' as const,
    tenantId,
  },
  partyRef,
  recordedAt: instant,
  state: 'ENDED' as const,
  validFrom: instant,
  validTo: instant,
  verification: 'UNVERIFIED' as const,
};

const copy = moduleText('cs', partyRegistryI18nResources);
const detail = (key: string) => copy(`party-registry.pages.customers.detail.${key}`);
const updated = { ...party, displayName: Option.some('Eva Černá'), revision: 2 };

/** What Party Registry answers the next counterparty read with; each test scripts it. */
let counterpartyAnswer: Effect.Effect<
  typeof counterparty,
  | typeof CounterpartyReadForbiddenProblemSchema.Type
  | typeof CounterpartyReadInternalProblemSchema.Type
  | typeof CounterpartyReadNotFoundProblemSchema.Type
> = Effect.succeed(counterparty);
/** Every read and command Party Registry received, by endpoint. */
const counterpartyReads: CounterpartyReadRequest[] = [];
const partyReads: PartyDetailRequest[] = [];
const customerListReads: CustomerListRequest[] = [];
const updates: (typeof UpdatePartyPayloadSchema.Encoded)[] = [];
/** Completes when Party Registry answered an update, or received a counterparty read. */
let updateAnswered = Deferred.makeUnsafe<true>();
let counterpartyReadArrived = Deferred.makeUnsafe<true>();

const OwnerCommand = HttpApi.make('PartyRegistryCommandsApi')
  .add(HttpApiGroup.make('partyCommands').add(partyRegistryCommandsApi.groups.partyCommands.endpoints.updateParty))
  .prefix('/party-registry-api');
const OwnerCounterparty = CounterpartyReadApi.prefix('/party-registry-api');
const OwnerIdentity = PartyDetailApi.prefix('/party-registry-api');
const OwnerContacts = PartyContactPointsApi.prefix('/party-registry-api');
const OwnerIdentifiers = PartyOfficialIdentifierHistoryApi.prefix('/party-registry-api');
const OwnerCustomers = CustomerListApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'party-registry': '/party-registry-api' }).application,
  serveApi(
    OwnerCommand,
    HttpApiBuilder.group(OwnerCommand, 'partyCommands', (group) =>
      group.handle('updateParty', ({ payload }) =>
        Effect.sync(() => {
          updates.push(payload);
          return updated;
        }).pipe(Effect.tap(() => Deferred.succeed(updateAnswered, true))),
      ),
    ).pipe(Layer.provide(partyCommandSchemaErrorLive)),
  ),
  serveApi(
    OwnerCounterparty,
    HttpApiBuilder.group(OwnerCounterparty, 'counterpartyRead', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          counterpartyReads.push(payload);
          return Deferred.succeed(counterpartyReadArrived, true).pipe(Effect.andThen(counterpartyAnswer));
        }),
      ),
    ),
  ),
  serveApi(
    OwnerIdentity,
    HttpApiBuilder.group(OwnerIdentity, 'partyDetail', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          partyReads.push(payload);
          return identity;
        }),
      ),
    ),
  ),
  serveApi(
    OwnerContacts,
    HttpApiBuilder.group(OwnerContacts, 'partyContactPoints', (group) =>
      group.handle('execute', () => Effect.succeed({ items: [] })),
    ),
  ),
  serveApi(
    OwnerIdentifiers,
    HttpApiBuilder.group(OwnerIdentifiers, 'partyOfficialIdentifierHistory', (group) =>
      group.handle('execute', () => Effect.succeed({ items: [] })),
    ),
  ),
  serveApi(
    OwnerCustomers,
    HttpApiBuilder.group(OwnerCustomers, 'customerList', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          customerListReads.push(payload);
          return { items: [] };
        }),
      ),
    ),
  ),
);

/** Mounts `element` on the customer's route under the module's real i18n and router. */
const mount = (element: ReactElement) =>
  Effect.gen(function* mountCustomer() {
    yield* pinTestDocument;
    return yield* mountInRoute(element, {
      path: 'prodej/zakaznici/$id',
      resources: partyRegistryI18nResources,
      url: `/cs/prodej/zakaznici/${counterpartyId}`,
    });
  });

const noop = (): void => {
  // Rendering tests assert the body; the callbacks deliberately do nothing.
};

const sectionKeys = ['identifiers', 'contacts', 'related'];

const expectDetailBody = () => {
  expect(screen.getByRole('heading', { name: 'Eva Bílá' })).toBeTruthy();
  for (const key of sectionKeys) {
    expect(screen.getByText(detail(key))).toBeTruthy();
  }
  // A customer without ended facts has no dated list, so neither surface shows a history title over the links.
  expect(screen.queryByText(detail('history'))).toBeNull();
  expect(screen.getByText(detail('createdAt'))).toBeTruthy();
  expect(screen.getByText(copy('party-registry.pages.customers.status.ACTIVE'))).toBeTruthy();
  expect(document.body.textContent).not.toContain(partyId);
  expect(document.body.textContent).not.toContain(counterpartyId);
  expectHumanReadable();
};

const fieldById = <T extends HTMLElement>(id: string) => {
  const element = document.querySelector<T>(`[id="${id}"]`);
  if (element === null) {
    throw new Error(`missing field ${id}`);
  }
  return element;
};
const archiveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: detail('archive') });
const saveButtons = () => screen.getAllByRole<HTMLButtonElement>('button', { name: 'Uložit' });
/** The page's one Save button; `getByRole` also fails when there is more than one. */
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Uložit' });
const heading = () => screen.queryByRole('heading', { name: 'Eva Bílá' });

/** Preloads the record and opens the full page on it. */
const openPage = Effect.gen(function* open() {
  yield* customerDetailPageData.preload(pageInput);
  const mounted = yield* mount(<CustomerDetailPage context={context} routeParams={routeParams} />);
  yield* waitUntil(() => heading() !== null);
  return mounted;
});

beforeEach(() => {
  customerDetailPageData.invalidate();
  counterpartyAnswer = Effect.succeed(counterparty);
  counterpartyReads.length = 0;
  partyReads.length = 0;
  customerListReads.length = 0;
  updates.length = 0;
  updateAnswered = Deferred.makeUnsafe<true>();
  counterpartyReadArrived = Deferred.makeUnsafe<true>();
});

afterEach(unmountAll);

/** True when `second` comes after `first` in document order. */
const follows = (first: Element, second: Element): boolean => {
  const order = [...document.querySelectorAll('*')];
  return order.indexOf(first) < order.indexOf(second);
};

/** What the Shell frame reads to name the tab: the record title a page gives (shell-frame.tsx). */
const FrameRecordTitle = ({ children }: { readonly children: ReactNode }) => {
  const title = useDocumentTitle();
  return (
    <>
      <output data-frame-record-title="">{title ?? ''}</output>
      {children}
    </>
  );
};

it.layer(network, { excludeTestServices: true })('customer detail page', (suite) => {
  suite.effect('renders the same complete detail body in the side panel and on the page', () =>
    Effect.gen(function* sameBody() {
      yield* mount(
        <CustomerDetailDialog
          customer={customer}
          onOpenChange={noop}
          onRenamed={noop}
          onRetry={noop}
          snapshot={record}
        />,
      );
      expectDetailBody();
      unmountAll();

      yield* mount(<CustomerDetailPageRecordView onChanged={noop} onRetry={noop} record={record} stale={false} />);
      expectDetailBody();
    }),
  );

  suite.effect('keeps the side panel save bar the last control of its footer', () =>
    Effect.gen(function* panelFooter() {
      yield* mount(
        <CustomerDetailDialog
          customer={customer}
          onOpenChange={noop}
          onRenamed={noop}
          onRetry={noop}
          snapshot={record}
        />,
      );
      yield* networkIdle;
      expect(saveButtons()).toHaveLength(1);
      const bar = saveButton().closest('[data-save-state]');
      expect(bar?.parentElement?.lastElementChild).toBe(bar);
    }),
  );

  suite.effect('lists an ended identifier in the same dated history section on the page and in the panel', () =>
    Effect.gen(function* endedIdentifierHistory() {
      const endedRecord: CustomerDetailPageRecord = {
        ...record,
        identifiers: { status: 'ready', value: { items: [endedIdentifier] } },
      };
      yield* mount(
        <CustomerDetailDialog
          customer={customer}
          onOpenChange={noop}
          onRenamed={noop}
          onRetry={noop}
          snapshot={endedRecord}
        />,
      );
      expect(screen.getByText(detail('history'))).toBeTruthy();
      expect(screen.getByText(/01000004/u)).toBeTruthy();
      expect(document.body.textContent).toContain(detail('states.ENDED'));
      unmountAll();

      yield* mount(<CustomerDetailPageRecordView onChanged={noop} onRetry={noop} record={endedRecord} stale={false} />);
      expect(screen.getByText(detail('history'))).toBeTruthy();
      expect(screen.getByText(/01000004/u)).toBeTruthy();
      expect(document.body.textContent).toContain(detail('states.ENDED'));
    }),
  );

  suite.effect('asks for the authenticated scope instead of offering a read that cannot start', () =>
    Effect.gen(function* withoutScope() {
      yield* mount(<CustomerDetailPage routeParams={routeParams} />);
      yield* networkIdle;
      expect(screen.getByText(detail('unavailable'))).toBeTruthy();
      expect(screen.queryByText(detail('reload'))).toBeNull();
      // Without a scope the page has no read input at all: nothing reached Party Registry.
      expect(counterpartyReads).toEqual([]);
    }),
  );

  suite.effect('loads a customer outside the first 500 rows by the exact Counterparty id', () =>
    Effect.gen(function* exactCounterparty() {
      yield* pinTestDocument;
      const loaded = yield* loadCustomerDetailPageRecord(pageInput);
      // The load has settled, so every request it made has been answered.
      expect(customerListReads).toEqual([]);
      expect(counterpartyReads).toEqual([{ counterpartyRef }]);
      expect(loaded.counterparty.counterpartyRef).toEqual(counterpartyRef);
      expect(loaded.counterparty.legalEntityRef).toEqual(legalEntityRef);
      expect(loaded.identity).toEqual(record.identity);
    }),
  );

  suite.effect('refuses a foreign-company Counterparty and a Party id instead of reusing any record', () =>
    Effect.gen(function* foreignRecord() {
      yield* pinTestDocument;
      counterpartyAnswer = Effect.succeed({
        ...counterparty,
        legalEntityRef: { ...legalEntityRef, resourceId: otherLegalEntityId },
      });
      const foreign = yield* Effect.flip(loadCustomerDetailPageRecord(pageInput));
      expect(Predicate.isTagged(foreign, 'CustomerDetailPageFailure')).toBe(true);
      expect(foreign).toHaveProperty('reason', 'not-found');

      const notFound = yield* Schema.decodeEffect(CounterpartyReadNotFoundProblemSchema)({
        _tag: 'CounterpartyReadNotFoundProblem',
        detail: 'Missing',
        status: 404,
        title: 'Not found',
        type: 'urn:test:not-found',
      });
      counterpartyAnswer = Effect.fail(notFound);
      const partyInput = Option.getOrThrow(customerDetailPageInput(context, { id: partyId }));
      const partyIdResult = yield* Effect.flip(loadCustomerDetailPageRecord(partyInput));
      expect(partyIdResult).toHaveProperty('reason', 'not-found');
      // Both loads have settled: neither read the Party behind a refused Counterparty.
      expect(partyReads).toEqual([]);
    }),
  );

  suite.effect('refuses a record whose Counterparty role is no longer a current CUSTOMER role', () =>
    Effect.gen(function* endedRole() {
      yield* pinTestDocument;
      const encoded = yield* Schema.encodeEffect(CounterpartyReadResponseSchema)(counterparty);
      counterpartyAnswer = Effect.succeed(
        yield* Schema.decodeEffect(CounterpartyReadResponseSchema)({
          ...encoded,
          currentRoles: [{ ...customerRole, state: 'ENDED' as const, validTo: instant }],
        }),
      );
      const ended = yield* Effect.flip(loadCustomerDetailPageRecord(pageInput));
      expect(Predicate.isTagged(ended, 'CustomerDetailPageFailure')).toBe(true);
      expect(ended).toHaveProperty('reason', 'not-found');
    }),
  );

  suite.effect('a forbidden refresh removes every rendered field and action', () =>
    Effect.gen(function* forbiddenRefresh() {
      yield* openPage;
      expect(screen.getByText(detail('archive'))).toBeTruthy();
      counterpartyAnswer = Effect.fail(
        yield* Schema.decodeEffect(CounterpartyReadForbiddenProblemSchema)({
          _tag: 'CounterpartyReadForbiddenProblem',
          detail: 'Denied',
          status: 403,
          title: 'Forbidden',
          type: 'urn:test:denied',
        }),
      );
      yield* customerDetailPageData.refresh(pageInput);
      yield* waitUntil(() => screen.queryByText(detail('forbidden')) !== null);
      expect(heading()).toBeNull();
      expect(screen.queryByText(detail('archive'))).toBeNull();
      expect(document.querySelector('#customer-rename')).toBeNull();
    }),
  );

  suite.effect('a scope switch never shows the previous scope record before effects run', () =>
    Effect.gen(function* scopeSwitch() {
      const { rerender } = yield* openPage;
      counterpartyAnswer = Effect.never;
      yield* rerender(
        <CustomerDetailPage context={{ ...context, legalEntityId: otherLegalEntityId }} routeParams={routeParams} />,
      );
      expect(heading()).toBeNull();
      expect(screen.getByText(detail('loading'))).toBeTruthy();
    }),
  );

  suite.effect('keeps the same-scope record read-only and offers a reload after a transient failure', () =>
    Effect.gen(function* staleSameScope() {
      yield* openPage;
      counterpartyAnswer = Effect.fail(
        yield* Schema.decodeEffect(CounterpartyReadInternalProblemSchema)({
          _tag: 'CounterpartyReadInternalProblem',
          detail: 'Read failed',
          status: 500,
          title: 'Internal',
          type: 'urn:test:internal',
        }),
      );
      yield* customerDetailPageData.refresh(pageInput);
      yield* waitUntil(() => screen.queryByText(detail('reload')) !== null);
      expect(heading()).toBeTruthy();
      expect(screen.getByText(detail('createdAt'))).toBeTruthy();
      expect(screen.queryByText(detail('unavailable'))).toBeNull();
      // A failed reload is the one case the user must act on: actions wait for a current record.
      expect(archiveButton().disabled).toBe(true);
    }),
  );

  suite.effect('the full page renders one Save button that sends the edited draft once', () =>
    Effect.gen(function* pageSave() {
      yield* openPage;
      expect(saveButtons()).toHaveLength(1);
      expect(saveButton().disabled).toBe(true);
      // The save bar sits directly under the editable fields, above the related records.
      expect(follows(fieldById('customer-rename'), saveButton())).toBe(true);
      expect(follows(saveButton(), screen.getByText(detail('related')))).toBe(true);
      yield* acted(() => {
        fireEvent.change(fieldById<HTMLInputElement>('customer-evidence'), { target: { value: 'document:42' } });
        fireEvent.change(fieldById<HTMLInputElement>('customer-reason'), { target: { value: 'Reviewed document' } });
        fireEvent.change(fieldById<HTMLInputElement>('customer-rename'), { target: { value: 'Eva Černá' } });
      });
      expect(saveButtons()).toHaveLength(1);
      expect(saveButton().disabled).toBe(false);
      // Earlier cases leave Counterparty reads their handler never answers open on the shared network.
      const held = yield* networkSteady;
      expect(updates).toEqual([]);
      // Closing the tab with the unsaved draft asks the browser's own question.
      const unload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
      yield* acted(() => {
        fireEvent.click(saveButton());
      });
      // Party Registry answered the one update; the page has taken the answer in before anything else could go out.
      yield* Deferred.await(updateAnswered);
      yield* networkQuietExcept(held);
      expect(updates).toHaveLength(1);
    }),
  );

  suite.effect('a background reload of the same record changes nothing on the full page', () =>
    Effect.gen(function* backgroundReload() {
      yield* openPage;
      yield* acted(() => {
        fireEvent.change(fieldById<HTMLInputElement>('customer-evidence'), { target: { value: 'document:42' } });
        fireEvent.change(fieldById<HTMLInputElement>('customer-reason'), { target: { value: 'Reviewed document' } });
      });
      expect(archiveButton().disabled).toBe(false);
      // A live change: the strict store reloads the same record and reads as pending until it answers.
      counterpartyAnswer = Effect.never;
      counterpartyReadArrived = Deferred.makeUnsafe<true>();
      yield* acted(() => {
        window.dispatchEvent(new Event(moduleChangeEvent));
      });
      yield* waitUntil(() => customerDetailPageData.snapshot(pageInput).state === 'pending');
      yield* Deferred.await(counterpartyReadArrived);
      yield* settle;
      expect(screen.queryByText(detail('reload'))).toBeNull();
      expect(heading()).toBeTruthy();
      expect(archiveButton().disabled).toBe(false);
      expect(fieldById<HTMLInputElement>('customer-reason').value).toBe('Reviewed document');
      expect(saveButtons()).toHaveLength(1);
    }),
  );

  suite.effect('the full page names the browser tab after the customer through the Shell frame', () =>
    Effect.gen(function* tabTitle() {
      yield* customerDetailPageData.preload(pageInput);
      yield* mount(
        <FrameRecordTitle>
          <CustomerDetailPage context={context} routeParams={routeParams} />
        </FrameRecordTitle>,
      );
      yield* waitUntil(() => heading() !== null);
      yield* waitUntil(() => document.querySelector('[data-frame-record-title]')?.textContent === 'Eva Bílá');
    }),
  );

  it('declares the customer page at its clean localized counterparty route', () => {
    expect(routeMeta.canonicalPath).toBe('/prodej/zakaznici/:id');
    expect(routeMeta.localisedPaths).toEqual({ cs: '/prodej/zakaznici/:id', en: '/prodej/zakaznici/:id' });
    expect(routeMeta.entrypoint.entrypointKey).toBe('party.registry.page.customer-detail');
    expect(routeMeta.public).toBe(false);
  });

  suite.effect('shows each page-level permission and availability state without inventing a record', () =>
    Effect.gen(function* notices() {
      for (const status of ['forbidden', 'loading', 'not-found', 'unavailable'] as const) {
        yield* mount(<CustomerDetailPageNotice onBack={noop} onRetry={noop} status={status} />);
        expect(screen.getByText(detail(status === 'not-found' ? 'notFound' : status))).toBeTruthy();
        unmountAll();
      }
    }),
  );

  suite.effect('renders the page read-only when the Party identity section is refused', () =>
    Effect.gen(function* refusedIdentity() {
      yield* mount(
        <CustomerDetailPageRecordView
          onChanged={noop}
          onRetry={noop}
          record={{ ...record, identity: { status: 'forbidden' } }}
          stale={false}
        />,
      );
      expect(screen.getByText(detail('forbidden'))).toBeTruthy();
      expect(screen.queryByText(detail('archive'))).toBeNull();
      expect(screen.queryByText(detail('saveName'))).toBeNull();
    }),
  );
});
