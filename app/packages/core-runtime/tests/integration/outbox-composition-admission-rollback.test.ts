import { asc } from 'drizzle-orm';
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { Cause, Crypto, Effect, Exit, Layer, Option, Schema } from 'effect';
import { AuthorizationError, isSqlError, SqlError, UnknownError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  domainEvents,
  outboxMessages,
  tenants,
} from '../../src/db/schema.ts';
import { closeApplicationCompositionDurableAdmission } from '../../src/modules/application-composition-authority.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineOutboxWorker, extractOutboxWorkerSubscriptions } from '../../src/outbox/definition.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';

const producer = 'producer.fixture';
const consumer = 'consumer.fixture';
const topic = 'producer.fixture.accepted';
const receiverFailure = 'Outbox completion requires an exact registered producer and consumer';
const admissionFailure = 'Outbox completion admission is unavailable';
const triggerContext = /PL\/pgSQL function (?:core\.)?enroll_outbox_composition_completion\(\) line \d+ at RAISE/u;
const postgresDiagnosticSchema = Schema.Struct({ code: Schema.String, message: Schema.String, where: Schema.String });
const decodeDiagnostic = Schema.decodeUnknownOption(postgresDiagnosticSchema);

const singleFailure = (cause: Cause.Cause<unknown>) => {
  const [reason] = cause.reasons;
  return cause.reasons.length === 1 && reason !== undefined && Cause.isFailReason(reason)
    ? Option.some(reason.error)
    : Option.none();
};

// Installed Drizzle wraps the SQL Cause. PgConnection classifies 55000 as UnknownError
// and preserves PostgreSQL ErrorFields on reason.cause. No generic cause-chain guessing.
const enrollmentDiagnostic = (cause: Cause.Cause<unknown>) => {
  const failure = singleFailure(cause);
  if (Option.isNone(failure) || !Schema.is(EffectDrizzleQueryError)(failure.value)) {
    return Option.none();
  }
  const queryFailure = failure.value;
  if (!Cause.isCause(queryFailure.cause)) {
    return Option.none();
  }
  const nested = singleFailure(queryFailure.cause);
  if (Option.isNone(nested) || !isSqlError(nested.value) || !Schema.is(UnknownError)(nested.value.reason)) {
    return Option.none();
  }
  return decodeDiagnostic(nested.value.reason.cause).pipe(
    Option.filter(
      (diagnostic) =>
        diagnostic.code === '55000' &&
        Option.exists(findPostgresFailure(queryFailure), ({ code }) => code === diagnostic.code) &&
        triggerContext.test(diagnostic.where),
    ),
  );
};
const wrapped = (reason: UnknownError | AuthorizationError) =>
  Cause.fail(
    new EffectDrizzleQueryError({
      cause: Cause.fail(new SqlError({ reason })),
      params: [],
      query: 'controlled test query',
    }),
  );

const worker = defineOutboxWorker(
  {
    consumerModuleKey: consumer,
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'owner_local_background' },
      entrypointKey: `${consumer}.rollback`,
      moduleKey: consumer,
      role: 'worker',
    }),
    leaseDurationMs: 1000,
    payloadSchema: Schema.Struct({ id: Schema.String }),
    producerModuleKey: producer,
    retryPolicy: { initialBackoffMs: 0, maxAttempts: 1, maxBackoffMs: 0, multiplier: 1 },
    topic,
    workerKey: `${consumer}.rollback`,
  },
  () => Effect.void,
);
const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const fixture = Effect.gen(function* admissionRollbackFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1258-privacy-drain',
  });
  yield* isolated.migrateCoreSchema();
  const snapshot = yield* makeApplicationCompositionSnapshotFixture([], 'core-outbox-admission-rollback');
  yield* isolated.publishInitialComposition(snapshot);
  const { executor: admin } = yield* makeCoreDatabase(isolated.connections.admin);
  const { executor: runtime } = yield* makeCoreDatabase(isolated.connections.runtime);
  // Real validated test subscription; no owner business data or foreign deployment imports.
  yield* admin
    .update(applicationCompositionAuthority)
    .set({ subscriptionsJson: extractOutboxWorkerSubscriptions([worker]) });
  const tenantId = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
  yield* runtime.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Outbox admission rollback fixture',
    slug: `rollback-${tenantId}`,
    status: 'active',
    tenantId,
  });
  const { revision } = snapshot.composition;
  const insert = (target = consumer) =>
    runtime.transaction(
      Effect.fn(function* insertMarkedMessage(transaction) {
        const [event] = yield* transaction
          .insert(domainEvents)
          .values({
            eventType: topic,
            payloadJson: {},
            producerModuleKey: producer,
            subjectModuleKey: producer,
            subjectResourceId: tenantId,
            subjectResourceType: 'admission-rollback-test',
            tenantId,
          })
          .returning({ id: domainEvents.domainEventId });
        const eventId = Option.getOrThrow(Option.fromNullishOr(event)).id;
        const [message] = yield* transaction
          .insert(outboxMessages)
          .values({
            completionConsumerModuleKey: target,
            completionOriginalRevision: revision,
            domainEventId: eventId,
            payloadJson: { id: tenantId },
            producerModuleKey: producer,
            tenantId,
            topic,
          })
          .returning({ id: outboxMessages.outboxMessageId });
        return { eventId, messageId: Option.getOrThrow(Option.fromNullishOr(message)).id };
      }),
    );
  // All columns, deterministic order: equality detects partial inserts and control mutation.
  const rows = () =>
    Effect.gen(function* readRollbackEvidence() {
      const events = yield* runtime.select().from(domainEvents).orderBy(asc(domainEvents.domainEventId));
      const messages = yield* runtime.select().from(outboxMessages).orderBy(asc(outboxMessages.outboxMessageId));
      const debt = yield* runtime
        .select()
        .from(applicationCompositionDurableWork)
        .orderBy(
          asc(applicationCompositionDurableWork.ownerModuleKey),
          asc(applicationCompositionDurableWork.originalRevision),
          asc(applicationCompositionDurableWork.workId),
        );
      return { debt, events, messages };
    });
  return { admin, insert, revision, rows };
});

