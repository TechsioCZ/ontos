// @rstest-environment happy-dom
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import { RecordsApi as AgreementsRecordsApi } from '@app/legal-agreements/contracts/records';
import { RecordsApi as PropertyRecordsApi } from '@app/property-portfolio/contracts/records';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';

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

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  window.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

beforeEach(() => {
  reads.length = 0;
  leaseRecords.invalidate();
});

it.live('lease records ignore a live change from an app they do not show', () =>
  Effect.gen(function* unrelatedChange() {
    yield* pinTestDocument;
    const unsubscribe = leaseRecords.subscribe(() => {
      leaseRecords.snapshot(input);
    }, input);
    yield* Effect.gen(function* checkChanges() {
      yield* leaseRecords.preload(input);
      expect(reads).toHaveLength(1);
      dispatchChange(['finance-billing']);
      yield* Effect.sleep('10 millis');
      expect(reads).toHaveLength(1);
      dispatchChange(['party-registry']);
      yield* waitUntil(() => leaseRecords.snapshot(input).state === 'ready');
      expect(reads).toHaveLength(2);
    }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
  }).pipe(Effect.provide(network)),
);
