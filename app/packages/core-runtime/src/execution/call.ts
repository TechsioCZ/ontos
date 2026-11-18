/**
 * The call executor: one declared read call, from requirement to typed outcome. Everything a module
 * assembled by hand before (requirement lookup, caller identity, credential, routing, revision,
 * decoding) is done here once, and every failure is an outcome, never an error of `call`.
 */
import { Clock, Effect, Layer, Match, Option, Result, Schema } from 'effect';

import { computeCanonicalValueHash } from '../actions/repository.ts';
import { isCoreOperationProvider } from '../modules/module-dependency-contracts.ts';
import {
  callOkSchema,
  CallForbiddenSchema,
  CallNotFoundSchema,
  CallRejectedSchema,
  CallUnavailableSchema,
  CoreOperationRouteSchema,
  RequestExecutionSchema,
} from '../sdk/index.ts';
import type { CallOutcome } from '../sdk/index.ts';
import { CallRequirements } from './call-requirements.ts';
import { ExecutionRuleViolation } from './contract.ts';
import type {
  CallExecutionRequest,
  CallRecord,
  CallRoute,
  CallRouteRequest,
  ResolvedCallRequirement,
  RouteAnswer,
  SelectedCaller,
} from './contract.ts';
import { CoreCallRoute } from './core-call-route.ts';
import { KernelCalls } from './kernel-calls.ts';
import { ModuleCallRoute } from './module-call-route.ts';
import { selectCaller } from './requirements.ts';

const unavailableOutcome = (reason: string, retryable: boolean): CallOutcome<unknown> =>
  CallUnavailableSchema.make({ reason, retryable });

const problemOutcome = (status: number, reason: string, code: string | undefined): CallOutcome<unknown> => {
  if (status === 404) {
    return CallNotFoundSchema.make({ reason });
  }
  if (status === 401 || status === 403) {
    return CallForbiddenSchema.make({ reason });
  }
  if (status === 409 || status === 422) {
    return CallRejectedSchema.make({ code: code ?? `http_${String(status)}`, reason });
  }
  return unavailableOutcome(reason, status === 503);
};

/**
 * A route's observation of a provider that did not answer as an outcome. 404 is not found; 401 and 403
 * are a refusal of this caller; 409 and 422 are the provider's own rule with its problem code; 503 and
 * an unreachable provider are a retryable outage; any other status is a non-retryable outage.
 */
export const routeAnswerOutcome = (answer: Exclude<RouteAnswer, { readonly _tag: 'Answered' }>): CallOutcome<unknown> =>
  Match.value(answer).pipe(
    Match.tagsExhaustive({
      Problem: ({ code, reason, status }) => problemOutcome(status, reason, code),
      Unreachable: ({ reason }) => unavailableOutcome(reason, true),
    }),
  );

interface Step {
  readonly callerKind: CallRecord['callerKind'];
  readonly outcome: CallOutcome<unknown>;
}

const refused = (outcome: CallOutcome<unknown>): Step => ({ callerKind: 'refused', outcome });

const isRecovery = (request: CallExecutionRequest): boolean => {
  const { identity } = request.execution.facts;
  return Schema.is(RequestExecutionSchema)(identity) && identity.via === 'recovery';
};

/** The caller identity of this call: in-process for a Core provider, otherwise the one the identity implies. */
const callerFor = (
  request: CallExecutionRequest,
  requirement: ResolvedCallRequirement,
): Effect.Effect<Option.Option<SelectedCaller>> => {
  if (isCoreOperationProvider(requirement.provider)) {
    return Effect.succeed(Option.some(Object.freeze({ kind: 'in_process' as const })));
  }
  const { callerSource, facts } = request.execution;
  return selectCaller(facts.identity, requirement.callers, {
    principalId: callerSource.principal.principalId,
    recoveryRequestHash: isRecovery(request) ? computeCanonicalValueHash(request.input) : undefined,
  }).pipe(Effect.option);
};

/** Decodes a provider's success answer by the operation's own response schema. */
const decodedAnswer = (
  request: CallExecutionRequest,
  answer: Extract<RouteAnswer, { readonly _tag: 'Answered' }>,
): Effect.Effect<CallOutcome<unknown>> =>
  Schema.decodeUnknownEffect(request.declared.operation.response)(answer.encoded).pipe(
    Effect.map((value): CallOutcome<unknown> => callOkSchema(Schema.Unknown).make({ value })),
    Effect.orElseSucceed(() => unavailableOutcome('The provider answer does not match the operation response', false)),
  );

