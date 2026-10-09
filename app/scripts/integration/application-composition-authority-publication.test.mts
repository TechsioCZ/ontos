import { createHash, randomUUID } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  Config,
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Ref,
  Schedule,
  Schema,
} from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import { CoreDatabase, makeCoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { parseDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  domainEvents,
  outboxDeliveries,
  outboxMessages,
  tenants,
} from '../../packages/core-runtime/src/db/schema.ts';
import { moduleReleaseAssetWorkerName } from '../../packages/core-runtime/src/http/module-release-identity.ts';
import { ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY } from '../../packages/core-runtime/src/modules/active-application-composition-edge.ts';
import { ActiveApplicationCompositionSnapshotSchema } from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  ApplicationCompositionAuthorityError,
  isApplicationCompositionDurableWorkDrained,
  isApplicationCompositionWorkDrained,
  lockApplicationCompositionAuthority,
} from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { canonicalizeApplicationComposition } from '../../packages/core-runtime/src/modules/application-composition.ts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  publishApplicationCompositionAuthoritySnapshot,
  resumeApplicationCompositionDurableWork,
  runApplicationCompositionMigration,
} from '../application-composition-authority-publication.mts';
import {
  InitialCutoverProviderError,
  verifyInitialCutoverProviderInventory,
} from '../initial-composition-cutover-provider.mts';
import { publishSnapshot } from '../publish-active-application-composition.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';

const PENDING_TOPIC = 'publication.pending';
const PRODUCER_MODULE = 'publication.test';
const LEGACY_ACCOUNT_ID = 'a'.repeat(32);
const LEGACY_NODE_PATH = '/api/rest/public/service-stack/publication-legacy-node';
const LEGACY_WORKER_PATH = `/client/v4/accounts/${LEGACY_ACCOUNT_ID}/workers/scripts/publication-legacy-worker`;
const KV_NAMESPACE_ID = 'c'.repeat(32);
const KV_NAMESPACE_PATH = `/client/v4/accounts/${LEGACY_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}`;
const KV_VALUE_PATH = `${KV_NAMESPACE_PATH}/values/${ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY}`;
const KV_URL = `https://api.cloudflare.com${KV_VALUE_PATH}`;
const INITIAL_INVENTORY = {
  cloudflare: {
    accountId: LEGACY_ACCOUNT_ID,
    compositionPointer: {
      namespaceId: KV_NAMESPACE_ID,
      sha256: createHash('sha256').update('obsolete composition pointer bytes').digest('hex'),
    },
    workerNames: ['publication-legacy-worker'],
  },
  zeropsServiceIds: ['publication-legacy-node'],
};

const initialCutoverProvider = (nodeStatus: string | undefined, workerPresent: boolean) => {
  const requests: string[] = [];
  const client = HttpClient.make((request, url) => {
    requests.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.pathname === LEGACY_NODE_PATH) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          nodeStatus === undefined
            ? Response.json({ error: { code: 'serviceStackNotFound' } }, { status: 400 })
            : Response.json({ name: 'publication-legacy-node', status: nodeStatus, subdomainAccess: false }),
        ),
      );
    }
    if (url.pathname === LEGACY_WORKER_PATH) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          workerPresent
            ? new Response('old Worker executable bytes')
            : Response.json({ errors: [{ code: 10_007 }], success: false }, { status: 404 }),
        ),
      );
    }
    if (url.pathname === KV_NAMESPACE_PATH || url.pathname === KV_VALUE_PATH) {
      expect(request.method).toBe('GET');
      expect(url.href).toBe(`https://api.cloudflare.com${url.pathname}`);
      expect(request.headers.authorization).toBe('Bearer publication-test-cloudflare-token');
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          url.pathname === KV_NAMESPACE_PATH
            ? Response.json({ errors: [], result: { id: KV_NAMESPACE_ID }, success: true })
            : new Response(null, { status: 404 }),
        ),
      );
    }
    return Effect.die(`Unexpected initial cutover provider request: ${url.pathname}`);
  });
  const http = Layer.succeed(HttpClient.HttpClient, client);
  return {
    proof: verifyInitialCutoverProviderInventory(INITIAL_INVENTORY).pipe(
      Effect.provide(
        Layer.mergeAll(
          http,
          ZeropsPublicApiLive.pipe(Layer.provide(http)),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CLOUDFLARE_API_TOKEN: 'publication-test-cloudflare-token',
              ZEROPS_TOKEN: 'publication-test-zerops-token',
            }),
          ),
        ),
      ),
    ),
    requests,
  };
};

const skipInitialProof = Effect.die('An existing authority must not reverify the initial cutover');

