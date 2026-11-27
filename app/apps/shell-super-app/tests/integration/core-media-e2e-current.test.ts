import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { templateDatabaseLayer } from '../support/access-admin-real-gate-fixture.ts';
import { MEDIA_CAPABILITIES, withMediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import type { E2eActor, MediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import {
  bytesOf,
  currentOf,
  digestOf,
  downloadOf,
  failureTagOf,
  metadataOf,
  needed,
  patternBytes,
  putBytes,
  refOf,
  requireFaultInjection,
  reserve,
  rowsOf,
  textOf,
} from '../support/core-media-e2e-steps.ts';

/*
 * EVIDENCE: INTEGRATION EXECUTED on the real composition (#1446, rows 6-7 of the #1428 minimal acceptance, Core side):
 * the Core owner Current V1 read (`core.media.asset-current.read`) through the governed Read runtime, over a cloned
 * PostgreSQL, the integration SpiceDB (grants are the real people commands) and the real S3 adapter on an
 * S3-compatible EMULATOR (MinIO, NOT R2). The Shell receiver that serves this read to Catalog, and Catalog's own
 * assignments, are covered by the sibling suite and its NOT VERIFIED rows.
 */

const platform = {
  makeActionRepository,
  makeActionRuntime,
  makeCompositionSnapshot,
  makeReadRuntime,
  makeShellAuthenticationApiRuntime,
};

const uploaderCapabilities = [MEDIA_CAPABILITIES.upload, MEDIA_CAPABILITIES.confirm];

const person = (world: MediaE2eWorld, name: string): E2eActor => {
  const actor = world.people.get(name);
  if (actor === undefined) {
    throw new Error(`The world has no ${name}`);
  }
  return actor;
};

const readyAsset = Effect.fn('CoreMediaE2e.readyCurrentAsset')(function* readyAsset(
  world: MediaE2eWorld,
  edge: Effect.Success<MediaE2eWorld['shell']>,
  bytes: Uint8Array<ArrayBuffer>,
  key: string,
) {
  const uploader = person(world, 'uploader');
  const id = (yield* reserve(world, uploader, bytes, { idempotencyKey: key })).mediaAssetRef.resourceId;
  expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(200);
  return id;
});

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '600 seconds' })(
  'Core Media end to end: the owner Current V1 (rows 6-7, Core side)',
  (suite) => {
    suite.effect(
      'row 6: an authorized, confirmed asset has exactly one Current V1, revision 1, with its exact identity; a new upload creates no V2 and moves nothing',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* currentV1() {
              const uploader = person(world, 'uploader');
              const asker = person(world, 'currentOnly');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(asker, [MEDIA_CAPABILITIES.current]);
              const edge = yield* world.shell;
              const first = bytesOf('the first asset');
              const second = bytesOf('the second and different asset');
              const a = yield* readyAsset(world, edge, first, 'current-a');
              const b = yield* readyAsset(world, edge, second, 'current-b');
              const refA = refOf(world.tenantId, a);
              const refB = refOf(world.tenantId, b);

              // Two distinct assets in one request: each ref is answered by its own entry, in request order.
              const answer = yield* currentOf(world, asker, [refA, refB]);
              expect(answer.entries).toEqual([
                { current: { resourceRef: refA, revision: 1 }, kind: 'AVAILABLE', resourceRef: refA },
                { current: { resourceRef: refB, revision: 1 }, kind: 'AVAILABLE', resourceRef: refB },
              ]);
              // Reversed, the answers are reversed: an identity is never swapped for another.
              const reversed = yield* currentOf(world, asker, [refB, refA]);
              expect(reversed.entries.map(({ resourceRef }) => resourceRef.resourceId)).toEqual([b, a]);
              // No revisionId, no storage value, no V2 anywhere in the answer.
              const text = JSON.stringify(answer);
              expect(text).not.toMatch(/revisionId|storage|s3:|core-media\/v1|"revision":2/u);

              // The Current capability grants no metadata and no bytes of its own.
              expect((yield* metadataOf(edge, asker, a)).status).toBe(403);
              expect((yield* downloadOf(edge, asker, a)).status).toBe(403);

              // Later uploads change nothing about A: the same answer, the same bytes, and no version store exists.
              yield* readyAsset(world, edge, bytesOf('a third upload'), 'current-c');
              expect((yield* currentOf(world, asker, [refA])).entries).toEqual([answer.entries[0]]);
              const owner = person(world, 'owner');
              expect((yield* downloadOf(edge, owner, a)).bytes).toEqual(first);
              const stores = yield* world.admin
                .unsafe<{ readonly table_name: string }>(
                  `select table_name from information_schema.tables where table_schema = 'core'
                      and (table_name ilike '%document%' or table_name ilike '%version%' or table_name ilike '%revision%current%')`,
                )
                .pipe(Effect.orDie);
              expect(stores.map(({ table_name }) => table_name)).toEqual([]);
              // No link or assignment appeared by itself: an upload targets nothing.
              const links = yield* world.admin
                .unsafe<{ readonly count: string }>('select count(*)::text as count from core.media_links')
                .pipe(Effect.orDie);
              expect(links[0]?.count).toBe('0');
              expect(yield* rowsOf(world)).toHaveLength(3);
            }),
          ),
        ),
    );

    suite.effect(
      'row 7: a refused, absent, foreign, unconfirmed, size-changed or unreachable asset is never AVAILABLE, and each kind keeps its own meaning (CONTROLLED FAULT INJECTION: provider unreachable, out-of-band size change)',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* neverAvailable() {
              const { faults } = yield* requireFaultInjection(ctx, world);
              const uploader = person(world, 'uploader');
              const asker = person(world, 'currentOnly');
              const outsider = person(world, 'outsider');
              const foreignOwner = yield* needed(world.foreign.get('owner'), 'foreign owner');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(asker, [MEDIA_CAPABILITIES.current]);
              const edge = yield* world.shell;
              const bytes = patternBytes(4099);
              const ready = yield* readyAsset(world, edge, bytes, 'never-ready');
              const reserved = (yield* reserve(world, uploader, bytesOf('never uploaded'), {
                idempotencyKey: 'never-reserved',
              })).mediaAssetRef.resourceId;
              const unknown = '8d0e5b0e-2c61-4f43-a5a3-5f7b3c0d9a11';
              const refs = [ready, reserved, unknown].map((id) => refOf(world.tenantId, id));

              const kinds = (yield* currentOf(world, asker, refs)).entries.map(({ kind }) => kind);
              expect(kinds).toEqual(['AVAILABLE', 'CURRENT_UNVERIFIED', 'ABSENT']);

              // A foreign tenant's ref is the answer an unknown id gets, and its own person cannot read this tenant's.
              const foreignAsk = yield* currentOf(world, foreignOwner, [refOf(foreignOwner.tenantId, ready)]);
              expect(foreignAsk.entries.map(({ kind }) => kind)).toEqual(['ABSENT']);

              // Without the capability the whole call is refused: no entry, hence nothing available.
              expect(yield* failureTagOf(currentOf(world, outsider, refs.slice(0, 1)))).toBe('ReadPermissionDenied');

              // The provider cannot be reached: UNAVAILABLE for the ready asset, never AVAILABLE and never ABSENT.
              faults.setRules([{ fault: { kind: 'reset-before' }, method: 'HEAD', times: 50 }]);
              const outage = yield* currentOf(world, asker, refs.slice(0, 1));
              faults.setRules([]);
              expect(outage.entries.map(({ kind }) => kind)).toEqual(['UNAVAILABLE']);

              // The stored object is replaced by another size: Current no longer vouches for the asset.
              yield* world.replaceStoredObject(ready, bytesOf('x'.repeat(10)));
              const corrupt = yield* currentOf(world, asker, refs.slice(0, 1));
              expect(corrupt.entries.map(({ kind }) => kind)).toEqual(['CURRENT_UNVERIFIED']);
              expect(textOf(new TextEncoder().encode(JSON.stringify(corrupt)))).not.toContain(digestOf(bytes));
            }),
          ),
        ),
    );

    suite.effect(
      'row 7: SpiceDB UNAVAILABLE refuses the Current read as a whole (CONTROLLED FAULT INJECTION: engine partition)',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* engineDown() {
              const injection = yield* requireFaultInjection(ctx, world);
              const uploader = person(world, 'uploader');
              const asker = person(world, 'currentOnly');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(asker, [MEDIA_CAPABILITIES.current]);
              const edge = yield* world.shell;
              const id = yield* readyAsset(world, edge, bytesOf('current needs the engine'), 'engine-current');
              injection.engine.setDown(true);
              const unavailable = yield* failureTagOf(currentOf(world, asker, [refOf(world.tenantId, id)]));
              injection.engine.setDown(false);
              expect(unavailable).toBe('ReadPermissionUnavailable');
            }),
          ),
        ),
    );
  },
);
