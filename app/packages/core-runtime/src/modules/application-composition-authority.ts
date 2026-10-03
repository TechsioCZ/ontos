import { and, eq, inArray, sql } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';

import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  outboxDeliveries,
  outboxMessages,
} from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';
import { validateOutboxWorkerSubscriptions } from '../outbox/definition.ts';
import type { OutboxWorkerSubscription } from '../outbox/definition.ts';
import type { ActiveApplicationCompositionSnapshot } from './active-application-composition.ts';
import { buildApplicationCompositionCatalog } from './application-composition-catalog.ts';
import { OntosOutboxSubscriptionContractSchema } from './manifest.ts';

export class ApplicationCompositionAuthorityError extends Schema.TaggedError<ApplicationCompositionAuthorityError>()(
  'ApplicationCompositionAuthorityError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    code: Schema.Literal('application_composition_authority_unavailable'),
    reason: Schema.String,
  },
) {}

const unavailable = (reason: string, cause?: unknown) =>
  new ApplicationCompositionAuthorityError({ cause, code: 'application_composition_authority_unavailable', reason });

const requireReadCommitted = Effect.fn('ApplicationCompositionAuthority.requireReadCommitted')(
  function* requireReadCommittedEffect(transaction: CoreTransaction) {
    const [isolation] = yield* transaction.execute<{ readonly isolation: string }>(
      sql`select current_setting('transaction_isolation') as isolation`,
      'objects',
    );
    if (isolation?.isolation !== 'read committed') {
      return yield* unavailable('Application Composition admission requires READ COMMITTED transaction isolation');
    }
    return yield* Effect.void;
  },
);

/**
 * The same transaction-scoped PostgreSQL lock fences publication, matching, and owner writes.
 * Runtimes cannot modify the authority row: its RLS policy permits reads only.
 */