const snapshot = Effect.fn(function* snapshot(label: string, freshenByMs: number) {
  const now = yield* DateTime.now;
  const shellAssetWorker = yield* moduleReleaseAssetWorkerName('shell-super-app', 'publication-shell-build');
  const composition = {
    modules: [],
    revision: '0'.repeat(64),
    schemaVersion: '2',
    shell: {
      contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
      coreCapabilities: [{ id: `publication.${label}`, version: '1' }],
      deployment: { appId: 'shell-super-app', buildMarker: 'publication-shell-build' },
      federationManifest: {
        sha256: 'a'.repeat(64),
        url: `https://${shellAssetWorker}.publication-test.workers.dev/mf-manifest.json`,
      },
      runtimeContract: {
        sha256: 'b'.repeat(64),
        url: `https://${shellAssetWorker}.publication-test.workers.dev/.well-known/ontos-shell-runtime.json`,
      },
      sharedSingletons: [],
    },
  } as const;
  return yield* Schema.decodeEffect(ActiveApplicationCompositionSnapshotSchema)({
    composition: {
      ...composition,
      revision: createHash('sha256').update(canonicalizeApplicationComposition(composition)).digest('hex'),
    },
    observedAt: DateTime.formatIso(now),
    validUntil: DateTime.formatIso(DateTime.add(now, { milliseconds: 3_600_000 + freshenByMs })),
  });
});

