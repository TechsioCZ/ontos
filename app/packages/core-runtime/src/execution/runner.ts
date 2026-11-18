/**
 * The kernel session of one execution: the two capabilities and the ledger that enforces the kernel's
 * one runtime rule (no call while a transaction of the execution is open, no transaction inside
 * another), the sticky owner denial, the budget, placement, and the end of the session. Kind-neutral:
 * the kind adapter supplies the execution and the owner binding (see `kernel-sessions.ts`).
 */
import { Cause, Clock, Context, Effect, Fiber, Layer, Schema, Scope } from 'effect';

import type {
  AnyDeclaredCall,
  CallCapability,
  CallOutcome,
  DeclaredCalls,
  ExecutionCapabilities,
  ExecutionIdentity,
  TransactionFacts,
  WriteCallOutcome,
} from '../sdk/index.ts';
import { CallForbiddenSchema, CallUnavailableSchema, TransactionAborted } from '../sdk/index.ts';
import { ExecutionRuleViolation } from './contract.ts';
import type { CallExecutionRequest, CallRecord, KernelExecution, KernelSession, OwnerBinding } from './contract.ts';
import { KernelCalls } from './kernel-calls.ts';
import type { KernelCallsService } from './kernel-calls.ts';
import { KernelSessions } from './kernel-sessions.ts';
import { KernelTransactions } from './kernel-transactions.ts';
import type { KernelTransactionsService } from './kernel-transactions.ts';

/** Everything the session observed. Read and changed only synchronously, so each check is atomic. */
interface Ledger {
  anyTransactionEnded: boolean;
  callsAttempted: number;
  callsInFlight: number;
  callsSent: number;
  closed: boolean;
  ownerDenied: boolean;
  readonly records: CallRecord[];
  transactionOpen: boolean;
  transactions: number;
}

/** What the session uses of the transaction opener and the call executor. */
interface KernelPorts {
  readonly checkOwner: KernelTransactionsService['checkOwner'];
  readonly execute: KernelCallsService['execute'];
  readonly open: KernelTransactionsService['open'];
}

interface SessionState<Services, Calls extends DeclaredCalls, Requirements> {
  /** The factory's requirements as the session opened. */
  readonly captured: Context.Context<Requirements>;
  readonly execution: KernelExecution<Calls>;
  readonly ledger: Ledger;
  readonly owner: OwnerBinding<Services, Requirements>;
  readonly ports: KernelPorts;
  readonly sessionScope: Scope.Scope;
  readonly startedAt: number;
}

type Refusal = Readonly<{ readonly refusal: ExecutionRuleViolation['rule'] }>;

const refusal = (rule: ExecutionRuleViolation['rule']): Refusal => ({ refusal: rule });

const die = (rule: ExecutionRuleViolation['rule'], detail: string) =>
  Effect.die(new ExecutionRuleViolation({ detail, rule }));

const transactionExecution = <Calls extends DeclaredCalls>(execution: KernelExecution<Calls>) => ({
  facts: execution.facts,
  scope: execution.scope,
  transactionMode: execution.transactionMode,
});

const durationSpent = <Calls extends DeclaredCalls>(
  state: Pick<SessionState<unknown, Calls, never>, 'execution' | 'startedAt'>,
  now: number,
) => now - state.startedAt >= state.execution.budget.maxDurationMillis;

/* Transactions ----------------------------------------------------------------------------------- */

type TransactionAdmission =
  | Refusal
  | Readonly<{ readonly aborted: 'budget_exhausted' | 'owner_denied' }>
  | Readonly<{ readonly sequence: number }>;

const admitTransaction = <Services, Calls extends DeclaredCalls, Requirements>(
  state: SessionState<Services, Calls, Requirements>,
  now: number,
): TransactionAdmission => {
  const { budget } = state.execution;
  const { ledger } = state;
  if (ledger.closed) {
    return refusal('capability_after_execution');
  }
  if (ledger.transactionOpen) {
    return refusal('nested_transaction');
  }
  if (ledger.callsInFlight > 0) {
    // Module code forked a call that has not answered: the transaction would run beside it.
    return refusal('call_inside_transaction');
  }
  if (ledger.ownerDenied) {
    return { aborted: 'owner_denied' };
  }
  if (ledger.transactions >= budget.maxTransactions || durationSpent(state, now)) {
    return { aborted: 'budget_exhausted' };
  }
  ledger.transactionOpen = true;
  ledger.transactions += 1;
  return { sequence: ledger.transactions };
};

