import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import { agreementCustomerData, agreements } from '../../src/routes/[lang]/smlouvy/agreements-data.ts';
import { RecordsPage, preloadPage } from '../../src/routes/[lang]/smlouvy/page.tsx';

const mocks = rstest.hoisted(() => ({ customer: rstest.fn(), customers: rstest.fn(), records: rstest.fn() }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('@app/party-registry/api/client', () => ({
  executeCounterpartyRead: mocks.customer,
  listCustomers: mocks.customers,
}));
rstest.mock('../../src/routes/[lang]/smlouvy/rental-reference-access.ts', () => ({
  rentalReferenceAccess: Effect.succeed(false),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({ useNavigate: () => () => {}, useRouterState: () => '' }));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: String }),
}));
rstest.mock('react', () => ({
  ...rstest.requireActual<typeof React>('react'),
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));

const tenantId = '20000000-0000-4000-8000-000000000001';
const contractId = '40000000-0000-4000-8000-000000000001';
const documentId = '40000000-0000-4000-8000-000000000002';
const contractRef = {
  moduleId: 'legal.agreements',
  resourceId: contractId,
  resourceType: 'legal.agreements.contract',
  tenantId,
};
const documentRef = {
  moduleId: 'legal.agreements',
  resourceId: documentId,
  resourceType: 'legal.agreements.document',
  tenantId,
};
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  contracts: [
    {
      contractRef,
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: '40000000-0000-4000-8000-000000000099',
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      endDate: null,
      expiringSoon: false,
      hasSuccessorDraft: false,
      isExpired: false,
      kind: 'OTHER',
      lifecycleState: 'ACTIVE',
      note: 'secret-note',
      occupancyRef: null,
      propertyRef: null,
      renewalNoticeDate: null,
      signatureState: 'SIGNED',
      startDate: '2026-01-01',
      subject: 'Rámcová smlouva',
      supersedesContractRef: null,
      unitRef: null,
    },
  ],
  documents: [
    {
      contractRef,
      createdAt: '2026-01-01T08:00:00.000Z',
      documentRef,
      fileName: 'priloha.pdf',
      kind: 'PŘÍLOHA',
      lifecycleState: 'FINAL',
      signedBy: 'secret-signer',
      signedDocumentReference: 'secret-reference',
      signedOn: '2026-01-02',
      title: 'Předávací protokol',
      updatedAt: '2026-01-03T09:00:00.000Z',
    },
  ],
  revision: 7,
});
const context = { legalEntityId: 'company-a', principalId: 'lawyer-a', tenantId };
const missingDocumentId = '40000000-0000-4000-8000-000000000099';
const props: ModulePageProps = { context, routeParams: {}, search: `?documentId=${documentId}` };

beforeEach(() => {
  rstest.stubGlobal('React', React);
  rstest.stubGlobal('document', {});
  rstest.stubGlobal('dispatchEvent', () => true);
  mocks.records.mockReset();
  mocks.records.mockReturnValue(Effect.succeed(records));
  mocks.customers.mockReset();
  mocks.customers.mockReturnValue(Effect.succeed([]));
  mocks.customer.mockReset();
  mocks.customer.mockReturnValue(Effect.never);
  agreements.invalidate();
  agreementCustomerData.invalidate();
});

afterEach(() => {
  rstest.unstubAllGlobals();
});

it.live('opens the exact document deep link from the owner records without a search title or customer read', () =>
  Effect.gen(function* directDocumentLink() {
    yield* Effect.promise(() => preloadPage(props));
    const html = renderToStaticMarkup(createElement(RecordsPage, props));
    expect(html).toContain('Předávací protokol');
    expect(html).toContain('priloha.pdf');
    expect(html).toContain('Rámcová smlouva');
    expect(html).toContain(`href="/cs/smlouvy?resourceId=${contractId}"`);
    expect(html).not.toContain('secret-signer');
    expect(html).not.toContain('secret-reference');
    expect(html).not.toContain('searchHitTitle');
    expect(mocks.records).toHaveBeenCalledTimes(1);
    expect(mocks.customer).not.toHaveBeenCalled();
  }),
);

it('renders two selectors as invalid without reading records or choosing one', () => {
  const html = renderToStaticMarkup(
    createElement(RecordsPage, {
      ...props,
      search: `?resourceId=${contractId}&documentId=${documentId}`,
    }),
  );
  expect(html).toContain('Odkaz obsahuje dva různé záznamy');
  expect(html).not.toContain('Předávací protokol');
});

it.live('keeps a missing document indistinguishable while a failed read stays forbidden', () =>
  Effect.gen(function* missingAndForbidden() {
    yield* Effect.promise(() => preloadPage({ ...props, search: `?documentId=${missingDocumentId}` }));
    const missing = renderToStaticMarkup(
      createElement(RecordsPage, { ...props, search: `?documentId=${missingDocumentId}` }),
    );
    expect(missing).toContain('Dokument nebyl nalezen nebo k němu nemáte přístup.');
    agreements.invalidate();
    mocks.records.mockReturnValue(Effect.fail({ _tag: 'RecordsForbiddenProblem', status: 403 }));
    yield* Effect.promise(() => preloadPage(props));
    const forbidden = renderToStaticMarkup(createElement(RecordsPage, props));
    expect(forbidden).toContain('Pro tuto oblast nemáte oprávnění.');
    expect(forbidden).not.toContain('Dokument nebyl nalezen');
  }),
);
