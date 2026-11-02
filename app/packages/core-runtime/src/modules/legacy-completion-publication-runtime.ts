import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema, Stream } from 'effect';

import { applicationCompositionAuthority, outboxDeliveries, outboxMessages } from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';
import {
  LegacyCompletionPublication,
  LegacyCompletionPublicationError,
  LegacyCompletionPublicationBindingSchema,
  validateLegacyCompletionOwnerResult,
} from './legacy-completion-publication.ts';
import type {
  LegacyCompletionMessageEvidence,
  LegacyCompletionOwnerLease,
  LegacyCompletionOwnerVerifier,
  LegacyCompletionPublicationBinding,
} from './legacy-completion-publication.ts';

const evidenceBatchSize = 1000;
const unavailable = (reason: string) => new LegacyCompletionPublicationError({ reason });

export interface LeasedLegacyCompletionOwner {
  readonly lease: LegacyCompletionOwnerLease;
  readonly owner: LegacyCompletionOwnerVerifier;
}

/** Owner locks outlive the entire callback, including Core's actual transaction COMMIT. */
export const withLegacyCompletionOwnerLeases = Effect.fn('LegacyCompletionPublication.withOwnerLeases')(
  function* withLegacyCompletionOwnerLeases<Value, Failure, Requirements>(
    transition: (owners: readonly LeasedLegacyCompletionOwner[]) => Effect.Effect<Value, Failure, Requirements>,
  ): Effect.fn.Return<Value, Failure | LegacyCompletionPublicationError, Requirements> {
    const configured = yield* Effect.serviceOption(LegacyCompletionPublication);
    if (Option.isNone(configured) || configured.value.owners.length === 0) {
      return yield* unavailable('The deployment legacy completion verifier is unavailable');
    }
    const service = configured.value;
    const identities = service.owners.map((owner) => `${owner.producerModuleKey}:${owner.topic}`);
    if (new Set(identities).size !== identities.length) {
      return yield* unavailable('The deployment legacy completion verifier identity is ambiguous');
    }
    const acquire = (
      index: number,
      leases: readonly LeasedLegacyCompletionOwner[],
    ): Effect.Effect<Value, Failure | LegacyCompletionPublicationError, Requirements> => {
      const owner = service.owners[index];
      return owner === undefined
        ? transition(leases)
        : owner.withLease((lease) => acquire(index + 1, [...leases, { lease, owner }]));
    };
    return yield* acquire(0, []);
  },
);

const attachDeliveryEvidence = (
  messages: readonly Omit<LegacyCompletionMessageEvidence, 'deliveries'>[],
  deliveries: readonly (LegacyCompletionMessageEvidence['deliveries'][number] & { readonly outboxMessageId: string })[],
): readonly LegacyCompletionMessageEvidence[] => {
  const byMessage = new Map<string, LegacyCompletionMessageEvidence['deliveries'][number][]>();
  for (const delivery of deliveries) {
    const evidence = Object.freeze({
      consumerModuleKey: delivery.consumerModuleKey,
      status: delivery.status,
      workerKey: delivery.workerKey,
    });
    const existing = byMessage.get(delivery.outboxMessageId);
    if (existing === undefined) {
      byMessage.set(delivery.outboxMessageId, [evidence]);
    } else {
      existing.push(evidence);
    }
  }
  return messages.map((message) =>
    Object.freeze({
      ...message,
      deliveries: byMessage.get(message.outboxMessageId) ?? [],
    }),
  );
};

const pageContinuation = (ids: readonly string[]) =>
  ids.length < evidenceBatchSize ? Option.none<Option.Option<string>>() : Option.some(Option.fromNullishOr(ids.at(-1)));

const readDeliveryEvidence = (transaction: CoreTransaction, messageIds: readonly string[]) =>
  Stream.paginate(Option.none<string>(), (cursor) =>
    transaction
      .select({
        consumerModuleKey: outboxDeliveries.consumerModuleKey,
        outboxDeliveryId: outboxDeliveries.outboxDeliveryId,
        outboxMessageId: outboxDeliveries.outboxMessageId,
        status: outboxDeliveries.status,
        workerKey: outboxDeliveries.workerKey,
      })
      .from(outboxDeliveries)
      .where(
        and(
          inArray(outboxDeliveries.outboxMessageId, messageIds),
          Option.isNone(cursor) ? undefined : gt(outboxDeliveries.outboxDeliveryId, cursor.value),
        ),
      )
      .orderBy(outboxDeliveries.outboxDeliveryId)
      .limit(evidenceBatchSize)
      .pipe(
        Effect.map((page) => [[page], pageContinuation(page.map((delivery) => delivery.outboxDeliveryId))] as const),
      ),
  ).pipe(Stream.flattenIterable, Stream.runCollect);

// SHARE fences retain a stable complete population across READ COMMITTED keyset pages.
// Batch size bounds each SQL result, never the lifetime amount of immutable history.
const readOwnerMessageEvidence = (transaction: CoreTransaction, owner: LegacyCompletionOwnerVerifier) =>
  Stream.paginate(Option.none<string>(), (cursor) =>
    transaction
      .select({
        completionConsumerModuleKey: outboxMessages.completionConsumerModuleKey,
        completionOriginalRevision: outboxMessages.completionOriginalRevision,
        outboxMessageId: outboxMessages.outboxMessageId,
        payloadJson: outboxMessages.payloadJson,
        tenantId: outboxMessages.tenantId,
      })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.producerModuleKey, owner.producerModuleKey),
          eq(outboxMessages.topic, owner.topic),
          Option.isNone(cursor) ? undefined : gt(outboxMessages.outboxMessageId, cursor.value),
        ),
      )
      .orderBy(outboxMessages.outboxMessageId)
      .limit(evidenceBatchSize)
      .pipe(Effect.map((page) => [[page], pageContinuation(page.map((message) => message.outboxMessageId))] as const)),
  ).pipe(
    Stream.mapEffect(
      (page) =>
        page.length === 0
          ? Effect.succeed([])
          : readDeliveryEvidence(
              transaction,
              page.map((message) => message.outboxMessageId),
            ).pipe(Effect.map((deliveries) => attachDeliveryEvidence(page, deliveries))),
      { concurrency: 1 },
    ),
    Stream.flattenIterable,
    Stream.runCollect,
  );

