/**
 * The transaction capability's engine: one owner transaction per use, READ ONLY for a read from
 * BEGIN, fenced to the admitted composition revision, scoped, sealed, owner rule decided, services
 * built by the operation's own factory, body run with its forks joined, the handle revoked, then
 * commit or rollback. Kind-neutral: it never sees a read type (see `kernel-transactions.ts`).
 */
import { Cause, Effect, Exit, Fiber, Layer, Schema } from 'effect';
import { isSqlError } from 'effect/sql/SqlError';

import { CoreDatabase } from '../db/client.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import {
  ApplicationCompositionAuthorityError,
  lockApplicationCompositionAuthority,
} from '../modules/application-composition-authority.ts';
import { trustedStatementTime } from '../operations/transaction-time.ts';
import { TransactionAborted } from '../sdk/index.ts';
import type { TransactionFacts } from '../sdk/index.ts';
import { ExecutionRuleViolation } from './contract.ts';
import type { OwnerBinding, TransactionRequest } from './contract.ts';
import { KernelTransactions } from './kernel-transactions.ts';

/** The Core database the transactions open on; the caller owns the pool and its deadlines. */
interface KernelDatabase {
  readonly executor: CoreDatabaseExecutor;
}

/** A `TransactionAborted` that keeps what caused it for logs. */
const abortedBy =
  (reason: TransactionAborted['reason']) =>
  (cause: unknown): TransactionAborted =>
    Object.defineProperty(new TransactionAborted({ reason }), 'cause', { configurable: true, value: cause });

/** Ends the driver transaction without committing: the opening owner check, or a body that failed. */
class RollbackRequested extends Schema.TaggedError<RollbackRequested>()('RollbackRequested', {}) {}

/** The lifetime of one transaction's handle: usable until `revoke`, then every use is refused. */
interface Lifetime {
  readonly assertLive: () => void;
  readonly revoke: () => void;
}

const makeLifetime = (sequence: number): Lifetime => {
  let ended = false;
  return {
    assertLive: () => {
      if (ended) {
        throw new ExecutionRuleViolation({
          detail: `A service or handle of transaction ${String(sequence)} was used after its body ended`,
          rule: 'transaction_ended',
        });
      }
    },
    revoke: () => {
      ended = true;
    },
  };
};

/**
 * The same function, refused once the lifetime ended. The wrapper forwards its arguments and its result
 * unchanged, so it has exactly the signature of `fn` (overloads included); the overload states that
 * without an assertion.
 */
function revocable<Fn extends (...args: never[]) => object>(fn: Fn, lifetime: Lifetime): Fn;
function revocable(fn: (...args: never[]) => object, lifetime: Lifetime): (...args: never[]) => object {
  return (...args) => {
    lifetime.assertLive();
    return fn(...args);
  };
}

/**
 * Every database entry of the scoped executor, refused after the body ended. Services are built on this
 * executor, so any database use of a service after its transaction dies `transaction_ended` instead of
 * running on a pooled connection outside the transaction and its scope. The guard is copied by the
 * workload seal, which spreads the executor's properties.
 */
const revocableExecutor = (executor: ScopedTransactionExecutor, lifetime: Lifetime): ScopedTransactionExecutor =>
  Object.freeze({
    ...executor,
    delete: revocable(executor.delete, lifetime),
    insert: revocable(executor.insert, lifetime),
    invoke: revocable(executor.invoke, lifetime),
    select: revocable(executor.select, lifetime),
    update: revocable(executor.update, lifetime),
  });

/** What one transaction keeps while it runs; changed only by the transaction's own fiber. */
interface TransactionFrame<A, E> {
  bodyExit: Exit.Exit<A, E> | null;
  closeSeal: (() => void) | null;
  readonly lifetime: Lifetime;
}

const makeFrame = <A, E>(sequence: number): TransactionFrame<A, E> => ({
  bodyExit: null,
  closeSeal: null,
  lifetime: makeLifetime(sequence),
});

