// @rstest-environment happy-dom
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { RecordsApi, RecordsResponseSchema } from '@app/tagging/contracts/records';
import type { RecordsRequest } from '@app/tagging/contracts/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { employeeTagsData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';

const TaggingRecordsApi = RecordsApi.prefix('/tagging-api');
const emptyTags = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assignments: [],
  canWrite: true,
  indicators: { assignmentCount: 0, tagCount: 0 },
  revision: 1,
  tags: [],
});

// Employee tags come from the tagging module; a change of another module must not re-read them.
it.live('employee tags reload on tagging changes only', () => {
  const reads: RecordsRequest[] = [];
  const reloaded = Deferred.makeUnsafe<boolean>();
  const network = browserNetwork(
    shellGatewayIssuer({ tagging: '/tagging-api' }).application,
    serveApi(
      TaggingRecordsApi,
      HttpApiBuilder.group(TaggingRecordsApi, 'records', (group) =>
        group.handle('execute', ({ payload }) =>
          Effect.gen(function* recordRead() {
            reads.push(payload);
            if (reads.length === 2) {
              yield* Deferred.succeed(reloaded, true);
            }
            return emptyTags;
          }),
        ),
      ),
    ),
  );

  return Effect.gen(function* scopedEmployeeTags() {
    yield* pinTestDocument;
    employeeTagsData.invalidate();
    yield* employeeTagsData.preload('company-a');
    expect(reads).toHaveLength(1);
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        employeeTagsData.subscribe(() => {
          employeeTagsData.snapshot('company-a');
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['party-registry'] } }));
    yield* Effect.sleep('10 millis');
    expect(reads).toHaveLength(1);
    window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['tagging'] } }));
    yield* Deferred.await(reloaded);
    yield* employeeTagsData.read('company-a');
    expect(reads).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(network));
});
