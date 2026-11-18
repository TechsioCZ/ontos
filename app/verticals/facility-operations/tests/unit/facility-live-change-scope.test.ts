// @rstest-environment happy-dom
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { agendaRecordsData } from '../../src/ui/use-agenda.ts';

const reads: RecordsRequest[] = [];
const emptyRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  access: [],
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  agendas: {},
});
const OwnerRecordsApi = RecordsApi.prefix('/facility-operations-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'facility-operations': '/facility-operations-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return emptyRecords;
        }),
      ),
    ),
  ),
);

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  window.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

it.live('agenda records ignore a live change from another vertical', () =>
  Effect.gen(function* unrelatedChange() {
    yield* pinTestDocument;
    const agendas = ['assets'] as const;
    const unsubscribe = agendaRecordsData.subscribe(() => {
      agendaRecordsData.snapshot(agendas);
    }, agendas);
    yield* Effect.gen(function* checkChanges() {
      yield* agendaRecordsData.preload(agendas);
      expect(reads).toHaveLength(1);
      dispatchChange(['work-tasks']);
      // A read the unrelated change started has reached the owner by the time the network is idle.
      yield* networkIdle;
      expect(reads).toHaveLength(1);
      dispatchChange(['facility-operations']);
      yield* waitUntil(() => reads.length === 2);
      yield* networkIdle;
      expect(reads).toHaveLength(2);
    }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
  }).pipe(Effect.provide(network)),
);