export const lockApplicationCompositionAuthority = Effect.fn('ApplicationCompositionAuthority.lock')(
  function* lockApplicationCompositionAuthorityEffect(
    transaction: CoreTransaction,
    expectedRevision: string,
    operation: 'match' | 'read' | 'worker' | 'write',
  ) {
    yield* requireReadCommitted(transaction);
    yield* transaction.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0))`,
      'objects',
    );
    const [authority] = yield* transaction
      .select({
        phase: applicationCompositionAuthority.phase,
        revision: applicationCompositionAuthority.revision,
        subscriptionsJson: applicationCompositionAuthority.subscriptionsJson,
        unexpired: sql<boolean>`${applicationCompositionAuthority.validUntil} > clock_timestamp()`,
      })
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
    if (authority === undefined || !authority.unexpired || authority.revision !== expectedRevision) {
      return yield* unavailable('The requested Application Composition is missing, expired, or no longer active');
    }
    if (authority.phase === 'sealed' || authority.phase === 'migrated') {
      return yield* unavailable('Application Composition is sealed for schema migration and replacement');
    }
    if ((operation === 'write' || operation === 'read') && authority.phase !== 'active') {
      return yield* unavailable('Application Composition promotion is draining outstanding work');
    }
    const decodedSubscriptions = yield* Schema.decodeUnknownEffect(
      Schema.Array(OntosOutboxSubscriptionContractSchema),
      { onExcessProperty: 'error' },
    )(authority.subscriptionsJson).pipe(
      Effect.mapError((cause) => unavailable('The approved Outbox subscription authority is invalid', cause)),
    );
    return yield* Effect.try({
      catch: (cause) => unavailable('The approved Outbox subscription authority is invalid', cause),
      try: () =>
        validateOutboxWorkerSubscriptions(
          decodedSubscriptions.map((subscription) =>
            Object.freeze({
              ...subscription,
              entrypoint: Object.freeze({
                ...subscription.entrypoint,
                authorization: Object.freeze(subscription.entrypoint.authorization),
              }),
            }),
          ),
        ),
    });
  },
);

export const lockApplicationCompositionPublication = Effect.fn('ApplicationCompositionAuthority.lockPublication')(
  function* lockApplicationCompositionPublicationEffect(transaction: CoreTransaction) {
    yield* requireReadCommitted(transaction);
    return yield* transaction
      .execute(
        sql`select pg_advisory_xact_lock(hashtextextended('ontos.application-composition-authority', 0))`,
        'objects',
      )
      .pipe(Effect.mapError((cause) => unavailable('Application Composition publication is unavailable', cause)));
  },
);

const requireNoPendingDurableWork = Effect.fn('ApplicationCompositionAuthority.requireNoPendingDurableWork')(
  function* requireNoPendingDurableWorkEffect(transaction: CoreTransaction) {
    const [work] = yield* transaction.execute<{ readonly blocked: boolean }>(
      sql`select exists(select 1 from ${applicationCompositionDurableWork}) as blocked`,
      'objects',
    );
    if (work?.blocked !== false) {
      return yield* unavailable(
        'Outstanding durable owner workflows must finish before Application Composition can drain',
      );
    }
    return yield* Effect.void;
  },
);

/** Stops new durable workflows while existing work retains its original active-release authority. */
export const closeApplicationCompositionDurableAdmission = Effect.fn(
  'ApplicationCompositionAuthority.closeDurableAdmission',
)(function* closeApplicationCompositionDurableAdmissionEffect(transaction: CoreTransaction, expectedRevision: string) {
  yield* lockApplicationCompositionPublication(transaction);
  const changed = yield* transaction
    .update(applicationCompositionAuthority)
    .set({ durableWorkAdmission: 'closed', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(applicationCompositionAuthority.authorityKey, 'active'),
        eq(applicationCompositionAuthority.revision, expectedRevision),
        eq(applicationCompositionAuthority.phase, 'active'),
      ),
    )
    .returning({ revision: applicationCompositionAuthority.revision });
  if (changed.length !== 1) {
    return yield* unavailable('Only the exact active Application Composition can close durable admission');
  }
  return yield* Effect.void;
});

/** Explicit operator recovery is permitted only before the active release has begun draining. */
export const resumeApplicationCompositionDurableAdmission = Effect.fn(
  'ApplicationCompositionAuthority.resumeDurableAdmission',
)(function* resumeApplicationCompositionDurableAdmissionEffect(transaction: CoreTransaction, expectedRevision: string) {
  yield* lockApplicationCompositionPublication(transaction);
  const changed = yield* transaction
    .update(applicationCompositionAuthority)
    .set({ durableWorkAdmission: 'open', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(applicationCompositionAuthority.authorityKey, 'active'),
        eq(applicationCompositionAuthority.revision, expectedRevision),
        eq(applicationCompositionAuthority.phase, 'active'),
        sql`${applicationCompositionAuthority.validUntil} > clock_timestamp()`,
      ),
    )
    .returning({ revision: applicationCompositionAuthority.revision });
  if (changed.length !== 1) {
    return yield* unavailable('Only the exact unexpired active Application Composition can resume durable admission');
  }
  return yield* Effect.void;
});

/** Polls existing durable jobs after new durable admission has been closed. */
export const isApplicationCompositionDurableWorkDrained = Effect.fn(
  'ApplicationCompositionAuthority.isDurableWorkDrained',
)(function* isApplicationCompositionDurableWorkDrainedEffect(transaction: CoreTransaction, expectedRevision: string) {
  yield* lockApplicationCompositionPublication(transaction);
  const [authority] = yield* transaction
    .select({
      durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
      phase: applicationCompositionAuthority.phase,
      revision: applicationCompositionAuthority.revision,
    })
    .from(applicationCompositionAuthority)
    .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
  if (
    authority?.revision !== expectedRevision ||
    authority.phase !== 'active' ||
    authority.durableWorkAdmission !== 'closed'
  ) {
    return yield* unavailable(
      'Only the exact active Application Composition with closed durable admission can report durable drain progress',
    );
  }
  const [work] = yield* transaction.execute<{ readonly blocked: boolean }>(
    sql`select exists(select 1 from ${applicationCompositionDurableWork}) as blocked`,
    'objects',
  );
  if (work === undefined) {
    return yield* unavailable('Application Composition durable drain progress is unavailable');
  }
  return !work.blocked;
});

/** Stops new owner writes only after all previously admitted owner transactions have committed. */
export const drainApplicationCompositionAuthority = Effect.fn('ApplicationCompositionAuthority.drain')(
  function* drainApplicationCompositionAuthorityEffect(transaction: CoreTransaction, expectedRevision: string) {
    yield* lockApplicationCompositionPublication(transaction);
    yield* requireNoPendingDurableWork(transaction);
    const changed = yield* transaction
      .update(applicationCompositionAuthority)
      .set({ phase: 'draining', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(applicationCompositionAuthority.authorityKey, 'active'),
          eq(applicationCompositionAuthority.revision, expectedRevision),
          inArray(applicationCompositionAuthority.phase, ['active', 'draining']),
        ),
      )
      .returning({ revision: applicationCompositionAuthority.revision })
      .pipe(Effect.mapError((cause) => unavailable('Application Composition publication is unavailable', cause)));
    if (changed.length !== 1) {
      return yield* unavailable('The requested Application Composition cannot enter draining');
    }
    return yield* Effect.void;
  },
);

const requireDrainedWork = Effect.fn('ApplicationCompositionAuthority.requireDrainedWork')(
  function* requireDrainedWorkEffect(transaction: CoreTransaction) {
    yield* requireNoPendingDurableWork(transaction);
    const [work] = yield* transaction.execute<{ readonly blocked: boolean }>(
      sql`select exists(select 1 from ${outboxMessages} where ${outboxMessages.matchedAt} is null) or exists(select 1 from ${outboxDeliveries} where ${outboxDeliveries.status} <> 'done') as blocked`,
      'objects',
    );
    if (work?.blocked !== false) {
      return yield* unavailable('Outstanding Outbox work must finish or be explicitly reconciled before promotion');
    }
    return yield* Effect.void;
  },
);

/** Polls committed drain progress without admitting any operation on the retired release. */
export const isApplicationCompositionWorkDrained = Effect.fn('ApplicationCompositionAuthority.isWorkDrained')(
  function* isApplicationCompositionWorkDrainedEffect(transaction: CoreTransaction, expectedRevision: string) {
    yield* lockApplicationCompositionPublication(transaction);
    const [authority] = yield* transaction
      .select({ phase: applicationCompositionAuthority.phase, revision: applicationCompositionAuthority.revision })
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
    if (authority?.revision !== expectedRevision || (authority.phase !== 'draining' && authority.phase !== 'sealed')) {
      return yield* unavailable('Only the exact draining or sealed Application Composition can report drain progress');
    }
    const [work] = yield* transaction.execute<{ readonly blocked: boolean }>(
      sql`select exists(select 1 from ${applicationCompositionDurableWork}) or exists(select 1 from ${outboxMessages} where ${outboxMessages.matchedAt} is null) or exists(select 1 from ${outboxDeliveries} where ${outboxDeliveries.status} <> 'done') as blocked`,
      'objects',
    );
    if (work === undefined) {
      return yield* unavailable('Application Composition drain progress is unavailable');
    }
    return !work.blocked;
  },
);

/** Retires every old-release admission before schema migration, after old work has fully finished. */
export const sealApplicationCompositionAuthority = Effect.fn('ApplicationCompositionAuthority.seal')(
  function* sealApplicationCompositionAuthorityEffect(transaction: CoreTransaction, expectedRevision: string) {
    yield* lockApplicationCompositionPublication(transaction);
    yield* requireDrainedWork(transaction);
    const changed = yield* transaction
      .update(applicationCompositionAuthority)
      .set({ phase: 'sealed', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(applicationCompositionAuthority.authorityKey, 'active'),
          eq(applicationCompositionAuthority.revision, expectedRevision),
          eq(applicationCompositionAuthority.phase, 'draining'),
        ),
      )
      .returning({ revision: applicationCompositionAuthority.revision })
      .pipe(Effect.mapError((cause) => unavailable('Application Composition sealing is unavailable', cause)));
    if (changed.length !== 1) {
      return yield* unavailable('Only the exact draining Application Composition can be sealed');
    }
    return yield* Effect.void;
  },
);

/** Records verified native migration completion; the publisher holds its session lock throughout migration. */
export const markApplicationCompositionMigrationComplete = Effect.fn('ApplicationCompositionAuthority.markMigrated')(
  function* markApplicationCompositionMigrationCompleteEffect(transaction: CoreTransaction, expectedRevision: string) {
    yield* lockApplicationCompositionPublication(transaction);
    yield* requireDrainedWork(transaction);
    const changed = yield* transaction
      .update(applicationCompositionAuthority)
      .set({ phase: 'migrated', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(applicationCompositionAuthority.authorityKey, 'active'),
          eq(applicationCompositionAuthority.revision, expectedRevision),
          eq(applicationCompositionAuthority.phase, 'sealed'),
        ),
      )
      .returning({ revision: applicationCompositionAuthority.revision })
      .pipe(
        Effect.mapError((cause) => unavailable('Application Composition migration completion is unavailable', cause)),
      );
    if (changed.length !== 1) {
      return yield* unavailable('Only the exact sealed Application Composition can finish migration');
    }
    return yield* Effect.void;
  },
);

/**
 * Call in an admin-owned transaction. Renewal preserves release identity and admission phase.
 * A different release can become active only after the old release is fully drained.
 * Database migrations additionally require a final seal before any schema changes.
 */
export const publishApplicationCompositionAuthority = Effect.fn('ApplicationCompositionAuthority.publish')(
  function* publishApplicationCompositionAuthorityEffect(
    transaction: CoreTransaction,
    snapshot: ActiveApplicationCompositionSnapshot,
  ) {
    yield* Effect.logInfo('Publication catalog build started');
    const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition).pipe(
      Effect.mapError((cause) => unavailable('The complete Application Composition is invalid', cause)),
    );
    yield* Effect.logInfo('Publication catalog build returned');
    yield* Effect.logInfo('Publication authority fence started');
    yield* lockApplicationCompositionPublication(transaction);
    yield* Effect.logInfo('Publication authority fence returned');
    yield* Effect.logInfo('Publication freshness query started');
    const [validity] = yield* transaction.execute<{ readonly unexpired: boolean }>(
      sql`select ${DateTime.toDateUtc(snapshot.validUntil)}::timestamptz > clock_timestamp() as unexpired`,
      'objects',
    );
    yield* Effect.logInfo('Publication freshness query returned');
    if (validity?.unexpired !== true) {
      return yield* unavailable('Expired Application Composition authority cannot be published');
    }
    const [current] = yield* transaction
      .select()
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
    if (current === undefined) {
      yield* requireDrainedWork(transaction);
    }
    if (current !== undefined && current.revision !== snapshot.composition.revision) {
      if (current.phase !== 'draining' && current.phase !== 'migrated') {
        return yield* unavailable(
          'The old Application Composition must be drained or successfully migrated before replacement',
        );
      }
      yield* requireDrainedWork(transaction);
    }
    if (current !== undefined && DateTime.toEpochMillis(snapshot.validUntil) < current.validUntil.getTime()) {
      return yield* unavailable('Application Composition freshness cannot regress');
    }
    const subscriptionsJson: readonly OutboxWorkerSubscription[] = catalog.outboxSubscriptions;
    yield* transaction
      .insert(applicationCompositionAuthority)
      .values({
        authorityKey: 'active',
        durableWorkAdmission:
          current?.revision === snapshot.composition.revision ? current.durableWorkAdmission : 'open',
        phase: current?.revision === snapshot.composition.revision ? current.phase : 'active',
        revision: snapshot.composition.revision,
        subscriptionsJson,
        validUntil: DateTime.toDateUtc(snapshot.validUntil),
      })
      .onConflictDoUpdate({
        set: {
          durableWorkAdmission:
            current?.revision === snapshot.composition.revision ? current.durableWorkAdmission : 'open',
          phase: current?.revision === snapshot.composition.revision ? current.phase : 'active',
          revision: snapshot.composition.revision,
          subscriptionsJson,
          updatedAt: sql`clock_timestamp()`,
          validUntil: DateTime.toDateUtc(snapshot.validUntil),
        },
        target: applicationCompositionAuthority.authorityKey,
      });
    return yield* Effect.void;
  },
);
