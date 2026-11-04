import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { DateTime, Effect, Option, Predicate, Schema } from 'effect';
import type { ReactNode } from 'react';

import { CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import {
  CounterpartyReadForbiddenProblemSchema,
  CounterpartyReadInternalProblemSchema,
  CounterpartyReadNotFoundProblemSchema,
  CounterpartyReadResponseSchema,
} from '../../shared/apis/counterparty-read.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { executeCounterpartyRead } from '../../src/api/counterparty-read-client.ts';
import { executeCustomerList } from '../../src/api/customer-list-client.ts';
import { executePartyContactPoints } from '../../src/api/party-contact-points-client.ts';
import { executePartyDetail } from '../../src/api/party-detail-client.ts';
import { executePartyOfficialIdentifierHistory } from '../../src/api/party-official-identifier-history-client.ts';
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
import { expectHumanReadable } from '../support/visible-text.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useNavigate: () => rstest.fn(),
  useParams: () => ({ id: '' }),
  useRouterState: () => '/cs/prodej/zakaznici',
}));
rstest.mock('../../src/routes/ultramodern-route-head.tsx', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('../../src/api/counterparty-read-client.ts');
rstest.mock('../../src/api/party-detail-client.ts');
rstest.mock('../../src/api/party-contact-points-client.ts');
rstest.mock('../../src/api/party-official-identifier-history-client.ts');
rstest.mock('../../src/api/customer-list-client.ts');

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
  createdAt: instant,
  displayName: 'Eva Bílá',
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
  factHistory: Option.none(),
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

const noop = (): void => {
  // Rendering tests assert the body; the callbacks deliberately do nothing.
};

const sectionKeys = [
  'party-registry.pages.customers.detail.identifiers',
  'party-registry.pages.customers.detail.contacts',
  'party-registry.pages.customers.detail.related',
];

const expectDetailBody = () => {
  expect(screen.getByRole('heading', { name: 'Eva Bílá' })).toBeTruthy();
  for (const key of sectionKeys) {
    expect(screen.getByText(key)).toBeTruthy();
  }
  // A customer without ended facts has no dated list, so neither surface shows a history title over the links.
  expect(screen.queryByText('party-registry.pages.customers.detail.history')).toBeNull();
  expect(screen.getByText('party-registry.pages.customers.detail.createdAt')).toBeTruthy();
  expect(screen.getByText('party-registry.pages.customers.status.ACTIVE')).toBeTruthy();
  expect(document.body.textContent).not.toContain(partyId);
  expect(document.body.textContent).not.toContain(counterpartyId);
  expectHumanReadable();
};

beforeEach(() => {
  rstest.resetAllMocks();
  customerDetailPageData.invalidate();
  rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.succeed(counterparty));
  rstest.mocked(executePartyDetail).mockReturnValue(Effect.succeed(identity));
  rstest.mocked(executePartyContactPoints).mockReturnValue(Effect.succeed({ items: [] }));
  rstest.mocked(executePartyOfficialIdentifierHistory).mockReturnValue(Effect.succeed({ items: [] }));
  rstest.mocked(executeCustomerList).mockReturnValue(Effect.succeed({ items: [] }));
});

afterEach(cleanup);

it('renders the same complete detail body in the side panel and on the page', () => {
  render(
    <CustomerDetailDialog customer={customer} onOpenChange={noop} onRenamed={noop} onRetry={noop} snapshot={record} />,
  );
  expectDetailBody();
  cleanup();

  render(<CustomerDetailPageRecordView onChanged={noop} onRetry={noop} record={record} stale={false} />);
  expectDetailBody();
});