const isOwnerDenial = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      Schema.is(TransactionAborted)(reason.error) &&
      reason.error.reason === 'owner_denied',
  );

const settleTransaction = (ledger: Ledger) =>
  Effect.sync(() => {
    ledger.transactionOpen = false;
    ledger.anyTransactionEnded = true;
  });

const recordDenial = (ledger: Ledger, cause: Cause.Cause<unknown>) =>
  Effect.sync(() => {
    if (isOwnerDenial(cause)) {
      ledger.ownerDenied = true;
    }
  });

const runTransaction = Effect.fn('KernelSession.transaction')(function* runTransaction<
  Services,
  Calls extends DeclaredCalls,
  Requirements,
  A,
  E,
  R,
>(
  state: SessionState<Services, Calls, Requirements>,
  body: (services: Services, facts: TransactionFacts) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | TransactionAborted, R> {
  const now = yield* Clock.currentTimeMillis;
  const admitted = yield* Effect.sync(() => admitTransaction(state, now));
  if ('refusal' in admitted) {
    return yield* die(admitted.refusal, `A transaction was refused: ${admitted.refusal}`);
  }
  if ('aborted' in admitted) {
    return yield* new TransactionAborted({ reason: admitted.aborted });
  }
  const { captured, ledger } = state;
  const opened = state.ports
    .open({ execution: transactionExecution(state.execution), sequence: admitted.sequence }, state.owner, body)
    .pipe(
      // The factory's requirements come from the session; the fiber's own context wins where both hold
      // a service (its span, its references).
      Effect.updateContext((current: Context.Context<R>) => Context.merge(captured, current)),
      Effect.onError((cause) => recordDenial(ledger, cause)),
      Effect.ensuring(settleTransaction(ledger)),
    );
  // Forked into the session scope, so closing the session interrupts (and so rolls back) a transaction
  // still open; interrupting the caller interrupts it as well.
  const fiber = yield* Effect.forkIn(opened, state.sessionScope);
  return yield* Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
});

/* Calls ------------------------------------------------------------------------------------------ */

type CallAdmission =
  | Refusal
  | Readonly<{ readonly answer: CallOutcome<never> }>
  | Readonly<{
      readonly declared: AnyDeclaredCall;
      readonly placement: CallRecord['placement'];
      readonly sequence: number;
    }>;

/** A call answered by the session itself, without leaving the process. */
const localRecord = (
  declared: AnyDeclaredCall,
  name: string,
  outcome: CallRecord['outcome'],
  placement: CallRecord['placement'],
  sequence: number,
): CallRecord =>
  Object.freeze({
    callerKind: 'refused',
    durationMillis: 0,
    name,
    outcome,
    placement,
    provider: declared.operation.provider,
    requirementKey: declared.requirementKey,
    route: declared.operation.route._tag,
    sequence,
  });

const declaredCallOf = (calls: DeclaredCalls, name: string): AnyDeclaredCall | undefined =>
  Object.hasOwn(calls, name) ? calls[name] : undefined;

const admitCall = <Services, Calls extends DeclaredCalls, Requirements>(
  state: SessionState<Services, Calls, Requirements>,
  name: string,
  now: number,
): CallAdmission => {
  const { ledger } = state;
  if (ledger.closed) {
    return refusal('capability_after_execution');
  }
  if (ledger.transactionOpen) {
    return refusal('call_inside_transaction');
  }
  const declared = declaredCallOf(state.execution.calls, name);
  if (declared === undefined) {
    return refusal('undeclared_call');
  }
  if (declared.operation.kind === 'write') {
    return refusal('write_call_reserved');
  }
  ledger.callsAttempted += 1;
  const sequence = ledger.callsAttempted;
  const placement = ledger.anyTransactionEnded ? 'after' : 'before';
  if (ledger.ownerDenied) {
    const answer = CallForbiddenSchema.make({ reason: 'The owner rule denied this execution; the call was not sent' });
    ledger.records.push(localRecord(declared, name, answer._tag, placement, sequence));
    return { answer };
  }
  if (ledger.callsSent >= state.execution.budget.maxCalls || durationSpent(state, now)) {
    const answer = CallUnavailableSchema.make({ reason: 'The execution has spent its call budget', retryable: false });
    ledger.records.push(localRecord(declared, name, answer._tag, placement, sequence));
    return { answer };
  }
  ledger.callsSent += 1;
  ledger.callsInFlight += 1;
  return { declared, placement, sequence };
};

const settleCall = (ledger: Ledger) =>
  Effect.sync(() => {
    ledger.callsInFlight -= 1;
  });

const runCall = Effect.fn('KernelSession.call')(function* runCall<Services, Calls extends DeclaredCalls, Requirements>(
  state: SessionState<Services, Calls, Requirements>,
  name: string,
  input: CallExecutionRequest['input'],
): Effect.fn.Return<CallOutcome<unknown> | WriteCallOutcome<unknown>> {
  const now = yield* Clock.currentTimeMillis;
  const admitted = yield* Effect.sync(() => admitCall(state, name, now));
  if ('refusal' in admitted) {
    return yield* die(admitted.refusal, `The call '${name}' was refused: ${admitted.refusal}`);
  }
  if ('answer' in admitted) {
    return admitted.answer;
  }
  const { execution, ledger } = state;
  const executed = yield* state.ports
    .execute({
      declared: admitted.declared,
      execution: {
        callerSource: execution.callerSource,
        facts: execution.facts,
        scope: execution.scope,
      },
      input,
      name,
      placement: admitted.placement,
      sequence: admitted.sequence,
    })
    .pipe(Effect.ensuring(settleCall(ledger)));
  ledger.records.push(executed.record);
  return executed.outcome;
});

type UntypedCall = (
  name: string,
  ...args: readonly unknown[]
) => Effect.Effect<CallOutcome<unknown> | WriteCallOutcome<unknown>>;

/**
 * Where the untyped call meets its typed signature: `name` is checked against `execution.calls` before
 * anything runs, `KernelCalls` decodes an `Ok` value with that declared operation's own response schema,
 * and write calls die before they are sent, so the outcome is `CallOutcomeOf<Calls[Name]>` for the name
 * the module passed. The overload states that without an assertion.
 */
function asCallCapability<Calls extends DeclaredCalls>(call: UntypedCall): CallCapability<Calls>;
function asCallCapability(call: UntypedCall): UntypedCall {
  return call;
}

/* Session ---------------------------------------------------------------------------------------- */

const openSession = Effect.fn('KernelSessions.open')(function* openSession<
  Services,
  Calls extends DeclaredCalls,
  Requirements,
  Identity extends ExecutionIdentity,
>(
  ports: KernelPorts,
  execution: KernelExecution<Calls, Identity>,
  owner: OwnerBinding<Services, Requirements>,
): Effect.fn.Return<KernelSession<Services, Calls, Identity>, TransactionAborted, Requirements | Scope.Scope> {
  const captured = yield* Effect.context<Requirements>();
  const sessionScope = yield* Scope.Scope;
  const startedAt = yield* Clock.currentTimeMillis;
  // Authority before module code: no session exists for an execution its owner rule denies.
  yield* ports.checkOwner({ execution: transactionExecution(execution), sequence: 0 }, owner);

  const ledger: Ledger = {
    anyTransactionEnded: false,
    callsAttempted: 0,
    callsInFlight: 0,
    callsSent: 0,
    closed: false,
    ownerDenied: false,
    records: [],
    transactionOpen: false,
    transactions: 0,
  };
  yield* Scope.addFinalizer(
    sessionScope,
    Effect.sync(() => {
      ledger.closed = true;
    }),
  );
  const state: SessionState<Services, Calls, Requirements> = {
    captured,
    execution,
    ledger,
    owner,
    ports,
    sessionScope,
    startedAt,
  };
  const capabilities: ExecutionCapabilities<Services, Calls, Identity> = {
    call: asCallCapability<Calls>((name, ...args) => runCall(state, name, args[0])),
    execution: execution.facts,
    transaction: (body) => runTransaction(state, body),
  };
  return Object.freeze({
    callRecords: Effect.sync(() =>
      Object.freeze(ledger.records.toSorted((left, right) => left.sequence - right.sequence)),
    ),
    capabilities: Object.freeze(capabilities),
    ownerDenied: Effect.sync(() => ledger.ownerDenied),
    transactionCount: Effect.sync(() => ledger.transactions),
  });
});

export const KernelSessionsLive: Layer.Layer<KernelSessions, never, KernelTransactions | KernelCalls> = Layer.effect(
  KernelSessions,
  Effect.gen(function* makeKernelSessions() {
    const kernelTransactions = yield* KernelTransactions;
    const kernelCalls = yield* KernelCalls;
    const ports: KernelPorts = {
      checkOwner: kernelTransactions.checkOwner,
      execute: kernelCalls.execute,
      open: kernelTransactions.open,
    };
    return KernelSessions.of({ open: (execution, owner) => openSession(ports, execution, owner) });
  }),
);