/** Revokes the handle and closes the seal, once. */
const endFrame = <A, E>(frame: TransactionFrame<A, E>) =>
  Effect.sync(() => {
    frame.lifetime.revoke();
    const close = frame.closeSeal;
    frame.closeSeal = null;
    close?.();
  });

const fence = (transaction: CoreTransaction, request: TransactionRequest) => {
  const revision = request.execution.admittedRevision;
  if (revision === undefined) {
    return Effect.void;
  }
  return lockApplicationCompositionAuthority(
    transaction,
    revision,
    request.execution.transactionMode === 'read_only' ? 'read' : 'write',
  ).pipe(
    Effect.asVoid,
    Effect.catchIf(Schema.is(ApplicationCompositionAuthorityError), (failure) =>
      Effect.fail(abortedBy('composition_changed')(failure)),
    ),
  );
};

/**
 * The opener's answer for a transaction that never reached the body, or whose COMMIT failed: its own
 * `TransactionAborted`; an SQL failure of BEGIN, the mode, the fence, the scope, the clock or COMMIT as
 * `database_unavailable`. Interruption and foreign defects stay as they are.
 */
const openerCause = (cause: Cause.Cause<unknown>): Cause.Cause<TransactionAborted> => {
  const reasons: Cause.Reason<TransactionAborted>[] = [];
  let unavailable = false;
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      if (Schema.is(TransactionAborted)(reason.error)) {
        reasons.push(Cause.makeFailReason(reason.error));
      } else {
        unavailable = true;
      }
    } else if (Cause.isDieReason(reason) && isSqlError(reason.defect)) {
      unavailable = true;
    } else {
      reasons.push(reason);
    }
  }
  if (unavailable && !reasons.some((reason) => Cause.isFailReason(reason))) {
    reasons.push(Cause.makeFailReason(new TransactionAborted({ reason: 'database_unavailable' })));
  }
  return Cause.fromReasons(reasons);
};

const driverConfig = (request: TransactionRequest) =>
  ({
    accessMode: request.execution.transactionMode === 'read_only' ? 'read only' : 'read write',
    isolationLevel: 'read committed',
  }) as const;

/**
 * The contract's steps 2 to 5 inside the driver transaction (step 1, the mode, is the driver config):
 * fence, scope, seal, clock, owner rule. Returns the sealed executor and the facts.
 */
const openOwnerScope = Effect.fn('KernelTransactions.openOwnerScope')(function* openOwnerScope<A, E>(
  transaction: CoreTransaction,
  request: TransactionRequest,
  owner: Pick<OwnerBinding<unknown, never>, 'decide' | 'seal'>,
  frame: TransactionFrame<A, E>,
) {
  yield* fence(transaction, request);
  const scoped = yield* installOperationalScope(transaction, request.execution.scope).pipe(
    Effect.mapError(abortedBy('database_unavailable')),
  );
  const sealed = owner.seal(revocableExecutor(scoped, frame.lifetime));
  frame.closeSeal = sealed.close;
  // After the fence wait and the scope install: never earlier than either.
  const operationAt = yield* trustedStatementTime(transaction).pipe(Effect.mapError(abortedBy('database_unavailable')));
  const decision = yield* owner.decide(sealed.transaction, operationAt);
  if (decision === 'denied') {
    return yield* new TransactionAborted({ reason: 'owner_denied' });
  }
  if (decision === 'unavailable') {
    return yield* new TransactionAborted({ reason: 'owner_unavailable' });
  }
  const facts: TransactionFacts = Object.freeze({ operationAt, sequence: request.sequence });
  return { facts, transaction: sealed.transaction };
});

/**
 * Runs the body on its own fiber and joins it. Every child the body forked is awaited before the body
 * counts as ended (`awaitAllChildren`); a child left running when the body fiber exits is interrupted
 * and awaited by that fiber; interrupting the caller interrupts and awaits the body fiber. So no
 * statement of the body is in flight when the transaction commits or rolls back.
 */
