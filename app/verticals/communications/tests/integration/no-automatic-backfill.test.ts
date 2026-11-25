import { randomUUID } from 'node:crypto';

import { loadDatabaseConnectionPair, OutboxRepositoryLive, OutboxRuntime, OutboxRuntimeLive } from '@app/core-runtime';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { sql } from 'drizzle-orm';
import { Context, Effect, Layer, Redacted } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';

import { communicationRequests, messageIntents } from '../../src/database/schema.ts';
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import { activateCommunications, publishComposition } from '../support/production-composition.fixture.ts';

/**
 * E22 / #1401 AC-09 / ADR-0013 on the REAL Core outbox: nothing a source owner publishes is ever turned into a message by
 * Communications, and a cutover that installs Communications after the source events exist backfills none of them.
 *
 * Scenario (native PostgreSQL, the actual composition of Communications, Privacy and the Portal Auth source module):
 * 1. BEFORE Communications is matched against the authority, the Tenant already holds real source events: published business
 *    messages of Portal Auth's own outbox contract (an invitation was created, an access was granted). They are unmatched.
 * 2. The composition that contains Communications is the authority in force; Core's own matcher runs.
 * 3. No delivery of any of those source messages exists for ANY Communications worker, running the owner's workers finds nothing
 *    to consume, and Communications holds no request, decision or message intent for the Tenant.
 * Control: a message on Communications' OWN topic, matched by the same matcher in the same run, DOES get its delivery for the owner's
 * worker, so the empty result above is not a matcher that matches nothing.
 *
 * Labelled: the source messages are written by SQL as the admin role (the producing Actions of Portal Auth are not run), and no
 * provider, Privacy or Auth owner is involved. This proves the Communications side of the cutover; the first-match rule itself is
 * Core's and is proven in `packages/core-runtime/tests/integration/outbox-runtime.test.ts`.
 */

const SOURCE_MODULE = 'commerce.customer-context';
const SOURCE_TOPICS = [
  'commerce.customer-context.counterparty-access-invitation-created.v1',
  'commerce.customer-context.counterparty-access-granted.v1',
] as const;
const OWN_TOPIC = 'communications.core.message-intent-prepared.v1';
const OWN_WORKER = 'communications.core.prepare-message-handoff';

type AdminCore = Effect.Success<ReturnType<typeof publishComposition>>['core'];

/** One published business message of a producer, with the Action invocation and domain event Core's outbox requires. */
const insertSourceMessage = (
  core: AdminCore,
  input: { readonly principalId: string; readonly producer: string; readonly tenantId: string; readonly topic: string },
) => {
  const ids = { event: randomUUID(), invocation: randomUUID(), message: randomUUID() };
  const { principalId, producer, tenantId, topic } = input;
  return core
    .transaction((transaction) =>
      Effect.gen(function* rows() {
        yield* transaction.execute(
          sql`insert into core.action_invocations (action_invocation_id, tenant_id, principal_id, auth_method, auth_context_ref,
                action_key, status, request_hash, started_at, completed_at)
              values (${ids.invocation}::uuid, ${tenantId}::uuid, ${principalId}::uuid, 'system',
                ${`job:fictional-source:run:${ids.invocation}`}, 'fictional.source.write', 'succeeded', ${'a'.repeat(64)},
                now() - interval '1 hour', now() - interval '1 hour')`,
          'objects',
        );
        yield* transaction.execute(
          sql`insert into core.domain_events (domain_event_id, tenant_id, action_invocation_id, producer_module_key, event_type,
                subject_module_key, subject_resource_type, subject_resource_id, payload_json)
              values (${ids.event}::uuid, ${tenantId}::uuid, ${ids.invocation}::uuid, ${producer}, ${topic}, ${producer},
                'fictional.resource', 'fictional-1', '{}'::jsonb)`,
          'objects',
        );
        yield* transaction.execute(
          sql`insert into core.outbox_messages (outbox_message_id, tenant_id, domain_event_id, producer_module_key, topic, payload_json)
              values (${ids.message}::uuid, ${tenantId}::uuid, ${ids.event}::uuid, ${producer}, ${topic}, '{}'::jsonb)`,
          'objects',
        );
      }),
    )
    .pipe(Effect.as(ids.message));
};

/** Every delivery Core created for the given messages, whichever worker or module it names. */
const deliveriesOfMessages = (core: AdminCore, messageIds: readonly string[]) =>
  Effect.forEach(
    messageIds,
    (messageId) =>
      core.transaction((transaction) =>
        transaction.execute<{ readonly consumer: string; readonly worker: string }>(
          sql`select d.worker_key as worker, d.consumer_module_key as consumer from core.outbox_deliveries d
             where d.outbox_message_id = ${messageId}::uuid`,
          'objects',
        ),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((perMessage) => perMessage.flat()));

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, Reactivity.layer, nativeServices);

describe('Communications never backfills source events (E22, ADR-0013) on the real Core outbox', () => {
  it.live(
    'a Tenant with earlier source events gets no message, no decision and no delivery for any Communications worker when Communications is matched',
    () =>
      Effect.scoped(
        Effect.gen(function* noBackfill() {
          const { core, snapshot } = yield* publishComposition();
          const { revision } = snapshot.composition;
          const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
          const fixture = yield* makeLiveOperationFixture({
            access: 'allowed',
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: revision,
            runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
          });
          yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
          yield* activateCommunications(core, fixture.tenantId);
          const { tenantId } = fixture;

          // 1. real source messages that exist before anything of Communications looks at the Tenant
          const insertMessage = (producer: string, topic: string) =>
            insertSourceMessage(core, { principalId: fixture.manager.principalId, producer, tenantId, topic });
          const sourceMessages = yield* Effect.forEach(SOURCE_TOPICS, (topic) => insertMessage(SOURCE_MODULE, topic), {
            concurrency: 1,
          });
          const ownMessage = yield* insertMessage('communications.core', OWN_TOPIC);
          const deliveriesOf = (messageIds: readonly string[]) => deliveriesOfMessages(core, messageIds);
          expect(yield* deliveriesOf([...sourceMessages, ownMessage])).toEqual([]);

          // 2. the composition that contains Communications is the authority in force: Core's own matcher runs
          const coreRuntime = yield* makeCoreDatabase(connections.runtime);
          const outboxServices = yield* Layer.build(
            OutboxRuntimeLive.pipe(
              Layer.provide(OutboxRepositoryLive),
              Layer.provide(Layer.succeed(CoreDatabase, coreRuntime)),
            ),
          );
          const outbox = Context.get(outboxServices, OutboxRuntime);
          yield* outbox.matchMessages({ compositionRevision: revision });

          // 3. Communications' own topic is delivered to its worker (the matcher works); no source message reaches ANY worker
          expect((yield* deliveriesOf([ownMessage])).map(({ worker }) => worker)).toEqual([OWN_WORKER]);
          expect(yield* deliveriesOf(sourceMessages)).toEqual([]);
          // and Communications holds nothing for the Tenant: no request, no decision, no message intent
          const database = yield* makeRuntimeDatabase();
          const held = yield* database.inTenant(tenantId, (transaction) =>
            Effect.all({
              intents: transaction.select({ intentId: messageIntents.intentId }).from(messageIntents),
              requests: transaction.select({ requestId: communicationRequests.requestId }).from(communicationRequests),
            }),
          );
          expect(held).toEqual({ intents: [], requests: [] });
        }).pipe(Effect.provide(services)),
      ),
  );
});