it('lists an ended identifier in the same dated history section on the page and in the panel', () => {
  const endedRecord: CustomerDetailPageRecord = {
    ...record,
    identifiers: { status: 'ready', value: { items: [endedIdentifier] } },
  };
  render(
    <CustomerDetailDialog
      customer={customer}
      onOpenChange={noop}
      onRenamed={noop}
      onRetry={noop}
      snapshot={endedRecord}
    />,
  );
  expect(screen.getByText('party-registry.pages.customers.detail.history')).toBeTruthy();
  expect(screen.getByText(/01000004/u)).toBeTruthy();
  expect(screen.getByText(/party-registry\.pages\.customers\.detail\.states\.ENDED/u)).toBeTruthy();
  cleanup();

  render(<CustomerDetailPageRecordView onChanged={noop} onRetry={noop} record={endedRecord} stale={false} />);
  expect(screen.getByText('party-registry.pages.customers.detail.history')).toBeTruthy();
  expect(screen.getByText(/01000004/u)).toBeTruthy();
  expect(screen.getByText(/party-registry\.pages\.customers\.detail\.states\.ENDED/u)).toBeTruthy();
});

it('asks for the authenticated scope instead of offering a read that cannot start', () => {
  render(<CustomerDetailPage routeParams={routeParams} />);
  expect(screen.getByText('party-registry.pages.customers.detail.unavailable')).toBeTruthy();
  expect(screen.queryByText('party-registry.pages.customers.detail.reload')).toBeNull();
  expect(executeCounterpartyRead).not.toHaveBeenCalled();
});

it.live('loads a customer outside the first 500 rows by the exact Counterparty id', () =>
  Effect.gen(function* exactCounterparty() {
    const loaded = yield* loadCustomerDetailPageRecord(pageInput);
    expect(executeCustomerList).not.toHaveBeenCalled();
    expect(executeCounterpartyRead).toHaveBeenCalledWith({ counterpartyRef }, expect.any(String));
    expect(loaded.counterparty.counterpartyRef).toEqual(counterpartyRef);
    expect(loaded.counterparty.legalEntityRef).toEqual(legalEntityRef);
    expect(loaded.identity).toEqual(record.identity);
  }),
);

it.live('refuses a foreign-company Counterparty and a Party id instead of reusing any record', () =>
  Effect.gen(function* foreignRecord() {
    rstest
      .mocked(executeCounterpartyRead)
      .mockReturnValue(
        Effect.succeed({ ...counterparty, legalEntityRef: { ...legalEntityRef, resourceId: otherLegalEntityId } }),
      );
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
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.fail(notFound));
    const partyInput = Option.getOrThrow(customerDetailPageInput(context, { id: partyId }));
    const partyIdResult = yield* Effect.flip(loadCustomerDetailPageRecord(partyInput));
    expect(partyIdResult).toHaveProperty('reason', 'not-found');
    expect(executePartyDetail).not.toHaveBeenCalled();
  }),
);

it.live('refuses a record whose Counterparty role is no longer a current CUSTOMER role', () =>
  Effect.gen(function* endedRole() {
    rstest.mocked(executeCounterpartyRead).mockReturnValue(
      Effect.succeed({
        ...counterparty,
        currentRoles: [{ ...customerRole, state: 'ENDED' as const, validTo: instant }],
      }),
    );
    const ended = yield* Effect.flip(loadCustomerDetailPageRecord(pageInput));
    expect(Predicate.isTagged(ended, 'CustomerDetailPageFailure')).toBe(true);
    expect(ended).toHaveProperty('reason', 'not-found');
  }),
);

it.live('a forbidden refresh removes every rendered field and action', () =>
  Effect.gen(function* forbiddenRefresh() {
    yield* customerDetailPageData.preload(pageInput);
    render(<CustomerDetailPage context={context} routeParams={routeParams} />);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('heading', { name: 'Eva Bílá' })).toBeTruthy()));
    expect(screen.getByText('party-registry.pages.customers.detail.archive')).toBeTruthy();
    const denied = yield* Schema.decodeEffect(CounterpartyReadForbiddenProblemSchema)({
      _tag: 'CounterpartyReadForbiddenProblem',
      detail: 'Denied',
      status: 403,
      title: 'Forbidden',
      type: 'urn:test:denied',
    });
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.fail(denied));
    yield* customerDetailPageData.refresh(pageInput);
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText('party-registry.pages.customers.detail.forbidden')).toBeTruthy()),
    );
    expect(screen.queryByRole('heading', { name: 'Eva Bílá' })).toBeNull();
    expect(screen.queryByText('party-registry.pages.customers.detail.archive')).toBeNull();
    expect(document.querySelector('#customer-rename')).toBeNull();
  }),
);