const runJoined = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.forkChild(Effect.scoped(Effect.awaitAllChildren(body))).pipe(
    Effect.flatMap((fiber) => Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))),
  );

const ownerTransaction = Effect.fn('KernelTransactions.ownerTransaction')(function* ownerTransaction<
  Services,
  FactoryRequirements,
  A,
  E,
  R,
>(
  transaction: CoreTransaction,
  request: TransactionRequest,
  owner: OwnerBinding<Services, FactoryRequirements>,
  body: (services: Services, facts: TransactionFacts) => Effect.Effect<A, E, R>,
  frame: TransactionFrame<A, E>,
) {
  const opened = yield* openOwnerScope(transaction, request, owner, frame);
  const services = yield* owner
    .build(opened.transaction, request.execution.scope, request.execution.admittedRevision)
    .pipe(Effect.mapError(abortedBy('database_unavailable')));
  const exit = yield* Effect.exit(
    runJoined(Effect.suspend(() => body(services, opened.facts))).pipe(Effect.ensuring(endFrame(frame))),
  );
  // Kept apart from the driver's exit: a body failure is passed on unchanged, never mistaken for (or
  // replaced by) a failure of the opener or of the rollback.
  frame.bodyExit = exit;
  if (Exit.isFailure(exit)) {
    return yield* new RollbackRequested();
  }
  return exit.value;
});

const openTransaction = Effect.fn('KernelTransactions.open')(function* openTransaction<
  Services,
  FactoryRequirements,
  A,
  E,
  R,
>(
  database: KernelDatabase,
  request: TransactionRequest,
  owner: OwnerBinding<Services, FactoryRequirements>,
  body: (services: Services, facts: TransactionFacts) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | TransactionAborted, FactoryRequirements | R> {
  const { executor } = database;
  const frame = makeFrame<A, E>(request.sequence);
  const driverExit = yield* Effect.exit(
    executor.transaction(
      (transaction) =>
        ownerTransaction(transaction, request, owner, body, frame).pipe(Effect.ensuring(endFrame(frame))),
      driverConfig(request),
    ),
  );
  const { bodyExit } = frame;
  if (bodyExit !== null && Exit.isFailure(bodyExit)) {
    return yield* Effect.failCause(bodyExit.cause);
  }
  if (Exit.isSuccess(driverExit)) {
    return driverExit.value;
  }
  return yield* Effect.failCause(openerCause(driverExit.cause));
});

const onlyRollbackRequested = (cause: Cause.Cause<unknown>) =>
  cause.reasons.every((reason) => Cause.isFailReason(reason) && Schema.is(RollbackRequested)(reason.error));

const checkOwnerTransaction = Effect.fn('KernelTransactions.checkOwner')(function* checkOwnerTransaction(
  database: KernelDatabase,
  request: TransactionRequest,
  owner: Pick<OwnerBinding<unknown, never>, 'decide' | 'seal'>,
) {
  const { executor } = database;
  const frame = makeFrame<never, never>(request.sequence);
  const exit = yield* Effect.exit(
    executor.transaction(
      (transaction) =>
        openOwnerScope(transaction, request, owner, frame).pipe(
          // Decided: nothing else runs and nothing commits.
          Effect.andThen(Effect.fail(new RollbackRequested())),
          Effect.ensuring(endFrame(frame)),
        ),
      driverConfig(request),
    ),
  );
  // Success is impossible (the check always ends in RollbackRequested); anything else is the answer.
  return yield* Exit.isFailure(exit) && !onlyRollbackRequested(exit.cause)
    ? Effect.failCause(openerCause(exit.cause))
    : Effect.void;
});

export const KernelTransactionsLive: Layer.Layer<KernelTransactions, never, CoreDatabase> = Layer.effect(
  KernelTransactions,
  Effect.gen(function* makeKernelTransactions() {
    const database = yield* CoreDatabase;
    return KernelTransactions.of({
      checkOwner: (request, owner) => checkOwnerTransaction(database, request, owner),
      open: (request, owner, body) => openTransaction(database, request, owner, body),
    });
  }),
);
