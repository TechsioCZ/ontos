// @rstest-environment happy-dom
import { assertPageDataAppList } from '@app/shared-contracts/testing/page-data-app-list';
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import {
  CounterpartyReadApi,
  CounterpartyReadResponseSchema,
} from '../../../party-registry/shared/apis/counterparty-read.ts';
import { ContractSchema } from '../../shared/apis/records.ts';
import { agreementCustomerData } from '../../src/routes/[lang]/smlouvy/agreements-data.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const contract = Schema.decodeUnknownSync(ContractSchema)({
  contractRef: {
    moduleId: 'legal.agreements',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'legal.agreements.contract',
    tenantId,
  },
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  endDate: '2027-10-05',
  kind: 'LEASE',
  lifecycleState: 'ACTIVE',
  note: null,
  occupancyRef: null,
  propertyRef: null,
  renewalNoticeDate: null,
  rentTerms: { currency: 'CZK', monthlyRentMinor: 1_850_000, paymentDay: 15, serviceChargesMinor: 250_050 },
  responsiblePerson: 'Jana Nováková',
  signatureState: 'SIGNED',
  startDate: '2026-10-05',
  subject: 'Nájem kanceláře',
  supersedesContractRef: null,
  unitRef: null,
});
const input = { contract, revision: 1, scope: 'live-change-scope-test' };

const response = Schema.decodeUnknownSync(CounterpartyReadResponseSchema)({
  counterpartyRef: contract.counterpartyRef,
  createdAt: '2026-10-15T10:00:00.000Z',
  currentRoles: [],
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '60000000-0000-4000-8000-000000000001',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  party: {
    archived: false,
    canonicalPartyRef: {
      moduleId: 'party.registry',
      resourceId: '40000000-0000-4000-8000-000000000001',
      resourceType: 'party.registry.party',
      tenantId,
    },
    displayName: 'Acme',
    partyType: 'ORGANIZATION',
    storedPartyRef: {
      moduleId: 'party.registry',
      resourceId: '40000000-0000-4000-8000-000000000001',
      resourceType: 'party.registry.party',
      tenantId,
    },
  },
});
const reads: unknown[] = [];
const OwnerApi = CounterpartyReadApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'party-registry': '/party-registry-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'counterpartyRead', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return response;
        }),
      ),
    ),
  ),
);

it.live('agreementCustomerData reloads only for its app list', () =>
  assertPageDataAppList({
    expectedApps: ['legal-agreements', 'party-registry'],
    input,
    reads: () => reads.length,
    store: agreementCustomerData,
  }).pipe(Effect.provide(network)),
);
