// @rstest-environment happy-dom
// A document deep link on the agreements page: the page opens the exact document from the owner's records, never
// shows the signer or the signed reference, refuses a link naming two records, and keeps a missing document apart from
// a refused read. The page runs on its real i18n, router and generated clients; the Shell's gateway issuer, the
// agreements owner's records endpoint and Party Registry's customer reads answer in process through their contracts.
import { text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';

import { CounterpartyReadApi } from '../../../party-registry/shared/apis/counterparty-read.ts';
import type { CounterpartyReadRequest } from '../../../party-registry/shared/apis/counterparty-read.ts';
import { CustomerListApi } from '../../../party-registry/shared/apis/customer-list.ts';
import { RecordsApi, RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { agreementCustomerData, agreements } from '../../src/routes/[lang]/smlouvy/agreements-data.ts';
import { RecordsPage, preloadPage } from '../../src/routes/[lang]/smlouvy/page.tsx';
import { mountInRoute } from '../support/module-ui.ts';

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

const refused = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'refused',
  status: 403,
  title: 'Forbidden',
  type: 'urn:ontos:test:records-forbidden',
});

/** What the agreements owner answers the next records read with; each test scripts it. */
let answer: Effect.Effect<RecordsResponse, typeof RecordsForbiddenProblemSchema.Type> = Effect.succeed(records);
/** Every records read the agreements owner and every counterparty read Party Registry received, in order. */
const reads: RecordsRequest[] = [];
const counterpartyReads: CounterpartyReadRequest[] = [];
/** Completes once Party Registry answered the page's customer list. */
let customersServed = Deferred.makeUnsafe<true>();

const OwnerRecordsApi = RecordsApi.prefix('/legal-agreements-api');
const CustomersApi = CustomerListApi.prefix('/party-registry-api');
const CounterpartyApi = CounterpartyReadApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'legal-agreements': '/legal-agreements-api', 'party-registry': '/party-registry-api' })
    .application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          reads.push(payload);
          return answer;
        }),
      ),
    ),
  ),
  serveApi(
    CustomersApi,
    HttpApiBuilder.group(CustomersApi, 'customerList', (group) =>
      group.handle('execute', () => Deferred.succeed(customersServed, true).pipe(Effect.as({ items: [] }))),
    ),
  ),
  serveApi(
    CounterpartyApi,
    HttpApiBuilder.group(CounterpartyApi, 'counterpartyRead', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          counterpartyReads.push(payload);
          return Effect.never;
        }),
      ),
    ),
  ),
);

const show = (shown: ModulePageProps) =>
  Effect.gen(function* mount() {
    yield* pinTestDocument;
    yield* mountInRoute(<RecordsPage {...shown} />, { path: 'smlouvy', url: `/cs/smlouvy${shown.search ?? ''}` });
  });

beforeEach(() => {
  reads.length = 0;
  counterpartyReads.length = 0;
  answer = Effect.succeed(records);
  customersServed = Deferred.makeUnsafe<true>();
  agreements.invalidate();
  agreementCustomerData.invalidate();
});

afterEach(unmountAll);

it.live('opens the exact document deep link from the owner records without a search title or customer read', () =>
  Effect.gen(function* directDocumentLink() {
    yield* Effect.promise(() => preloadPage(props));
    yield* show(props);
    yield* waitUntil(() => text().includes('Předávací protokol'));
    // The whole markup, attributes included: a secret must not reach even a hidden attribute.
    const html = new XMLSerializer().serializeToString(document.body);
    expect(html).toContain('Předávací protokol');
    expect(html).toContain('priloha.pdf');
    expect(html).toContain('Rámcová smlouva');
    expect(html).toContain(`href="/cs/smlouvy?resourceId=${contractId}"`);
    expect(html).not.toContain('secret-signer');
    expect(html).not.toContain('secret-reference');
    // The page's own reads have all been answered: no counterparty read was among them.
    yield* Deferred.await(customersServed);
    expect(reads).toHaveLength(1);
    expect(counterpartyReads).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('renders two selectors as invalid without reading records or choosing one', () =>
  Effect.gen(function* twoSelectors() {
    yield* show({ ...props, search: `?resourceId=${contractId}&documentId=${documentId}` });
    expect(text()).toContain('Odkaz obsahuje dva různé záznamy');
    expect(text()).not.toContain('Předávací protokol');
  }).pipe(Effect.provide(network)),
);

it.live('keeps a missing document indistinguishable while a failed read stays forbidden', () =>
  Effect.gen(function* missingAndForbidden() {
    const missingProps = { ...props, search: `?documentId=${missingDocumentId}` };
    yield* Effect.promise(() => preloadPage(missingProps));
    yield* show(missingProps);
    yield* waitUntil(() => text().includes('Dokument nebyl nalezen nebo k němu nemáte přístup.'));
    unmountAll();
    agreements.invalidate();
    answer = Effect.fail(refused);
    yield* Effect.promise(() => preloadPage(props));
    yield* show(props);
    yield* waitUntil(() => text().includes('Pro tuto oblast nemáte oprávnění.'));
    expect(text()).not.toContain('Dokument nebyl nalezen');
  }).pipe(Effect.provide(network)),
);
