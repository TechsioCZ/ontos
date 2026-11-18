// @rstest-environment happy-dom
import { assertPageDataAppList } from '@app/shared-contracts/testing/page-data-app-list';
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
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

const listReads: unknown[] = [];
const detailReads: unknown[] = [];
const ListApi = CustomerListApi.prefix('/party-registry-api');
const CounterpartyApi = CounterpartyReadApi.prefix('/party-registry-api');
const IdentityApi = PartyDetailApi.prefix('/party-registry-api');
const ContactsApi = PartyContactPointsApi.prefix('/party-registry-api');
const IdentifiersApi = PartyOfficialIdentifierHistoryApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'party-registry': '/party-registry-api' }).application,
  serveApi(
    ListApi,
    HttpApiBuilder.group(ListApi, 'customerList', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          listReads.push(payload);
          return { items: [] };
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

it.live('customersData reloads only for its app list', () =>
  assertPageDataAppList({
    store: customersData,
    input: 'company-a',
    reads: () => listReads.length,
    expectedApps: ['commerce-customer-context', 'party-registry'],
  }).pipe(Effect.provide(network)),
);

it.live('customerDetailData reloads only for its app list', () =>
  assertPageDataAppList({
    store: customerDetailData,
    input: { customer, scope: 'company-a' },
    reads: () => detailReads.length,
    expectedApps: ['party-registry'],
  }).pipe(Effect.provide(network)),
);
