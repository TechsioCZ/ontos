import { createHash, randomUUID } from 'node:crypto';

import { eq, inArray, sql } from 'drizzle-orm';
import { DateTime, Deferred, Effect, Exit, Fiber, Ref, Schedule, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
} from '../../packages/core-runtime/src/db/schema.ts';
import { ActiveApplicationCompositionSnapshotSchema } from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  ApplicationCompositionAuthorityError,
  lockApplicationCompositionAuthority,
} from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { canonicalizeApplicationComposition } from '../../packages/core-runtime/src/modules/application-composition.ts';
import { moduleReleaseAssetWorkerName } from '../../packages/core-runtime/src/http/module-release-identity.ts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  publishApplicationCompositionAuthoritySnapshot,
  runApplicationCompositionMigration,
} from '../application-composition-authority-publication.mts';

// Run with the existing root integration project against an otherwise empty, migrated parity DB.
// This proves the publication protocol, not an owner effect or the deployable recovery host.
// The owner-local companion owns those journal/provider assertions. No private owner imports here.
const owner = 'lane15.lifecycle';
const initialCutoverMustNotRun = Effect.die('Lane 15 seeded an existing authority');

it.live('lane15 preserves the fence across cancellation, seal failure, retry and replacement publication', () =>
  Effect.scoped(
    Effect.gen(function* publicationCrashBoundaries() {
      const database = yield* CoreDatabase;
      // Refuse to replace or clean up somebody else's authority.
      expect(yield* database.executor.select().from(applicationCompositionAuthority)).toEqual([]);
      const originalRevision = createHash('sha256').update(randomUUID()).digest('hex');
      const seededAt = yield* DateTime.now;
      const workId = `lane15:${randomUUID()}`;
      const deniedWorkId = `lane15:${randomUUID()}`;
      yield* Effect.addFinalizer(() =>
        database.executor
          .delete(applicationCompositionAuthority)
          .where(eq(applicationCompositionAuthority.revision, originalRevision))
          .pipe(Effect.timeout('5 seconds'), Effect.orDie),
      );
      yield* database.executor.insert(applicationCompositionAuthority).values({
        authorityKey: 'active',
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: originalRevision,
        subscriptionsJson: [],
        validUntil: DateTime.toDateUtc(DateTime.add(seededAt, { milliseconds: 3_600_000 })),
      });
      yield* Effect.addFinalizer(() =>
        database.executor
          .delete(applicationCompositionDurableWork)
          .where(inArray(applicationCompositionDurableWork.workId, [workId, deniedWorkId]))
          .pipe(Effect.timeout('5 seconds'), Effect.orDie),
      );
      const track = (id: string, outstanding: boolean) =>
        database.executor.execute(
          sql`select core.track_application_composition_durable_work(${owner}, ${originalRevision}, ${id}, ${outstanding})`,
          'objects',
        );
      const authority = database.executor.select().from(applicationCompositionAuthority);
      yield* track(workId, true);
      const migrationCalls = yield* Ref.make(0);
      const migration = Ref.update(migrationCalls, (calls) => calls + 1);
      const blocked = yield* runApplicationCompositionMigration(migration, initialCutoverMustNotRun).pipe(
        Effect.forkChild,
      );
      yield* authority.pipe(
        Effect.repeat({
          schedule: Schedule.spaced('10 millis'),
          until: (rows) => rows[0]?.durableWorkAdmission === 'closed',
        }),
        Effect.timeout('5 seconds'),
      );
      expect(yield* Ref.get(migrationCalls)).toBe(0);
      expect((yield* authority)[0]).toMatchObject({
        durableWorkAdmission: 'closed',
        phase: 'active',
        revision: originalRevision,
      });
      // Negative control: a fresh obligation cannot enter after closure.
      expect(Exit.isFailure(yield* track(deniedWorkId, true).pipe(Effect.exit))).toBe(true);
      expect(
        yield* database.executor
          .select()
          .from(applicationCompositionDurableWork)
          .where(eq(applicationCompositionDurableWork.workId, deniedWorkId)),
      ).toEqual([]);
      yield* Fiber.interrupt(blocked).pipe(Effect.timeout('3 seconds'));
      // Cancellation cannot count an unresolved obligation as settled or reopen admission.
      expect(yield* Ref.get(migrationCalls)).toBe(0);
      expect((yield* authority)[0]).toMatchObject({ durableWorkAdmission: 'closed', phase: 'active' });
      expect(
        yield* database.executor
          .select()
          .from(applicationCompositionDurableWork)
          .where(eq(applicationCompositionDurableWork.workId, workId)),
      ).toHaveLength(1);

      // Positive control for the marker contract only. This is not a fabricated owner readback.
      yield* track(workId, false);
      const enteredAfterSeal = yield* Deferred.make<boolean>();
      const interrupted = yield* runApplicationCompositionMigration(
        Deferred.succeed(enteredAfterSeal, true).pipe(Effect.andThen(Effect.never)),
        initialCutoverMustNotRun,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(enteredAfterSeal).pipe(Effect.timeout('5 seconds'));
      expect((yield* authority)[0]).toMatchObject({
        durableWorkAdmission: 'closed',
        phase: 'sealed',
        revision: originalRevision,
      });
      yield* Fiber.interrupt(interrupted).pipe(Effect.timeout('3 seconds'));
      expect((yield* authority)[0]?.phase).toBe('sealed');
      const injectedFailure = new ApplicationCompositionAuthorityError({
        code: 'application_composition_authority_unavailable',
        reason: 'lane15 failure after seal before completion',
      });
      expect(
        yield* runApplicationCompositionMigration(Effect.fail(injectedFailure), initialCutoverMustNotRun).pipe(
          Effect.flip,
        ),
      ).toBe(injectedFailure);
      expect((yield* authority)[0]?.phase).toBe('sealed');
      // This retry also proves both interrupted invocations released the publication lock.
      yield* runApplicationCompositionMigration(migration, initialCutoverMustNotRun).pipe(Effect.timeout('5 seconds'));
      expect(yield* Ref.get(migrationCalls)).toBe(1);
      expect((yield* authority)[0]).toMatchObject({ durableWorkAdmission: 'closed', phase: 'migrated' });
      expect(
        Exit.isFailure(
          yield* runApplicationCompositionMigration(migration, initialCutoverMustNotRun).pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(yield* Ref.get(migrationCalls)).toBe(1);

      const assetWorker = yield* moduleReleaseAssetWorkerName('shell-super-app', 'lane15-lifecycle-build');
      const composition = {
        modules: [],
        revision: '0'.repeat(64),
        schemaVersion: '2',
        shell: {
          contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
          coreCapabilities: [{ id: 'lane15.lifecycle', version: '1' }],
          deployment: { appId: 'shell-super-app', buildMarker: 'lane15-lifecycle-build' },
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
      const replacement = yield* Schema.decodeEffect(ActiveApplicationCompositionSnapshotSchema)({
        composition: {
          ...composition,
          revision: createHash('sha256').update(canonicalizeApplicationComposition(composition)).digest('hex'),
        },
        observedAt: DateTime.formatIso(now),
        validUntil: DateTime.formatIso(DateTime.add(now, { milliseconds: 7_200_000 })),
      });
      yield* Effect.addFinalizer(() =>
        database.executor
          .delete(applicationCompositionAuthority)
          .where(eq(applicationCompositionAuthority.revision, replacement.composition.revision))
          .pipe(Effect.timeout('5 seconds'), Effect.orDie),
      );
      const pointerCalls = yield* Ref.make(0);
      yield* publishApplicationCompositionAuthoritySnapshot(
        replacement,
        Ref.update(pointerCalls, (calls) => calls + 1),
        initialCutoverMustNotRun,
      ).pipe(Effect.timeout('5 seconds'));
      expect(yield* Ref.get(pointerCalls)).toBe(1);
      expect((yield* authority)[0]).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: replacement.composition.revision,
      });
      const retiredWrite = yield* database.executor
        .transaction((transaction) => lockApplicationCompositionAuthority(transaction, originalRevision, 'write'))
        .pipe(Effect.exit);
      expect(Exit.isFailure(retiredWrite)).toBe(true);
      yield* database.executor.transaction((transaction) =>
        lockApplicationCompositionAuthority(transaction, replacement.composition.revision, 'write'),
      );
    }).pipe(Effect.timeout('25 seconds')),
  ).pipe(Effect.provide(ApplicationCompositionAuthorityAdminDatabaseLive)),
);