it.live(
  'native publication commits draining, blocks unresolved work, rolls back failed pointers, and serializes publishers',
  () =>
    Effect.gen(function* provesPublicationProtocol() {
      const database = yield* CoreDatabase;
      const [runtimeUrl, adminUrl] = yield* Effect.all([
        Config.String('DATABASE_URL'),
        Config.String('DATABASE_ADMIN_URL'),
      ]);
      const connections = yield* parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: adminUrl,
        DATABASE_URL: runtimeUrl,
      });
      const observer = yield* makeCoreDatabase(connections.admin);
      const existing = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(existing).toEqual([]);
      yield* Effect.addFinalizer(() =>
        observer.executor
          .delete(applicationCompositionAuthority)
          .where(eq(applicationCompositionAuthority.authorityKey, 'active'))
          .pipe(Effect.orDie),
      );
      const first = yield* snapshot('first', 0);
      const initialPointerCalls = yield* Ref.make(0);
      for (const [nodeStatus, workerPresent] of [
        ['ACTIVE', false],
        ['STOPPED', false],
        [undefined, true],
      ] as const) {
        const provider = initialCutoverProvider(nodeStatus, workerPresent);
        const rejected = yield* publishApplicationCompositionAuthoritySnapshot(
          first,
          Ref.update(initialPointerCalls, (calls) => calls + 1),
          provider.proof,
        ).pipe(Effect.flip);
        expect(Schema.is(InitialCutoverProviderError)(rejected)).toBe(true);
        expect(rejected).toMatchObject({ provider: nodeStatus === undefined ? 'cloudflare' : 'zerops' });
        expect(yield* observer.executor.select().from(applicationCompositionAuthority)).toEqual([]);
        expect(yield* Ref.get(initialPointerCalls)).toBe(0);
      }

      const runtime = yield* makeCoreDatabase({ ...connections.runtime, maxConnections: 1 });
      const runtimeEntered = yield* Deferred.make<boolean>();
      const releaseRuntime = yield* Deferred.make<boolean>();
      yield* Effect.addFinalizer(() => Deferred.succeed(releaseRuntime, true));
      const oldRuntime = yield* runtime.executor
        .transaction((transaction) =>
          transaction
            .execute(sql`select true as started`, 'objects')
            .pipe(
              Effect.andThen(Deferred.succeed(runtimeEntered, true)),
              Effect.andThen(Deferred.await(releaseRuntime)),
            ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(runtimeEntered);
      const [idleRuntime] = yield* observer.executor.execute<{ readonly blocked: boolean }>(
        sql`select exists(select 1 from pg_stat_activity where datname = current_database() and usename = 'ontos_runtime' and state = 'idle in transaction') as blocked`,
        'objects',
      );
      expect(idleRuntime?.blocked).toBe(true);
      const quiescentProvider = initialCutoverProvider(undefined, false);
      const runtimeFailure = yield* publishApplicationCompositionAuthoritySnapshot(
        first,
        Ref.update(initialPointerCalls, (calls) => calls + 1),
        quiescentProvider.proof,
      ).pipe(Effect.flip, Effect.flatMap(Schema.decodeUnknownEffect(ApplicationCompositionAuthorityError)));
      expect(runtimeFailure.reason).toMatch(/legacy runtime transactions/u);
      expect(yield* observer.executor.select().from(applicationCompositionAuthority)).toEqual([]);
      expect(yield* Ref.get(initialPointerCalls)).toBe(0);
      yield* Deferred.succeed(releaseRuntime, true);
      yield* Fiber.join(oldRuntime);

      const runtimeBackends = yield* runtime.executor.execute<{ readonly pid: number }>(
        sql`select pg_backend_pid() as pid`,
        'objects',
      );
      const runtimeBackend = yield* Schema.decodeUnknownEffect(Schema.Struct({ pid: Schema.Number }))(
        runtimeBackends[0],
      );
      yield* Effect.addFinalizer(() =>
        observer.executor
          .execute(sql`select pg_cancel_backend(${runtimeBackend.pid})`, 'objects')
          .pipe(Effect.asVoid, Effect.orDie),
      );
      const activeRuntime = yield* runtime.executor
        .execute(sql`select pg_sleep(30)`, 'objects')
        .pipe(Effect.exit, Effect.forkChild);
      yield* observer.executor
        .execute<{ readonly blocked: boolean }>(
          sql`select exists(select 1 from pg_stat_activity where datname = current_database() and pid = ${runtimeBackend.pid} and usename = 'ontos_runtime' and state = 'active' and query like '%pg_sleep%') as blocked`,
          'objects',
        )
        .pipe(
          Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (rows) => rows[0]?.blocked ?? false }),
          Effect.timeout('5 seconds'),
        );
      const activeRuntimeFailure = yield* publishApplicationCompositionAuthoritySnapshot(
        first,
        Ref.update(initialPointerCalls, (calls) => calls + 1),
        quiescentProvider.proof,
      ).pipe(Effect.flip, Effect.flatMap(Schema.decodeUnknownEffect(ApplicationCompositionAuthorityError)));
      expect(activeRuntimeFailure.reason).toMatch(/legacy runtime transactions/u);
      expect(yield* observer.executor.select().from(applicationCompositionAuthority)).toEqual([]);
      expect(yield* Ref.get(initialPointerCalls)).toBe(0);
      yield* observer.executor.execute(sql`select pg_cancel_backend(${runtimeBackend.pid})`, 'objects');
      yield* Fiber.join(activeRuntime);

      const successfulProvider = initialCutoverProvider(undefined, false);
      const initialProof = observer.executor
        .select()
        .from(applicationCompositionAuthority)
        .pipe(
          Effect.tap((rows) => Effect.sync(() => expect(rows).toEqual([]))),
          Effect.andThen(successfulProvider.proof),
        );
      const storedPointer = yield* Ref.make(Option.none<string>());
      const rejectWrite = yield* Ref.make(false);
      const initialReadbackObserved = yield* Ref.make(false);
      const kvRequests: string[] = [];
      const kvClient = HttpClient.make((request, url) =>
        Effect.gen(function* nativeKvResponse() {
          expect(url.href).toBe(KV_URL);
          expect(request.headers.authorization).toBe('Bearer publication-native-kv-token');
          const previousMethod = kvRequests.at(-1);
          kvRequests.push(request.method);
          if (request.method === 'GET') {
            expect(request.headers['cache-control']).toBe('no-cache');
            const current = yield* Ref.get(storedPointer);
            if (previousMethod === 'PUT' && !(yield* Ref.get(initialReadbackObserved))) {
              // The initial authority must remain uncommitted through native provider readback.
              expect(
                yield* observer.executor.select().from(applicationCompositionAuthority).pipe(Effect.orDie),
              ).toEqual([]);
              yield* Ref.set(initialReadbackObserved, true);
            }
            return HttpClientResponse.fromWeb(
              request,
              Option.match(current, {
                onNone: () => new Response(null, { status: 404 }),
                onSome: (value) => new Response(value),
              }),
            );
          }
          if (request.method === 'PUT') {
            if (yield* Ref.get(rejectWrite)) {
              return HttpClientResponse.fromWeb(request, Response.json({ success: false }));
            }
            // The first authority row remains uncommitted until native provider readback succeeds.
            expect(yield* observer.executor.select().from(applicationCompositionAuthority).pipe(Effect.orDie)).toEqual(
              [],
            );
            const value = Match.value(request.body).pipe(
              Match.tag('Uint8Array', (body) => new TextDecoder().decode(body.body)),
              Match.orElse(() => ''),
            );
            expect(value).toContain(first.composition.revision);
            yield* Ref.set(storedPointer, Option.some(value));
            return HttpClientResponse.fromWeb(request, Response.json({ success: true }));
          }
          return yield* Effect.die(`Unexpected native KV method: ${request.method}`);
        }),
      );
      const nativeKvLayer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HttpClient.HttpClient, kvClient),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            CLOUDFLARE_API_TOKEN: 'publication-native-kv-token',
            ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: KV_URL,
          }),
        ),
      );
      yield* publishSnapshot(first, Option.none(), initialProof).pipe(Effect.provide(nativeKvLayer));
      expect(kvRequests).toEqual(['GET', 'PUT', 'GET']);
      expect(yield* Ref.get(initialReadbackObserved)).toBe(true);
      expect(successfulProvider.requests).toEqual(
        expect.arrayContaining([
          `GET https://api.app-prg1.zerops.io${LEGACY_NODE_PATH}`,
          `GET https://api.cloudflare.com${LEGACY_WORKER_PATH}`,
        ]),
      );
      expect(successfulProvider.requests).toHaveLength(4);
      expect(successfulProvider.requests.slice(-2)).toEqual([
        `GET https://api.cloudflare.com${KV_NAMESPACE_PATH}`,
        `GET https://api.cloudflare.com${KV_VALUE_PATH}`,
      ]);
      const [firstAuthority] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(firstAuthority).toMatchObject({ phase: 'active', revision: first.composition.revision });
      const nestedFailure = yield* database.executor
        .transaction(() => publishApplicationCompositionAuthoritySnapshot(first, Effect.void, skipInitialProof))
        .pipe(Effect.flip, Effect.flatMap(Schema.decodeUnknownEffect(ApplicationCompositionAuthorityError)));
      expect(nestedFailure.reason).toMatch(/must own its database transactions/u);

      const second = yield* snapshot('second', 10_000);
      const conflictCalls = yield* Ref.make(0);
      const equalLease = { ...second, validUntil: first.validUntil };
      const equalLeaseFailure = yield* publishApplicationCompositionAuthoritySnapshot(
        equalLease,
        Ref.update(conflictCalls, (calls) => calls + 1),
        skipInitialProof,
      ).pipe(Effect.flip, Effect.flatMap(Schema.decodeUnknownEffect(ApplicationCompositionAuthorityError)));
      expect(equalLeaseFailure.reason).toMatch(/newer freshness/u);
      expect(yield* Ref.get(conflictCalls)).toBe(0);
      const [afterConflict] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterConflict).toMatchObject({ phase: 'active', revision: first.composition.revision });
      yield* Ref.set(rejectWrite, true);
      const nativeWriteFailure = yield* publishSnapshot(second, Option.none(), skipInitialProof).pipe(
        Effect.provide(nativeKvLayer),
        Effect.flip,
      );
      expect(nativeWriteFailure).toMatchObject({ reason: 'publication_failed' });
      const [afterNativeWriteFailure] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterNativeWriteFailure).toMatchObject({ phase: 'draining', revision: first.composition.revision });
      expect(Option.getOrThrow(yield* Ref.get(storedPointer))).toContain(first.composition.revision);
      yield* Ref.set(rejectWrite, false);
      const failedPointer = new ApplicationCompositionAuthorityError({
        code: 'application_composition_authority_unavailable',
        reason: 'Injected provider failure',
      });
      const failure = yield* publishApplicationCompositionAuthoritySnapshot(
        second,
        Effect.fail(failedPointer),
        skipInitialProof,
      ).pipe(Effect.flip);
      expect(failure).toBe(failedPointer);
      const [afterFailure] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterFailure).toMatchObject({ phase: 'draining', revision: first.composition.revision });

      const renewal = { ...first, validUntil: DateTime.add(first.validUntil, { milliseconds: 5000 }) };
      yield* publishApplicationCompositionAuthoritySnapshot(renewal, Effect.void, skipInitialProof);
      const [afterRenewal] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterRenewal).toMatchObject({ phase: 'draining', revision: first.composition.revision });

      const tenantId = randomUUID();
      const eventId = randomUUID();
      const messageId = randomUUID();
      yield* observer.executor.insert(tenants).values({
        defaultLocale: 'en',
        name: 'Publication Test',
        slug: `publication-${tenantId}`,
        status: 'active',
        tenantId,
      });
      yield* Effect.addFinalizer(() =>
        observer.executor.delete(tenants).where(eq(tenants.tenantId, tenantId)).pipe(Effect.orDie),
      );
      yield* observer.executor.insert(domainEvents).values({
        domainEventId: eventId,
        eventType: PENDING_TOPIC,
        payloadJson: {},
        producerModuleKey: PRODUCER_MODULE,
        subjectModuleKey: PRODUCER_MODULE,
        subjectResourceId: messageId,
        subjectResourceType: 'publication-test',
        tenantId,
      });
      yield* Effect.addFinalizer(() =>
        observer.executor.delete(domainEvents).where(eq(domainEvents.domainEventId, eventId)).pipe(Effect.orDie),
      );
      yield* observer.executor.insert(outboxMessages).values({
        domainEventId: eventId,
        outboxMessageId: messageId,
        payloadJson: {},
        producerModuleKey: PRODUCER_MODULE,
        tenantId,
        topic: PENDING_TOPIC,
      });
      yield* Effect.addFinalizer(() =>
        observer.executor
          .delete(outboxMessages)
          .where(eq(outboxMessages.outboxMessageId, messageId))
          .pipe(Effect.orDie),
      );
      const pointerCalls = yield* Ref.make(0);
      const pendingPublisher = yield* publishApplicationCompositionAuthoritySnapshot(
        second,
        Ref.update(pointerCalls, (calls) => calls + 1),
        skipInitialProof,
      ).pipe(Effect.forkChild);
      yield* observer.executor
        .execute<{ readonly held: boolean }>(
          sql`select exists(select 1 from pg_locks join pg_stat_activity using (pid) where datname = current_database() and locktype = 'advisory' and granted and mode = 'ExclusiveLock' and query like '%ontos.application-composition-publication%') as held`,
          'objects',
        )
        .pipe(
          Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (rows) => rows[0]?.held ?? false }),
          Effect.timeout('5 seconds'),
        );
      expect(yield* Ref.get(pointerCalls)).toBe(0);
      expect(
        yield* observer.executor.transaction((transaction) =>
          isApplicationCompositionWorkDrained(transaction, first.composition.revision),
        ),
      ).toBe(false);
      const [afterPending] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterPending).toMatchObject({ phase: 'draining', revision: first.composition.revision });
      yield* Fiber.interrupt(pendingPublisher);
      yield* observer.executor.delete(outboxMessages).where(eq(outboxMessages.outboxMessageId, messageId));

      const pointerEntered = yield* Deferred.make<boolean>();
      const releasePointer = yield* Deferred.make<boolean>();
      yield* Effect.addFinalizer(() => Deferred.succeed(releasePointer, true));
      const firstPublisher = yield* publishApplicationCompositionAuthoritySnapshot(
        second,
        Deferred.succeed(pointerEntered, true).pipe(Effect.andThen(Deferred.await(releasePointer))),
        skipInitialProof,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(pointerEntered);
      const secondPublisher = yield* publishApplicationCompositionAuthoritySnapshot(
        second,
        Ref.update(pointerCalls, (calls) => calls + 1),
        skipInitialProof,
      ).pipe(Effect.forkChild);
      // Observing PostgreSQL's own wait state proves the second publisher is fenced while pointer I/O runs.
      yield* observer.executor
        .execute<{ readonly waiting: boolean }>(
          sql`select true as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory' limit 1`,
          'objects',
        )
        .pipe(
          Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (rows) => rows[0]?.waiting ?? false }),
          Effect.timeout('5 seconds'),
        );
      expect(yield* Ref.get(pointerCalls)).toBe(0);
      const [beforeCommit] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(beforeCommit).toMatchObject({ phase: 'draining', revision: first.composition.revision });
      yield* Deferred.succeed(releasePointer, true);
      yield* Fiber.join(firstPublisher);
      yield* Fiber.join(secondPublisher);
      expect(yield* Ref.get(pointerCalls)).toBe(1);
      const [promoted] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(promoted).toMatchObject({ phase: 'active', revision: second.composition.revision });

      const renewalEntered = yield* Deferred.make<boolean>();
      const releaseRenewal = yield* Deferred.make<boolean>();
      yield* Effect.addFinalizer(() => Deferred.succeed(releaseRenewal, true));
      const activeRenewal = { ...second, validUntil: DateTime.add(second.validUntil, { milliseconds: 20_000 }) };
      const renewingPublisher = yield* publishApplicationCompositionAuthoritySnapshot(
        activeRenewal,
        Deferred.succeed(renewalEntered, true).pipe(Effect.andThen(Deferred.await(releaseRenewal))),
        skipInitialProof,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(renewalEntered);
      // A delayed provider renewal must not retain the exclusive authority fence used by owner writes.
      yield* observer.executor
        .transaction((transaction) =>
          lockApplicationCompositionAuthority(transaction, second.composition.revision, 'write'),
        )
        .pipe(Effect.timeout('2 seconds'));
      const [duringRenewal] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(duringRenewal).toMatchObject({ phase: 'active', revision: second.composition.revision });
      expect(duringRenewal?.validUntil.getTime()).toBe(DateTime.toEpochMillis(second.validUntil));
      const third = yield* snapshot('third', 40_000);
      const thirdCalls = yield* Ref.make(0);
      const replacementPublisher = yield* publishApplicationCompositionAuthoritySnapshot(
        third,
        Ref.update(thirdCalls, (calls) => calls + 1),
        skipInitialProof,
      ).pipe(Effect.forkChild);
      yield* observer.executor
        .execute<{ readonly waiting: boolean }>(
          sql`select true as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory' limit 1`,
          'objects',
        )
        .pipe(
          Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (rows) => rows[0]?.waiting ?? false }),
          Effect.timeout('5 seconds'),
        );
      expect(yield* Ref.get(thirdCalls)).toBe(0);
      yield* Deferred.succeed(releaseRenewal, true);
      yield* Fiber.join(renewingPublisher);
      yield* Fiber.join(replacementPublisher);
      expect(yield* Ref.get(thirdCalls)).toBe(1);

      const fourth = yield* snapshot('fourth', 60_000);
      const interruptionEntered = yield* Deferred.make<boolean>();
      const interruptedPublisher = yield* publishApplicationCompositionAuthoritySnapshot(
        fourth,
        Deferred.succeed(interruptionEntered, true).pipe(Effect.andThen(Effect.never)),
        skipInitialProof,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(interruptionEntered);
      yield* Fiber.interrupt(interruptedPublisher);
      const [afterInterruption] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterInterruption).toMatchObject({ phase: 'draining', revision: third.composition.revision });
      yield* observer.executor
        .transaction((transaction) =>
          lockApplicationCompositionAuthority(transaction, third.composition.revision, 'match'),
        )
        .pipe(Effect.timeout('2 seconds'));
      // Retrying after cancellation also proves the independent publication lock was released.
      yield* publishApplicationCompositionAuthoritySnapshot(fourth, Effect.void, skipInitialProof).pipe(
        Effect.timeout('5 seconds'),
      );
      const [afterRetry] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterRetry).toMatchObject({ phase: 'active', revision: fourth.composition.revision });

      const durableWorkId = randomUUID();
      const rejectedDurableWorkId = randomUUID();
      yield* Effect.addFinalizer(() =>
        observer.executor
          .delete(applicationCompositionDurableWork)
          .where(inArray(applicationCompositionDurableWork.workId, [durableWorkId, rejectedDurableWorkId]))
          .pipe(Effect.orDie),
      );
      yield* observer.executor.execute(
        sql`select core.track_application_composition_durable_work(${PRODUCER_MODULE}, ${fourth.composition.revision}, ${durableWorkId}, true)`,
        'objects',
      );
      const migrationCalls = yield* Ref.make(0);
      const waitingForDurableWork = yield* runApplicationCompositionMigration(
        Ref.update(migrationCalls, (calls) => calls + 1),
        skipInitialProof,
      ).pipe(Effect.forkChild);
      yield* observer.executor
        .select({
          durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
          phase: applicationCompositionAuthority.phase,
        })
        .from(applicationCompositionAuthority)
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced('10 millis'),
            until: (rows) => rows[0]?.phase === 'active' && rows[0]?.durableWorkAdmission === 'closed',
          }),
          Effect.timeout('5 seconds'),
        );
      expect(yield* Ref.get(migrationCalls)).toBe(0);
      const [beforeDurableWorkFinished] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(beforeDurableWorkFinished).toMatchObject({
        durableWorkAdmission: 'closed',
        phase: 'active',
        revision: fourth.composition.revision,
      });
      expect(
        yield* observer.executor.transaction((transaction) =>
          isApplicationCompositionDurableWorkDrained(transaction, fourth.composition.revision),
        ),
      ).toBe(false);
      const rejectedNewWork = yield* observer.executor
        .execute(
          sql`select core.track_application_composition_durable_work(${PRODUCER_MODULE}, ${fourth.composition.revision}, ${rejectedDurableWorkId}, true)`,
          'objects',
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(rejectedNewWork)).toBe(true);
      expect(
        yield* observer.executor
          .select()
          .from(applicationCompositionDurableWork)
          .where(eq(applicationCompositionDurableWork.workId, rejectedDurableWorkId)),
      ).toEqual([]);
      for (const operation of ['read', 'write'] as const) {
        yield* runtime.executor
          .transaction((transaction) =>
            lockApplicationCompositionAuthority(transaction, fourth.composition.revision, operation),
          )
          .pipe(Effect.timeout('2 seconds'));
      }
      yield* Fiber.interrupt(waitingForDurableWork);
      const closedRenewal = { ...fourth, validUntil: DateTime.add(fourth.validUntil, { milliseconds: 1000 }) };
      yield* publishApplicationCompositionAuthoritySnapshot(closedRenewal, Effect.void, skipInitialProof);
      const [afterClosedRenewal] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterClosedRenewal).toMatchObject({ durableWorkAdmission: 'closed', phase: 'active' });
      yield* resumeApplicationCompositionDurableWork(fourth.composition.revision).pipe(Effect.timeout('2 seconds'));
      const [afterAdmissionResume] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterAdmissionResume).toMatchObject({ durableWorkAdmission: 'open', phase: 'active' });
      yield* observer.executor.execute(
        sql`select core.track_application_composition_durable_work(${PRODUCER_MODULE}, ${fourth.composition.revision}, ${rejectedDurableWorkId}, true)`,
        'objects',
      );
      yield* observer.executor.execute(
        sql`select core.track_application_composition_durable_work(${PRODUCER_MODULE}, ${fourth.composition.revision}, ${rejectedDurableWorkId}, false)`,
        'objects',
      );

      yield* observer.executor.insert(outboxMessages).values({
        domainEventId: eventId,
        outboxMessageId: messageId,
        payloadJson: {},
        producerModuleKey: PRODUCER_MODULE,
        tenantId,
        topic: PENDING_TOPIC,
      });
      const migrationStatuses = ['pending', 'processing', 'dead'] as const;
      const migrationNow = yield* DateTime.nowAsDate;
      yield* observer.executor.insert(outboxDeliveries).values(
        migrationStatuses.map((status) => ({
          availableAt: new Date(migrationNow.getTime() + 3_600_000),
          consumerModuleKey: PRODUCER_MODULE,
          outboxDeliveryId: randomUUID(),
          outboxMessageId: messageId,
          status,
          workerKey: `publication.migration-${status}`,
        })),
      );
      const migrationColumn = `publication_${randomUUID().replaceAll('-', '')}`;
      yield* Effect.addFinalizer(() =>
        observer.executor
          .execute(
            sql`alter table ${applicationCompositionAuthority} drop column if exists ${sql.identifier(migrationColumn)}`,
            'objects',
          )
          .pipe(Effect.asVoid, Effect.orDie),
      );
      const migrationEntered = yield* Deferred.make<boolean>();
      const releaseMigration = yield* Deferred.make<boolean>();
      yield* Effect.addFinalizer(() => Deferred.succeed(releaseMigration, true));
      const injectedMigrationFailure = new ApplicationCompositionAuthorityError({
        code: 'application_composition_authority_unavailable',
        reason: 'Injected migration failure after native ALTER',
      });
      const migratingPublisher = yield* runApplicationCompositionMigration(
        Effect.gen(function* alterSealedAuthority() {
          yield* Ref.update(migrationCalls, (calls) => calls + 1);
          const [sealed] = yield* observer.executor.select().from(applicationCompositionAuthority);
          expect(sealed).toMatchObject({ phase: 'sealed', revision: fourth.composition.revision });
          // A reserved session must hold the common lock without an outer transaction retaining
          // AccessShare on this table. This real incompatible ALTER would otherwise self-deadlock.
          yield* observer.executor
            .execute(
              sql`alter table ${applicationCompositionAuthority} add column ${sql.identifier(migrationColumn)} boolean`,
              'objects',
            )
            .pipe(Effect.timeout('5 seconds'));
          yield* Deferred.succeed(migrationEntered, true);
          yield* Deferred.await(releaseMigration);
          return yield* Effect.fail(injectedMigrationFailure);
        }),
        skipInitialProof,
      ).pipe(Effect.flip, Effect.forkChild);
      yield* observer.executor
        .select({ durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission })
        .from(applicationCompositionAuthority)
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced('10 millis'),
            until: (rows) => rows[0]?.durableWorkAdmission === 'closed',
          }),
          Effect.timeout('5 seconds'),
        );
      expect(yield* Ref.get(migrationCalls)).toBe(0);
      yield* observer.executor.execute(
        sql`select core.track_application_composition_durable_work(${PRODUCER_MODULE}, ${fourth.composition.revision}, ${durableWorkId}, false)`,
        'objects',
      );
      yield* observer.executor
        .select({ phase: applicationCompositionAuthority.phase })
        .from(applicationCompositionAuthority)
        .pipe(
          Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (rows) => rows[0]?.phase === 'draining' }),
          Effect.timeout('5 seconds'),
        );
      expect(yield* Ref.get(migrationCalls)).toBe(0);
      expect(
        yield* observer.executor.transaction((transaction) =>
          isApplicationCompositionWorkDrained(transaction, fourth.composition.revision),
        ),
      ).toBe(false);
      yield* observer.executor
        .update(outboxMessages)
        .set({ matchedAt: migrationNow })
        .where(eq(outboxMessages.outboxMessageId, messageId));
      for (const status of migrationStatuses) {
        expect(
          yield* observer.executor.transaction((transaction) =>
            isApplicationCompositionWorkDrained(transaction, fourth.composition.revision),
          ),
        ).toBe(false);
        expect(yield* Ref.get(migrationCalls)).toBe(0);
        yield* observer.executor
          .update(outboxDeliveries)
          .set({ status: 'done' })
          .where(
            and(
              eq(outboxDeliveries.outboxMessageId, messageId),
              eq(outboxDeliveries.workerKey, `publication.migration-${status}`),
            ),
          );
      }
      yield* Deferred.await(migrationEntered).pipe(Effect.timeout('10 seconds'));
      expect(yield* Ref.get(migrationCalls)).toBe(1);
      for (const operation of ['read', 'write', 'match', 'worker'] as const) {
        const sealedAdmission = yield* runtime.executor
          .transaction((transaction) =>
            lockApplicationCompositionAuthority(transaction, fourth.composition.revision, operation),
          )
          .pipe(Effect.flip);
        expect(Schema.is(ApplicationCompositionAuthorityError)(sealedAdmission)).toBe(true);
      }

      const fifth = yield* snapshot('fifth', 80_000);
      const afterMigrationPointerCalls = yield* Ref.make(0);
      const waitingForMigration = yield* publishApplicationCompositionAuthoritySnapshot(
        fifth,
        Ref.update(afterMigrationPointerCalls, (calls) => calls + 1),
        skipInitialProof,
      ).pipe(Effect.flip, Effect.forkChild);
      yield* observer.executor
        .execute<{ readonly waiting: boolean }>(
          sql`select true as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory' limit 1`,
          'objects',
        )
        .pipe(
          Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (rows) => rows[0]?.waiting ?? false }),
          Effect.timeout('5 seconds'),
        );
      expect(yield* Ref.get(afterMigrationPointerCalls)).toBe(0);
      yield* Deferred.succeed(releaseMigration, true);
      expect(yield* Fiber.join(migratingPublisher)).toBe(injectedMigrationFailure);
      expect(Schema.is(ApplicationCompositionAuthorityError)(yield* Fiber.join(waitingForMigration))).toBe(true);
      expect(yield* Ref.get(afterMigrationPointerCalls)).toBe(0);
      const [afterMigrationFailure] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterMigrationFailure).toMatchObject({ phase: 'sealed', revision: fourth.composition.revision });

      const sealedRenewal = { ...fourth, validUntil: DateTime.add(fourth.validUntil, { milliseconds: 5000 }) };
      yield* publishApplicationCompositionAuthoritySnapshot(sealedRenewal, Effect.void, skipInitialProof);
      const [afterSealedRenewal] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterSealedRenewal).toMatchObject({
        durableWorkAdmission: 'closed',
        phase: 'sealed',
        revision: fourth.composition.revision,
      });
      const migrationResult = yield* runApplicationCompositionMigration(
        observer.executor
          .execute(
            sql`alter table ${applicationCompositionAuthority} alter column ${sql.identifier(migrationColumn)} set default true`,
            'objects',
          )
          .pipe(Effect.timeout('5 seconds'), Effect.as('migration-complete')),
        skipInitialProof,
      );
      expect(migrationResult).toBe('migration-complete');
      const [afterMigrationSuccess] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterMigrationSuccess).toMatchObject({ phase: 'migrated', revision: fourth.composition.revision });
      const migratedRenewal = { ...fourth, validUntil: DateTime.add(fourth.validUntil, { milliseconds: 10_000 }) };
      yield* publishApplicationCompositionAuthoritySnapshot(migratedRenewal, Effect.void, skipInitialProof);
      const [afterMigratedRenewal] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterMigratedRenewal).toMatchObject({
        durableWorkAdmission: 'closed',
        phase: 'migrated',
        revision: fourth.composition.revision,
      });
      for (const operation of ['read', 'write', 'match', 'worker'] as const) {
        const retiredAdmission = yield* runtime.executor
          .transaction((transaction) =>
            lockApplicationCompositionAuthority(transaction, fourth.composition.revision, operation),
          )
          .pipe(Effect.flip);
        expect(Schema.is(ApplicationCompositionAuthorityError)(retiredAdmission)).toBe(true);
      }
      const repeatedMigration = yield* runApplicationCompositionMigration(
        Ref.update(migrationCalls, (calls) => calls + 1),
        skipInitialProof,
      ).pipe(Effect.flip);
      expect(Schema.is(ApplicationCompositionAuthorityError)(repeatedMigration)).toBe(true);
      expect(yield* Ref.get(migrationCalls)).toBe(1);
      yield* publishApplicationCompositionAuthoritySnapshot(
        fifth,
        Ref.update(afterMigrationPointerCalls, (calls) => calls + 1),
        skipInitialProof,
      );
      expect(yield* Ref.get(afterMigrationPointerCalls)).toBe(1);
      const [afterMigratedPromotion] = yield* observer.executor.select().from(applicationCompositionAuthority);
      expect(afterMigratedPromotion).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: fifth.composition.revision,
      });
      expect(database.executor).toBeDefined();
    }).pipe(Effect.provide(ApplicationCompositionAuthorityAdminDatabaseLive)),
);
