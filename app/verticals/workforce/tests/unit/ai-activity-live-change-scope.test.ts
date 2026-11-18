// @rstest-environment happy-dom
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { aiActivityData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';

const reads: RecordsRequest[] = [];
const emptyActivity = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  aiActivity: [],
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

const OwnerRecordsApi = RecordsApi.prefix('/workforce-api');
const network = browserNetwork(
  shellGatewayIssuer({ workforce: '/workforce-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return emptyActivity;
        }),
      ),
    ),
  ),
);

// The AI activity feed shows agents' Core audit events in every module, so another module's change re-reads it.
it.live('AI activity reloads on a change of any module', () =>
  Effect.gen(function* scopedAiActivity() {
    yield* pinTestDocument;
    yield* aiActivityData.preload('company-a');
    expect(reads).toHaveLength(1);
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        aiActivityData.subscribe(() => {
          aiActivityData.snapshot('company-a');
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['merchandise'] } }));
    yield* waitUntil(() => reads.length >= 2);
    yield* aiActivityData.read('company-a');
    expect(reads).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(network)),
);
