// @rstest-environment happy-dom
import { assertLiveChangeReload } from '@app/shared-contracts/testing/live-change-reload';
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { activities } from '../../src/routes/[lang]/aktivity/page.tsx';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';

const response = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  canWrite: true,
  items: [],
  revision: 1,
});

const reads: unknown[] = [];
const OwnerApi = RecordsApi.prefix('/crm-activities-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'crm-activities': '/crm-activities-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return response;
        }),
      ),
    ),
  ),
);

it.layer(network, { excludeTestServices: true })('store app contract', (suite) => {
  suite.effect('activities reloads on a live change of the data it reads and ignores an unrelated app', () =>
    assertLiveChangeReload({
      ignores: 'tax',
      input: { legalEntityId: 'company-a', resourceId: '10000000-0000-4000-8000-000000000001' },
      reads: () => reads.length,
      reloadsOn: ['crm-activities'],
      store: activities,
    }),
  );
});
