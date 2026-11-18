// @rstest-environment happy-dom
import { assertLiveChangeReload } from '@app/shared-contracts/testing/live-change-reload';
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { commerceCustomerContextApi } from '@app/commerce-customer-context/api';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { HttpApi } from 'effect/http-api';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { CustomerListApi, CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import { CounterpartyReadApi, CounterpartyReadResponseSchema } from '../../shared/apis/counterparty-read.ts';
import { PartyDetailApi, PartyDetailResponseSchema } from '../../shared/apis/party-detail.ts';
import { PartyContactPointsApi } from '../../shared/apis/party-contact-points.ts';
import { PartyOfficialIdentifierHistoryApi } from '../../shared/apis/party-official-identifier-history.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { customersData, customerDetailData } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const counterpartyId = '30000000-0000-4000-8000-000000000001';
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
const customer = Schema.decodeSync(CustomerListItemSchema)({
  city: null,
  companyId: null,
  counterpartyId,
  counterpartyRef,
  createdAt: instant,
  displayName: 'Before',
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
  businessName: 'Before',
  createdAt: instant,
  displayName: 'Before',
  firstName: null,
  lastName: null,
  partyRef,
  partyType: 'ORGANIZATION',
  revision: 1,
  updatedAt: instant,
});
const counterparty = Schema.decodeSync(CounterpartyReadResponseSchema)({
  counterpartyRef,
  createdAt: instant,
  currentRoles: [],
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '60000000-0000-4000-8000-000000000001',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  party: {
    archived: false,
    canonicalPartyRef: partyRef,
    displayName: 'Before',
    partyType: 'ORGANIZATION',
    storedPartyRef: partyRef,
  },
});
const identity = PartyDetailResponseSchema.make({
  currentFactAssertions: [],
  party,
  resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
});

/** Segment reads: the customer list shows each customer's Commerce Customer Context segment. */
const segmentReads: unknown[] = [];

const detailReads: unknown[] = [];
const ListApi = CustomerListApi.prefix('/party-registry-api');
const SegmentsApi = HttpApi.make('CustomerSegmentsTestApi')
  .add(commerceCustomerContextApi.groups.counterpartyCustomerGroupMemberships)
  .prefix('/commerce-customer-context-api');
const CounterpartyApi = CounterpartyReadApi.prefix('/party-registry-api');
const IdentityApi = PartyDetailApi.prefix('/party-registry-api');
const ContactsApi = PartyContactPointsApi.prefix('/party-registry-api');
const IdentifiersApi = PartyOfficialIdentifierHistoryApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'commerce-customer-context': '/commerce-customer-context-api',
    'party-registry': '/party-registry-api',
  }).application,
  serveApi(
    ListApi,
    HttpApiBuilder.group(ListApi, 'customerList', (group) =>
      group.handle('execute', () => Effect.succeed({ items: [customer] })),
    ),
  ),
  serveApi(
    SegmentsApi,
    HttpApiBuilder.group(SegmentsApi, 'counterpartyCustomerGroupMemberships', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          segmentReads.push(payload);
          return { effectiveAt: instant, groups: [], items: [] };
        }),
      ),
    ),
  ),
  serveApi(
    CounterpartyApi,
    HttpApiBuilder.group(CounterpartyApi, 'counterpartyRead', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          detailReads.push(payload);
          return counterparty;
        }),
      ),
    ),
  ),
  serveApi(
    IdentityApi,
    HttpApiBuilder.group(IdentityApi, 'partyDetail', (group) =>
      group.handle('execute', () => Effect.sync(() => identity)),
    ),
  ),
  serveApi(
    ContactsApi,
    HttpApiBuilder.group(ContactsApi, 'partyContactPoints', (group) =>
      group.handle('execute', () => Effect.sync(() => ({ items: [] }))),
    ),
  ),
  serveApi(
    IdentifiersApi,
    HttpApiBuilder.group(IdentifiersApi, 'partyOfficialIdentifierHistory', (group) =>
      group.handle('execute', () => Effect.sync(() => ({ items: [] }))),
    ),
  ),
);

it.layer(network, { excludeTestServices: true })('customer store app contracts', (suite) => {
  suite.effect('customersData reloads on a live change of the data it reads and ignores an unrelated app', () =>
    assertLiveChangeReload({
      ignores: 'tax',
      input: 'company-a',
      reads: () => segmentReads.length,
      reloadsOn: ['party-registry', 'commerce-customer-context'],
      store: customersData,
    }),
  );

  suite.effect('customerDetailData reloads on a live change of the data it reads and ignores an unrelated app', () =>
    assertLiveChangeReload({
      ignores: 'tax',
      input: { customer, scope: 'company-a' },
      reads: () => detailReads.length,
      reloadsOn: ['party-registry'],
      store: customerDetailData,
    }),
  );
});