const makeExecute = Effect.fn('KernelCalls.make')(function* makeExecute() {
  const requirements = yield* CallRequirements;
  const coreRoute = yield* CoreCallRoute;
  const moduleRoute = yield* Effect.serviceOption(ModuleCallRoute);

  const routeOf = Effect.fn('KernelCalls.route')(function* routeOf(request: CallExecutionRequest) {
    if (Schema.is(CoreOperationRouteSchema)(request.declared.operation.route)) {
      return coreRoute;
    }
    return yield* Option.match(moduleRoute, {
      onNone: () =>
        Effect.die(
          new ExecutionRuleViolation({
            detail: `Call ${request.name} needs the module route, which this host does not provide`,
            rule: 'module_call_without_route',
          }),
        ),
      onSome: (route: CallRoute) => Effect.succeed(route),
    });
  });

  const send = Effect.fn('KernelCalls.send')(function* send(request: CallExecutionRequest) {
    const { operation } = request.declared;
    const resolved = yield* requirements
      .resolve(request.declared.requirementKey, operation, request.execution.callerSource)
      .pipe(Effect.result);
    if (Result.isFailure(resolved)) {
      const { reason } = resolved.failure;
      return refused(unavailableOutcome(`The call requirement is unresolved: ${reason}`, reason === 'lease_mismatch'));
    }
    const requirement = resolved.success;
    if (isCoreOperationProvider(requirement.provider) !== Schema.is(CoreOperationRouteSchema)(operation.route)) {
      return refused(unavailableOutcome('The operation reference names another route than its provider', false));
    }
    const caller = yield* callerFor(request, requirement);
    if (Option.isNone(caller)) {
      return refused(CallForbiddenSchema.make({ reason: 'The requirement does not permit this execution as caller' }));
    }
    const callerKind = caller.value.kind;
    const encoded = yield* Schema.encodeUnknownEffect(operation.request)(request.input).pipe(Effect.option);
    if (Option.isNone(encoded)) {
      return { callerKind, outcome: unavailableOutcome('The call input does not match the operation request', false) };
    }
    const route = yield* routeOf(request);
    const routeRequest: CallRouteRequest = {
      caller: caller.value,
      encodedInput: encoded.value,
      execution: request.execution,
      operation,
      requirement,
    };
    const answer = yield* route.send(
      request.idempotencyKey === undefined ? routeRequest : { ...routeRequest, idempotencyKey: request.idempotencyKey },
    );
    const outcome = yield* Match.value(answer).pipe(
      Match.tagsExhaustive({
        Answered: (answered) => decodedAnswer(request, answered),
        Problem: (problem) => Effect.succeed(routeAnswerOutcome(problem)),
        Unreachable: (unreachable) => Effect.succeed(routeAnswerOutcome(unreachable)),
      }),
    );
    return { callerKind, outcome };
  });

  // A write call never reaches here: the session refuses it first (`write_call_reserved`).
  return Effect.fn('KernelCalls.execute')(function* execute(request: CallExecutionRequest) {
    const { operation } = request.declared;
    const started = yield* Clock.currentTimeMillis;
    const step = yield* send(request);
    const finished = yield* Clock.currentTimeMillis;
    const record: CallRecord = Object.freeze({
      callerKind: step.callerKind,
      durationMillis: Math.max(0, finished - started),
      name: request.name,
      outcome: step.outcome._tag,
      placement: request.placement,
      provider: operation.provider,
      requirementKey: request.declared.requirementKey,
      route: operation.route._tag,
      sequence: request.sequence,
    });
    // Never the input or the answer; the request's correlation is annotated where the request enters.
    yield* Effect.logDebug('Module operation call answered').pipe(
      Effect.annotateLogs({
        callerKind: record.callerKind,
        callName: record.name,
        callOutcome: record.outcome,
        durationMillis: record.durationMillis,
        providerEntrypointKey: record.provider.entrypointKey,
        requirementKey: record.requirementKey,
      }),
    );
    return Object.freeze({ outcome: step.outcome, record });
  });
});

/**
 * Needs the requirement lookup and Core's in-process route. The module route is optional: it is read
 * from the layer's own context when the layer is built, so only a host whose reads call verticals
 * provides it, and a module call in any other host dies `module_call_without_route`.
 */
export const KernelCallsLive: Layer.Layer<KernelCalls, never, CallRequirements | CoreCallRoute> = Layer.effect(
  KernelCalls,
  makeExecute().pipe(Effect.map((execute) => KernelCalls.of({ execute }))),
);