/** Private Core evidence adapter. No database executor is exposed to an owner. */
export const verifyLegacyCompletionPublication = Effect.fn('LegacyCompletionPublication.verify')(
  function* verifyLegacyCompletionPublication(
    transaction: CoreTransaction,
    expectedRevision: string | null,
    owners: readonly LeasedLegacyCompletionOwner[],
  ) {
    const configured = yield* Effect.serviceOption(LegacyCompletionPublication);
    if (Option.isNone(configured)) {
      return yield* unavailable('The deployment legacy completion verifier is unavailable');
    }
    const service = configured.value;
    const [authority] = yield* transaction
      .select({ revision: applicationCompositionAuthority.revision })
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
    if ((authority?.revision ?? null) !== expectedRevision) {
      return yield* unavailable('The native legacy completion authority binding changed');
    }
    const [native] = yield* transaction.execute<{
      readonly administrative: boolean;
      readonly clockValue: unknown;
      readonly databaseName: string;
      readonly databaseOid: string;
      readonly databaseUser: string;
      readonly isolation: string;
      readonly runtimeRoleOid: string;
      readonly safeRuntime: boolean;
      readonly systemIdentifier: string;
      readonly transactionId: string;
    }>(
      sql`select current_database() as "databaseName",
        (select oid::text from pg_database where datname=current_database()) as "databaseOid",
        (pg_control_system()).system_identifier::text as "systemIdentifier",
        pg_current_xact_id()::text as "transactionId", to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "clockValue",
        current_user as "databaseUser", runtime.oid::text as "runtimeRoleOid",
        (operator.rolsuper or operator.rolbypassrls) as administrative,
        (not runtime.rolsuper and not runtime.rolbypassrls and runtime.rolname <> current_user) as "safeRuntime",
        current_setting('transaction_isolation') as isolation
        from pg_roles operator cross join pg_roles runtime
        where operator.rolname=current_user and runtime.rolname=${service.runtimeUser}`,
      'objects',
    );
    if (
      native === undefined ||
      !native.administrative ||
      !native.safeRuntime ||
      native.isolation !== 'read committed'
    ) {
      return yield* unavailable('Administrative all-row and distinct runtime identities are required');
    }
    const binding: LegacyCompletionPublicationBinding = yield* Schema.decodeUnknownEffect(
      LegacyCompletionPublicationBindingSchema,
    )({
      databaseName: native.databaseName,
      databaseOid: native.databaseOid,
      databaseUser: native.databaseUser,
      expectedRevision,
      observedAt: yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(native.clockValue).pipe(
        Effect.mapError(
          (cause) => new LegacyCompletionPublicationError({ cause, reason: 'The native observation time is invalid' }),
        ),
      ),
      runtimeRoleOid: native.runtimeRoleOid,
      runtimeTarget: service.runtimeTarget,
      runtimeUser: service.runtimeUser,
      systemIdentifier: native.systemIdentifier,
      transactionId: native.transactionId,
    }).pipe(
      Effect.mapError(
        (cause) => new LegacyCompletionPublicationError({ cause, reason: 'The native publication binding is invalid' }),
      ),
    );
    // This protects only the brief evidence-to-fence interval, not an unrelated owners' drain policy.
    yield* transaction.execute(sql`lock table ${outboxMessages}, ${outboxDeliveries} in share mode`, 'objects');
    yield* Effect.forEach(
      owners,
      Effect.fn('LegacyCompletionPublication.verifyOwner')(function* verifyOwnerLegacyCompletion({ lease, owner }) {
        const messages = yield* readOwnerMessageEvidence(transaction, owner);
        const evidenceReference = `legacy-completion:${binding.systemIdentifier}:${binding.databaseOid}:${binding.transactionId}:${owner.producerModuleKey}:${owner.topic}`;
        const observation = Object.freeze({
          binding,
          complete: true,
          evidenceReference,
          messages,
        });
        const result = yield* lease.verify(observation);
        yield* service.retainEvidence({
          binding,
          evidenceReference,
          ownerBinding: lease.binding,
          producerModuleKey: owner.producerModuleKey,
          status: result.status,
          topic: owner.topic,
        });
        yield* validateLegacyCompletionOwnerResult(observation, lease.binding, result);
      }),
      { concurrency: 1, discard: true },
    );
    // Retention/owner I/O cannot turn an old observation into current authorization.
    const [fresh] = yield* transaction.execute<{ readonly valid: boolean }>(
      sql`select pg_current_xact_id()::text=${binding.transactionId} and
        clock_timestamp() >= ${DateTime.formatIso(binding.observedAt)}::timestamptz and
        clock_timestamp() <= ${DateTime.formatIso(binding.observedAt)}::timestamptz + interval '30 seconds' as valid`,
      'objects',
    );
    if (fresh?.valid !== true) {
      return yield* unavailable('The native legacy completion observation is no longer fresh');
    }
    return yield* Effect.void;
  },
);
