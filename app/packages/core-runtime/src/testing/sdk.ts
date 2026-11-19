/**
 * `@app/core-runtime/testing/sdk`: stand-ins of the two capabilities Core gives module code, for a unit
 * test that runs a module's function (a `{ run }` read today) without Core's runtime.
 *
 * They keep the kernel's one runtime rule, so a module test fails the way production would: a call
 * while a transaction is open, or a transaction while a forked call has not answered, dies
 * `call_inside_transaction`, a transaction inside another dies
 * `nested_transaction`, a call the descriptor does not declare dies `undeclared_call`, and a write call
 * dies `write_call_reserved` until the Action adapter defines its outcomes. Every call
 * answers with the test's typed answer for that name; Core's own work (requirement, caller identity,
 * credential, route, decoding, evidence) is covered by Core's tests, not here.
 */
import { Effect, Schema } from 'effect';
import type { DateTime } from 'effect';

import { ExecutionRuleViolation } from '../execution/contract.ts';
import type {
  CallCapability,
  CallOutcome,
  CallOutcomeOf,
  DeclaredCalls,
  OperationInput,
  TransactionCapability,
  WriteCallOutcome,
} from '../sdk/index.ts';

/** What happened, in order: a transaction began or ended, or a declared call was made. */
export type ExecutionStandInStep =
  | { readonly kind: 'begin'; readonly sequence: number }
  | { readonly input: unknown; readonly kind: 'call'; readonly name: string }
  | { readonly kind: 'end'; readonly sequence: number };

/** The test's answer for each declared call it expects, typed by that call's operation. */
export type ExecutionStandInAnswers<Calls extends DeclaredCalls> = {
  readonly [Name in keyof Calls]?: (
    input: OperationInput<Calls[Name]['operation']>,
  ) => Effect.Effect<CallOutcomeOf<Calls[Name]>>;
};

export interface ExecutionStandInScript<Services, Calls extends DeclaredCalls> {
  readonly answers: ExecutionStandInAnswers<Calls>;
  /** The trusted "now" every transaction reports in its facts. */
  readonly operationAt: DateTime.Utc;
  /** The module's services for the transaction with this sequence (1, 2, ...). */
  readonly services: (sequence: number) => Services;
}

export interface ExecutionStandIn<Services, Calls extends DeclaredCalls> {
  readonly call: CallCapability<Calls>;
  /** Every step so far, in order. */
  readonly steps: readonly ExecutionStandInStep[];
  readonly transaction: TransactionCapability<Services>;
}

type UntypedCall = (
  name: string,
  ...args: readonly unknown[]
) => Effect.Effect<CallOutcome<unknown> | WriteCallOutcome<unknown>>;

/**
 * Where the untyped dispatch meets its typed signature: `name` is checked against the declared `calls`,
 * and the answer for it is typed `CallOutcomeOf<Calls[Name]>` by `ExecutionStandInAnswers`. The overload
 * states that without an assertion, as Core's kernel does.
 */
function asCallCapability<Calls extends DeclaredCalls>(call: UntypedCall): CallCapability<Calls>;
function asCallCapability(call: UntypedCall): UntypedCall {
  return call;
}

type UntypedAnswer = (...input: readonly unknown[]) => Effect.Effect<CallOutcome<unknown> | WriteCallOutcome<unknown>>;

/** The test's answer for `name`, seen untyped by the dispatch (its typed signature is `ExecutionStandInAnswers`). */
function answerFor<Calls extends DeclaredCalls>(
  answers: ExecutionStandInAnswers<Calls>,
  name: string,
): UntypedAnswer | undefined;
function answerFor(answers: Readonly<Record<string, UntypedAnswer | undefined>>, name: string) {
  return Object.hasOwn(answers, name) ? answers[name] : undefined;
}

/** The test called a declared operation it gave no answer for: a mistake in the test, so a defect. */
export class ExecutionStandInAnswerMissing extends Schema.TaggedError<ExecutionStandInAnswerMissing>()(
  'ExecutionStandInAnswerMissing',
  { callName: Schema.String },
) {}

const violation = (rule: ExecutionRuleViolation['rule'], detail: string) =>
  Effect.die(new ExecutionRuleViolation({ detail, rule }));

/**
 * Stand-ins of `call` and `transaction` for the descriptor's declared `calls`. Pass the same `calls`
 * object the descriptor declares, so a call by any other name dies as it would in Core.
 */
export const makeExecutionStandIn = <Services, const Calls extends DeclaredCalls>(
  calls: Calls,
  script: ExecutionStandInScript<Services, Calls>,
): ExecutionStandIn<Services, Calls> => {
  const steps: ExecutionStandInStep[] = [];
  let open = false;
  let callsInFlight = 0;
  let sequence = 0;

  const call = asCallCapability<Calls>((name, input) =>
    Effect.suspend(() => {
      if (!Object.hasOwn(calls, name)) {
        return violation('undeclared_call', `The call ${name} is not declared`);
      }
      if (calls[name]?.operation.kind === 'write') {
        return violation('write_call_reserved', `The call ${name} is a write call`);
      }
      if (open) {
        return violation('call_inside_transaction', `The call ${name} ran while a transaction was open`);
      }
      const answer = answerFor(script.answers, name);
      if (answer === undefined) {
        return Effect.die(new ExecutionStandInAnswerMissing({ callName: name }));
      }
      steps.push({ input, kind: 'call', name });
      callsInFlight += 1;
      // Until the answer is in, or the call is interrupted, no transaction opens beside it.
      return Effect.suspend(() => answer(input)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            callsInFlight -= 1;
          }),
        ),
      );
    }),
  );

  const transaction: TransactionCapability<Services> = (body) =>
    Effect.suspend(() => {
      if (open) {
        return violation('nested_transaction', 'A transaction opened inside another one');
      }
      if (callsInFlight > 0) {
        return violation('call_inside_transaction', 'A transaction opened while a call had not answered');
      }
      open = true;
      sequence += 1;
      const current = sequence;
      steps.push({ kind: 'begin', sequence: current });
      // Built under the same finaliser: a body that throws before it returns an effect still ends here.
      return Effect.suspend(() =>
        body(script.services(current), { operationAt: script.operationAt, sequence: current }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            open = false;
            steps.push({ kind: 'end', sequence: current });
          }),
        ),
      );
    });

  return { call, steps, transaction };
};
