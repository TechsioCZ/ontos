// @rstest-environment happy-dom
import { RecordsApi as AgreementsRecordsApi } from '@app/legal-agreements/contracts/records';
import { RecordsApi as PropertyRecordsApi } from '@app/property-portfolio/contracts/records';
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect } from 'effect';
import { it } from 'effect-rstest';
import { assertPageDataAppList } from '@app/shared-contracts/testing/page-data-app-list';

import { CustomerListApi } from '../../../party-registry/shared/apis/customer-list.ts';
import { RecordsApi } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { leaseInputOf, leaseRecords } from '../../src/routes/[lang]/najmy/lease-occupant.ts';

const reads: RecordsRequest[] = [];
const OwnerRecordsApi = RecordsApi.prefix('/property-leasing-api');
const AgreementsApi = AgreementsRecordsApi.prefix('/legal-agreements-api');
const PropertiesApi = PropertyRecordsApi.prefix('/property-portfolio-api');
const CustomersApi = CustomerListApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'legal-agreements': '/legal-agreements-api',
    'party-registry': '/party-registry-api',
    'property-leasing': '/property-leasing-api',
    'property-portfolio': '/property-portfolio-api',
  }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return { occupancies: [], revision: 1 };
        }),
      ),
    ),
  ),
  serveApi(
    AgreementsApi,
    HttpApiBuilder.group(AgreementsApi, 'records', (group) =>
      group.handle('execute', () => Effect.succeed({ contracts: [], documents: [], revision: 1 })),
    ),
  ),
  serveApi(
    PropertiesApi,
    HttpApiBuilder.group(PropertiesApi, 'records', (group) =>
      group.handle('execute', () => Effect.succeed({ assets: [], properties: [], revision: 1, units: [] })),
    ),
  ),
  serveApi(
    CustomersApi,
    HttpApiBuilder.group(CustomersApi, 'customerList', (group) =>
      group.handle('execute', () => Effect.succeed({ items: [] })),
    ),
  ),
);

const input = leaseInputOf({ legalEntityId: 'company-a', principalId: 'manager-a', tenantId: 'tenant-a' });

it.layer(network, { excludeTestServices: true })('store app contract', (suite) => {
  suite.effect('leaseRecords reloads only for its app list', () =>
    assertPageDataAppList({
      expectedApps: ['legal-agreements', 'party-registry', 'property-leasing', 'property-portfolio'],
      input,
      reads: () => reads.length,
      store: leaseRecords,
    }),
  );
});
