import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';

import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  outboxDeliveries,
  outboxMessages,
} from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';
import { installOperationalScopeAt } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import { validateOutboxWorkerSubscriptions } from '../outbox/definition.ts';
import type { OutboxWorkerSubscription } from '../outbox/definition.ts';
import { CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS } from '../outbox/core-system-subscriptions.ts';
import type { ActiveApplicationCompositionSnapshot } from './active-application-composition.ts';
import { buildApplicationCompositionCatalog } from './application-composition-catalog.ts';
import { OutboxSubscriptionAuthoritySchema } from './manifest.ts';

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

const READ_COMMITTED_ISOLATION = 'read committed';

/** The CASE prevents acquiring either publication lock under an unsupported snapshot. */
const lockReadCommitted = Effect.fn('ApplicationCompositionAuthority.lockReadCommitted')(
  function* lockReadCommittedEffect(transaction: Pick<CoreTransaction, 'execute'>, acquire: SQL) {
    const [isolation] = yield* transaction.execute<{ readonly isolation: string }>(
      sql`select current_setting('transaction_isolation') as isolation, case when current_setting('transaction_isolation') = ${READ_COMMITTED_ISOLATION} then ${acquire} end as publication_lock`,
      'objects',
    );
    if (isolation?.isolation !== READ_COMMITTED_ISOLATION) {
      return yield* unavailable('Application Composition admission requires READ COMMITTED transaction isolation');
    }
    return yield* Effect.void;
  },
);

/** Reads the active authority row and applies the admission rules of one operation. */
const admitAuthority = Effect.fn('ApplicationCompositionAuthority.admit')(function* admitAuthorityEffect(
  executor: Pick<CoreTransaction, 'select'>,
  expectedRevision: string,
  operation: 'match' | 'read' | 'worker' | 'write',
) {
  // Only matching consumes the approved subscriptions. Every other admission reads the fence columns alone,
  // so no request decodes and validates the subscription set while its transaction holds a pooled connection.
  const [authority] = yield* executor
    .select({
      phase: applicationCompositionAuthority.phase,
      revision: applicationCompositionAuthority.revision,
      subscriptionsJson: operation === 'match' ? applicationCompositionAuthority.subscriptionsJson : sql<unknown>`null`,
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
  return authority.subscriptionsJson;
});

/**
 * Rejects a stale, draining, or sealed revision with one statement and no transaction, before a
 * Read spends network round trips on authorization or runs owner callbacks. It is not the fence:
 * owner work still runs under {@link lockApplicationCompositionAuthority} in its own transaction.
 */
export const precheckApplicationCompositionAdmission = (
  executor: Pick<CoreTransaction, 'select'>,
  expectedRevision: string,
  operation: 'read' | 'write',
) => admitAuthority(executor, expectedRevision, operation).pipe(Effect.asVoid);

/**
 * The same transaction-scoped PostgreSQL lock fences publication, matching, and owner writes.
 * Runtimes cannot modify the authority row: its RLS policy permits reads only.
 */
export const lockApplicationCompositionAuthority = Effect.fn('ApplicationCompositionAuthority.lock')(
  function* lockApplicationCompositionAuthorityEffect(
    transaction: Pick<CoreTransaction, 'execute' | 'select'>,
    expectedRevision: string,
    operation: 'match' | 'read' | 'worker' | 'write',
  ) {
    yield* lockReadCommitted(
      transaction,
      sql`pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0))`,
    );
    // This MUST remain a later statement: its READ COMMITTED snapshot is acquired after the lock wait,
    // so a publisher that committed while we waited cannot leave us admitting its superseded revision.
    const subscriptionsJson = yield* admitAuthority(transaction, expectedRevision, operation);
    if (operation !== 'match') {
      return Object.freeze([]);
    }
    const decodedSubscriptions = yield* Schema.decodeUnknownEffect(Schema.Array(OutboxSubscriptionAuthoritySchema), {
      onExcessProperty: 'error',
    })(subscriptionsJson).pipe(
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

/** Installs verified RLS scope while acquiring the fence, then admits from a fresh post-lock snapshot. */
export const lockApplicationCompositionReadScope = Effect.fn('ApplicationCompositionAuthority.lockReadScope')(
  function* lockApplicationCompositionReadScopeEffect(
    transaction: CoreTransaction,
    expectedRevision: string,
    scope: OperationalScope,
  ) {
    const installed = yield* installOperationalScopeAt(transaction, scope, {
      acquire: sql`pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0))`,
      isolation: READ_COMMITTED_ISOLATION,
    }).pipe(
      Effect.mapError((cause) => unavailable('Application Composition read scope could not be installed', cause)),
    );
    // Never move this admission into the lock statement, including a CTE: its snapshot would predate a lock wait.
    yield* admitAuthority(transaction, expectedRevision, 'read');
    return installed;
  },
);

export const lockApplicationCompositionPublication = Effect.fn('ApplicationCompositionAuthority.lockPublication')(
  function* lockApplicationCompositionPublicationEffect(transaction: CoreTransaction) {
    return yield* lockReadCommitted(
      transaction,
      sql`pg_advisory_xact_lock(hashtextextended('ontos.application-composition-authority', 0))`,
    ).pipe(
      Effect.mapError((cause) =>
        Schema.is(ApplicationCompositionAuthorityError)(cause)
          ? cause
          : unavailable('Application Composition publication is unavailable', cause),
      ),
    );
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
    const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition).pipe(
      Effect.mapError((cause) => unavailable('The complete Application Composition is invalid', cause)),
    );
    yield* lockApplicationCompositionPublication(transaction);
    const [validity] = yield* transaction.execute<{ readonly unexpired: boolean }>(
      sql`select ${DateTime.toDateUtc(snapshot.validUntil)}::timestamptz > clock_timestamp() as unexpired`,
      'objects',
    );
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
    const subscriptionsJson: readonly OutboxWorkerSubscription[] = validateOutboxWorkerSubscriptions([
      ...catalog.outboxSubscriptions,
      ...CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
    ]);
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
