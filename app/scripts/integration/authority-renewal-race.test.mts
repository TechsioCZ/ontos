import { createHash } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { applicationCompositionAuthority } from '../../packages/core-runtime/src/db/schema.ts';
import { ActiveApplicationCompositionSnapshotSchema } from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { canonicalizeApplicationComposition } from '../../packages/core-runtime/src/modules/application-composition.ts';
import { moduleReleaseAssetWorkerName } from '../../packages/core-runtime/src/http/module-release-identity.ts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  renewApplicationCompositionAuthoritySnapshot,
  withApplicationCompositionPublicationLock,
} from '../application-composition-authority-publication.mts';

// Run with the root integration project against an otherwise empty, migrated database, like the lane15 lifecycle test.

/** A valid snapshot of a Shell-only composition, its revision derived from its content. */
const snapshotOf = (buildMarker: string, validForMillis: number) =>
  Effect.gen(function* releaseSnapshot() {
    const assetWorker = yield* moduleReleaseAssetWorkerName('shell-super-app', buildMarker);
    const composition = {
      modules: [],
      revision: '0'.repeat(64),
      schemaVersion: '2',
      shell: {
        contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
        coreCapabilities: [{ id: 'renewal.race', version: '1' }],
        deployment: { appId: 'shell-super-app', buildMarker },
        federationManifest: {
          sha256: 'a'.repeat(64),
          url: `https://${assetWorker}.publication-test.workers.dev/mf-manifest.json`,
        },
        runtimeContract: {
          sha256: 'b'.repeat(64),
          url: `https://${assetWorker}.publication-test.workers.dev/.well-known/ontos-shell-runtime.json`,
        },
        sharedSingletons: [],
      },
    } as const;
    const now = yield* DateTime.now;
    return yield* Schema.decodeEffect(ActiveApplicationCompositionSnapshotSchema)({
      composition: {
        ...composition,
        revision: createHash('sha256').update(canonicalizeApplicationComposition(composition)).digest('hex'),
      },
      observedAt: DateTime.formatIso(now),
      validUntil: DateTime.formatIso(DateTime.add(now, { milliseconds: validForMillis })),
    });
  });

it.live('a renewal that waited for the publication lock while a newer release took over never replaces it', () =>
  Effect.scoped(
    Effect.gen(function* renewalRace() {
      const database = yield* CoreDatabase;
      // Refuse to replace or clean up somebody else's authority.
      expect(yield* database.executor.select().from(applicationCompositionAuthority)).toEqual([]);
      yield* Effect.addFinalizer(() =>
        database.executor
          .delete(applicationCompositionAuthority)
          .where(eq(applicationCompositionAuthority.authorityKey, 'active'))
          .pipe(Effect.timeout('5 seconds'), Effect.orDie),
      );
      const own = yield* snapshotOf('renewal-race-own', 7_200_000);
      const newer = yield* snapshotOf('renewal-race-newer', 3_600_000);
      const seededAt = yield* DateTime.now;
      yield* database.executor.insert(applicationCompositionAuthority).values({
        authorityKey: 'active',
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: own.composition.revision,
        subscriptionsJson: [],
        validUntil: DateTime.toDateUtc(DateTime.add(seededAt, { milliseconds: 3_600_000 })),
      });
      const activeRevision = database.executor
        .select({ revision: applicationCompositionAuthority.revision })
        .from(applicationCompositionAuthority)
        .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
      const pointerCalls = yield* Ref.make(0);
      const renew = renewApplicationCompositionAuthoritySnapshot(
        own,
        Ref.update(pointerCalls, (calls) => calls + 1),
      );

      // While this release holds the row, its renewal renews it.
      yield* renew.pipe(Effect.timeout('10 seconds'));
      expect(yield* Ref.get(pointerCalls)).toBe(1);

      // A newer release publishes (it holds the lock and replaces the row) while this release's renewal waits.
      const locked = yield* Deferred.make<true>();
      const release = yield* Deferred.make<true>();
      const newerPublication = yield* Effect.forkChild(
        withApplicationCompositionPublicationLock(
          Deferred.succeed(locked, true).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      yield* Deferred.await(locked);
      const waitingRenewal = yield* Effect.forkChild(renew.pipe(Effect.exit));
      yield* Effect.sleep('300 millis');
      yield* database.executor.execute(
        sql`update core.application_composition_authority set revision = ${newer.composition.revision} where authority_key = 'active'`,
        'objects',
      );
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(newerPublication);
      const outcome = yield* Fiber.join(waitingRenewal).pipe(Effect.timeout('10 seconds'));
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(yield* Ref.get(pointerCalls)).toBe(1);
      expect((yield* activeRevision)[0]?.revision).toBe(newer.composition.revision);
    }).pipe(Effect.timeout('40 seconds')),
  ).pipe(Effect.provide(Layer.mergeAll(ApplicationCompositionAuthorityAdminDatabaseLive, NodeServices.layer))),
);
