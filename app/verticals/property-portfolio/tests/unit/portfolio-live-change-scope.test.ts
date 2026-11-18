// @rstest-environment happy-dom
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import {
  RecordsApi as WorkforceRecordsApi,
  RecordsResponseSchema as WorkforceRecordsResponseSchema,
} from '@app/workforce/contracts/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';

import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { propertyRecords, recordsInput } from '../../src/routes/[lang]/nemovitosti/property-summary.ts';

const reads: RecordsRequest[] = [];
const emptyProperties = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assets: [],
  properties: [],
  revision: 1,
  units: [],
});
const emptyWorkforce = Schema.decodeUnknownSync(WorkforceRecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  availablePrincipals: [],
  canWrite: true,
  indicators: {
    active: 0,
    byDepartment: [],
    byRole: { ACCOUNTANT: 0, SALES_HEAD: 0, SALES_REP: 0, SUPPORT: 0, WAREHOUSE: 0 },
    total: 0,
  },
  items: [],
  revision: 1,
});

const OwnerRecordsApi = RecordsApi.prefix('/property-portfolio-api');
const WorkforceApi = WorkforceRecordsApi.prefix('/workforce-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'property-portfolio': '/property-portfolio-api',
    workforce: '/workforce-api',
  }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return emptyProperties;
        }),
      ),
    ),
  ),
  serveApi(
    WorkforceApi,
    HttpApiBuilder.group(WorkforceApi, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(emptyWorkforce)),
    ),
  ),
);

const input = recordsInput({ legalEntityId: 'company-a', principalId: 'manager-a', tenantId: 'tenant-a' });

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  window.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

beforeEach(() => {
  reads.length = 0;
  propertyRecords.invalidate();
});

it.live('the property register ignores a live change from an app it does not show', () =>
  Effect.gen(function* unrelatedChange() {
    yield* pinTestDocument;
    const unsubscribe = propertyRecords.subscribe(() => {
      propertyRecords.snapshot(input);
    }, input);
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    yield* propertyRecords.preload(input);
    expect(reads).toHaveLength(1);
    dispatchChange(['property-leasing']);
    yield* Effect.sleep('10 millis');
    expect(reads).toHaveLength(1);
    dispatchChange(['workforce']);
    yield* waitUntil(() => reads.length === 2);
    expect(reads).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(network)),
);
