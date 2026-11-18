// @rstest-environment happy-dom
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { initialCrmState } from '../../shared/domain/state.ts';
import { crmRecordsData } from '../../src/crm/records.ts';

const reads: RecordsRequest[] = [];
const emptyRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assignmentCandidates: [],
  departedPrincipalIds: [],
  now: '2026-11-18T12:00:00.000Z',
  revision: 7,
  state: initialCrmState,
  viewer: {
    assign: true,
    principalId: '20000000-0000-4000-8000-000000000002',
    readAll: true,
    readAssigned: false,
    writeAll: true,
    writeAssigned: false,
  },
});

const OwnerRecordsApi = RecordsApi.prefix('/crm-api');
const network = browserNetwork(
  shellGatewayIssuer({ crm: '/crm-api' }).application,
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

beforeEach(() => {
  reads.length = 0;
  crmRecordsData.invalidate();
});

it.live('live changes of apps the CRM records do not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    yield* pinTestDocument;
    yield* crmRecordsData.preload({});
    yield* crmRecordsData.read({});
    const unsubscribe = crmRecordsData.subscribe(() => {
      crmRecordsData.snapshot({});
    }, {});
    expect(reads).toHaveLength(1);
    dispatchChange(['party-registry']);
    yield* Effect.sleep('10 millis');
    expect(reads).toHaveLength(1);
    unsubscribe();
  }).pipe(Effect.provide(network)),
);

it.live('a live change of crm reloads the mounted CRM records', () =>
  Effect.gen(function* ownChange() {
    yield* pinTestDocument;
    yield* crmRecordsData.preload({});
    yield* crmRecordsData.read({});
    const reloaded = yield* Deferred.make<boolean>();
    const unsubscribe = crmRecordsData.subscribe(() => {
      const snapshot = crmRecordsData.snapshot({});
      if (reads.length >= 2 && snapshot.state === 'ready' && !snapshot.refreshing) {
        Deferred.doneUnsafe(reloaded, Effect.succeed(true));
      }
    }, {});
    dispatchChange(['crm']);
    yield* Deferred.await(reloaded);
    expect(reads).toHaveLength(2);
    unsubscribe();
  }).pipe(Effect.provide(network)),
);

it.live('a Core identity change reloads the mounted CRM records and their assignee directory', () =>
  Effect.gen(function* identityChange() {
    yield* pinTestDocument;
    yield* crmRecordsData.preload({});
    yield* crmRecordsData.read({});
    const reloaded = yield* Deferred.make<boolean>();
    const unsubscribe = crmRecordsData.subscribe(() => {
      const snapshot = crmRecordsData.snapshot({});
      if (reads.length >= 2 && snapshot.state === 'ready' && !snapshot.refreshing) {
        Deferred.doneUnsafe(reloaded, Effect.succeed(true));
      }
    }, {});
    dispatchChange(['shell']);
    yield* Deferred.await(reloaded);
    expect(reads).toHaveLength(2);
    unsubscribe();
  }).pipe(Effect.provide(network)),
);