it('decodes only the installed typed enrollment cause and rejects unrelated failures without services', () => {
  const driver = {
    code: '55000',
    message: receiverFailure,
    where: 'PL/pgSQL function enroll_outbox_composition_completion() line 47 at RAISE',
  };
  const valid = wrapped(new UnknownError({ cause: Object.assign(new Error(driver.message), driver) }));
  expect(Option.getOrThrow(enrollmentDiagnostic(valid))).toEqual(driver);
  for (const cause of [
    Cause.fail(new Error('transport failure')),
    Cause.fail(driver),
    Cause.die(new SqlError({ reason: new UnknownError({ cause: driver }) })),
    wrapped(new AuthorizationError({ cause: { ...driver, code: '42501' } })),
    wrapped(new UnknownError({ cause: { ...driver, code: '08006' } })),
    wrapped(new UnknownError({ cause: { ...driver, where: 'PL/pgSQL function unrelated() line 1 at RAISE' } })),
    wrapped(new UnknownError({ cause: { code: driver.code, message: driver.message } })),
    Cause.combine(valid, Cause.die(new Error('unrelated defect'))),
  ]) {
    expect(Option.isNone(enrollmentDiagnostic(cause))).toBe(true);
  }
  const otherMessage = wrapped(new UnknownError({ cause: { ...driver, message: admissionFailure } }));
  expect(Option.getOrThrow(enrollmentDiagnostic(otherMessage)).message).not.toBe(receiverFailure);
});

it.layer(nativeServices, { excludeTestServices: true })('exact outbox admission rollback', (suite) => {
  suite.effect('attributes wrong-receiver enrollment rejection and rolls back every event message and debt row', () =>
    Effect.gen(function* receiverRollback() {
      const f = yield* fixture;
      expect(yield* f.rows()).toEqual({ debt: [], events: [], messages: [] });
      const accepted = yield* f.insert();
      const before = yield* f.rows();
      expect(before.events).toHaveLength(1);
      expect(before.events[0]?.domainEventId).toBe(accepted.eventId);
      expect(before.messages).toHaveLength(1);
      expect(before.messages[0]?.domainEventId).toBe(accepted.eventId);
      expect(before.messages[0]?.outboxMessageId).toBe(accepted.messageId);
      expect(before.debt).toHaveLength(1);
      expect(before.debt).toMatchObject([
        { originalRevision: f.revision, ownerModuleKey: producer, workId: `outbox:${accepted.messageId}:${consumer}` },
      ]);
      const rejected = yield* f.insert('unregistered.fixture').pipe(Effect.exit);
      const diagnostic = Exit.match(rejected, { onFailure: enrollmentDiagnostic, onSuccess: () => Option.none() });
      expect(Option.getOrThrow(diagnostic)).toMatchObject({ code: '55000', message: receiverFailure });
      expect(yield* f.rows()).toEqual(before);
    }),
  );

  suite.effect('attributes close-first admission rejection and rolls back every event message and debt row', () =>
    Effect.gen(function* closeFirstRollback() {
      const f = yield* fixture;
      expect(yield* f.rows()).toEqual({ debt: [], events: [], messages: [] });
      const accepted = yield* f.insert();
      const before = yield* f.rows();
      expect(before.events).toHaveLength(1);
      expect(before.messages).toHaveLength(1);
      expect(before.debt).toHaveLength(1);
      expect(before.debt).toMatchObject([
        { originalRevision: f.revision, ownerModuleKey: producer, workId: `outbox:${accepted.messageId}:${consumer}` },
      ]);
      yield* f.admin.transaction((transaction) => closeApplicationCompositionDurableAdmission(transaction, f.revision));
      const authority = yield* f.admin.select().from(applicationCompositionAuthority);
      expect(authority).toMatchObject([{ durableWorkAdmission: 'closed', revision: f.revision }]);
      const rejected = yield* f.insert().pipe(Effect.exit);
      const diagnostic = Exit.match(rejected, { onFailure: enrollmentDiagnostic, onSuccess: () => Option.none() });
      expect(Option.getOrThrow(diagnostic)).toMatchObject({ code: '55000', message: admissionFailure });
      expect(yield* f.rows()).toEqual(before);
    }),
  );
});