it.live('a scope switch never shows the previous scope record before effects run', () =>
  Effect.gen(function* scopeSwitch() {
    yield* customerDetailPageData.preload(pageInput);
    const { rerender } = render(<CustomerDetailPage context={context} routeParams={routeParams} />);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('heading', { name: 'Eva Bílá' })).toBeTruthy()));
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.never);
    rerender(
      <CustomerDetailPage context={{ ...context, legalEntityId: otherLegalEntityId }} routeParams={routeParams} />,
    );
    expect(screen.queryByRole('heading', { name: 'Eva Bílá' })).toBeNull();
    expect(screen.getByText('party-registry.pages.customers.detail.loading')).toBeTruthy();
  }),
);

it.live('keeps the same-scope record read-only and offers a reload after a transient failure', () =>
  Effect.gen(function* staleSameScope() {
    yield* customerDetailPageData.preload(pageInput);
    render(<CustomerDetailPage context={context} routeParams={routeParams} />);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('heading', { name: 'Eva Bílá' })).toBeTruthy()));
    const internal = yield* Schema.decodeEffect(CounterpartyReadInternalProblemSchema)({
      _tag: 'CounterpartyReadInternalProblem',
      detail: 'Read failed',
      status: 500,
      title: 'Internal',
      type: 'urn:test:internal',
    });
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.fail(internal));
    yield* customerDetailPageData.refresh(pageInput);
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText('party-registry.pages.customers.detail.reload')).toBeTruthy()),
    );
    expect(screen.getByRole('heading', { name: 'Eva Bílá' })).toBeTruthy();
    expect(screen.getByText('party-registry.pages.customers.detail.createdAt')).toBeTruthy();
    expect(screen.queryByText('party-registry.pages.customers.detail.unavailable')).toBeNull();
  }),
);

it('declares the customer page at its clean localized counterparty route', () => {
  expect(routeMeta.canonicalPath).toBe('/prodej/zakaznici/:id');
  expect(routeMeta.localisedPaths).toEqual({ cs: '/prodej/zakaznici/:id', en: '/prodej/zakaznici/:id' });
  expect(routeMeta.entrypoint.entrypointKey).toBe('party.registry.page.customer-detail');
  expect(routeMeta.public).toBe(false);
});

it('shows each page-level permission and availability state without inventing a record', () => {
  for (const [status, key] of [
    ['forbidden', 'party-registry.pages.customers.detail.forbidden'],
    ['loading', 'party-registry.pages.customers.detail.loading'],
    ['not-found', 'party-registry.pages.customers.detail.notFound'],
    ['unavailable', 'party-registry.pages.customers.detail.unavailable'],
  ] as const) {
    render(<CustomerDetailPageNotice onBack={noop} onRetry={noop} status={status} />);
    expect(screen.getByText(key)).toBeTruthy();
    cleanup();
  }
});

it('renders the page read-only when the Party identity section is refused', () => {
  render(
    <CustomerDetailPageRecordView
      onChanged={noop}
      onRetry={noop}
      record={{ ...record, identity: { status: 'forbidden' } }}
      stale={false}
    />,
  );
  expect(screen.getByText('party-registry.pages.customers.detail.forbidden')).toBeTruthy();
  expect(screen.queryByText('party-registry.pages.customers.detail.archive')).toBeNull();
  expect(screen.queryByText('party-registry.pages.customers.detail.saveName')).toBeNull();
});
