import { Cause, Context, Effect, Exit, Layer, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { computeCanonicalValueHash } from '../../src/actions/repository.ts';
import { KernelCallsLive, routeAnswerOutcome } from '../../src/execution/call.ts';
import { CallRequirementUnresolved } from '../../src/execution/call-requirement-unresolved.ts';
import { CallRequirements } from '../../src/execution/call-requirements.ts';
import { ExecutionRuleViolation } from '../../src/execution/contract.ts';
import type {
  CallExecution,
  CallExecutionRequest,
  CallRouteRequest,
  ResolvedCallRequirement,
  RouteAnswer,
} from '../../src/execution/contract.ts';
import { CoreCallRoute } from '../../src/execution/core-call-route.ts';
import { KernelCalls } from '../../src/execution/kernel-calls.ts';
import { ModuleCallRoute, RouteAnswerSchema } from '../../src/execution/module-call-route.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { coreOperations } from '../../src/sdk/core-operations.ts';
import {
  CallForbiddenSchema,
  CallNotFoundSchema,
  callOkSchema,
  CallRejectedSchema,
  CallUnavailableSchema,
  declaredCall,
  ExecutionIdentitySchema,
  moduleOperation,
  RequirementCallerSchema,
} from '../../src/sdk/index.ts';
import type { AnyDeclaredCall, ExecutionIdentity, RequirementCaller } from '../../src/sdk/index.ts';

/**
 * The call executor: requirement, caller identity, encoding, route, decoding and the typed outcome,
 * with every failure answered as data. Routes and the requirement lookup are scripted; the executor
 * itself is the real one.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000004';
const revision = 'a'.repeat(64);

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:execution-call',
  authMethod: 'session',
  principalId,
  tenantId,
});
const scope: OperationalScope = Object.freeze({ ...principal, correlationId: 'correlation-call' });
const asPerson: ExecutionIdentity = { _tag: 'Request', via: 'person' };
const actionInvocation = Schema.decodeUnknownSync(ExecutionIdentitySchema)({
  _tag: 'ActionInvocation',
  actionInvocationId: '00000000-0000-4000-8000-0000000000aa',
  actionKey: 'commerce.market-catalog.configure',
  attempt: 1,
});

const provider = {
  entrypointKey: 'commerce.customer-context.api.subject-restrictions',
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
} as const;
const subjectRestrictions = moduleOperation({
  kind: 'read',
  path: '/reads/subject-restrictions',
  provider,
  request: Schema.Struct({ count: Schema.NumberFromString }),
  response: Schema.Struct({ total: Schema.NumberFromString }),
});
const moduleCall = declaredCall(subjectRestrictions, 'commerce.market-catalog.requirement.subject');
const coreCall = declaredCall(coreOperations.legalEntityDetail, 'commerce.market-catalog.requirement.legal-entity');

const callersOf = Schema.decodeUnknownSync(Schema.Array(RequirementCallerSchema));
const personCallers = callersOf([{ kind: 'person', legalEntityScope: 'subject' }]);
const registeredCallers = (pinPrincipal: boolean) =>
  callersOf([
    {
      declarationKey: 'commerce.market-catalog.subject.read',
      kind: 'registered',
      legalEntityScope: 'tenant',
      pinPrincipal,
    },
  ]);

const isOk = Schema.is(callOkSchema(Schema.Unknown));
const isForbidden = Schema.is(CallForbiddenSchema);
const isNotFound = Schema.is(CallNotFoundSchema);
const isRejected = Schema.is(CallRejectedSchema);
const isUnavailable = Schema.is(CallUnavailableSchema);

const ruleOf = (exit: Exit.Exit<CallExecution>): ExecutionRuleViolation['rule'] | undefined => {
  const defect = Exit.isFailure(exit) ? Result.getOrUndefined(Cause.findDefect(exit.cause)) : undefined;
  return Schema.is(ExecutionRuleViolation)(defect) ? defect.rule : undefined;
};

const resolvedModule = (callers: readonly RequirementCaller[]): ResolvedCallRequirement => ({
  callers,
  compositionRevision: revision,
  provider,
  providerAppId: 'commerce-customer-context',
  requirementKey: moduleCall.requirementKey,
});

const requestOf = (
  declared: AnyDeclaredCall,
  input: Schema.Json,
  identity: ExecutionIdentity,
): CallExecutionRequest => ({
  declared,
  execution: {
    callerSource: { _tag: 'RequestPrincipal', principal },
    facts: {
      compositionRevision: revision,
      identity,
      operationKey: 'commerce.market-catalog.api.verify-market-eligibility-v1',
      owningModuleKey: 'commerce.market-catalog',
    },
    scope,
  },
  input,
  name: 'subjectRestrictions',
  placement: 'before',
  sequence: 1,
});

interface Script {
  readonly coreAnswer?: RouteAnswer;
  readonly moduleAnswer?: RouteAnswer;
  readonly resolve?: Effect.Effect<ResolvedCallRequirement, CallRequirementUnresolved>;
  readonly withModuleRoute?: boolean;
}

const answered = (encoded: Schema.Json): RouteAnswer => RouteAnswerSchema.members[0].make({ encoded });
const problem = (status: number, code?: string) =>
  RouteAnswerSchema.members[1].make(
    code === undefined ? { reason: `HTTP ${String(status)}`, status } : { code, reason: 'refused', status },
  );
const unreachable = (reason: string) => RouteAnswerSchema.members[2].make({ reason });

const harness = (script: Script) => {
  const sent: { readonly request: CallRouteRequest; readonly route: 'Core' | 'Module' }[] = [];
  const route = (name: 'Core' | 'Module', answer: RouteAnswer | undefined) => ({
    send: (request: CallRouteRequest) =>
      Effect.sync(() => {
        sent.push({ request, route: name });
        return answer ?? answered({ total: '7' });
      }),
  });
  const base = Layer.mergeAll(
    Layer.succeed(CallRequirements, {
      resolve: () => script.resolve ?? Effect.succeed(resolvedModule(personCallers)),
    }),
    Layer.succeed(CoreCallRoute, route('Core', script.coreAnswer)),
  );
  const layer =
    script.withModuleRoute === false
      ? KernelCallsLive.pipe(Layer.provide(base))
      : KernelCallsLive.pipe(
          Layer.provide(Layer.merge(base, Layer.succeed(ModuleCallRoute, route('Module', script.moduleAnswer)))),
        );
  const execute = (request: CallExecutionRequest) =>
    Effect.scoped(
      Layer.build(layer).pipe(Effect.flatMap((context) => Context.get(context, KernelCalls).execute(request))),
    );
  return { execute, sent };
};

it('maps every route observation to its typed outcome (status table)', () => {
  expect(isNotFound(routeAnswerOutcome(problem(404)))).toBe(true);
  expect(isForbidden(routeAnswerOutcome(problem(401)))).toBe(true);
  expect(isForbidden(routeAnswerOutcome(problem(403)))).toBe(true);
  const conflict = routeAnswerOutcome(problem(409, 'stale_offer'));
  expect(isRejected(conflict)).toBe(true);
  expect(conflict).toMatchObject({ code: 'stale_offer' });
  const ineligible = routeAnswerOutcome(problem(422, 'ineligible'));
  expect(isRejected(ineligible)).toBe(true);
  expect(ineligible).toMatchObject({ code: 'ineligible' });
  for (const [answer, retryable] of [
    [problem(503), true],
    [problem(500), false],
    [problem(400), false],
    [unreachable('down'), true],
  ] as const) {
    const outcome = routeAnswerOutcome(answer);
    expect(isUnavailable(outcome)).toBe(true);
    expect(outcome).toMatchObject({ retryable });
  }
});

it.effect('encodes by the request schema, decodes by the response schema and records the call', () =>
  Effect.gen(function* okCall() {
    const { execute, sent } = harness({});
    const result = yield* execute(requestOf(moduleCall, { count: 3 }, asPerson));
    expect(isOk(result.outcome)).toBe(true);
    expect(result.outcome).toMatchObject({ value: { total: 7 } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.route).toBe('Module');
    expect(sent[0]?.request.encodedInput).toEqual({ count: '3' });
    expect(sent[0]?.request.caller).toEqual({ kind: 'person', legalEntityScope: 'subject' });
    expect(result.record).toMatchObject({
      callerKind: 'person',
      name: 'subjectRestrictions',
      outcome: 'Ok',
      placement: 'before',
      provider,
      requirementKey: moduleCall.requirementKey,
      route: 'Module',
      sequence: 1,
    });
  }),
);

it.effect('answers an unencodable input and an undecodable answer as Unavailable, never a failure', () =>
  Effect.gen(function* encodingFailures() {
    const unencodable = harness({});
    const refused = yield* unencodable.execute(requestOf(moduleCall, { count: 'not a number' }, asPerson));
    expect(isUnavailable(refused.outcome)).toBe(true);
    expect(refused.outcome).toMatchObject({ retryable: false });
    expect(unencodable.sent).toHaveLength(0);

    const undecodable = harness({ moduleAnswer: answered({ total: 7 }) });
    const broken = yield* undecodable.execute(requestOf(moduleCall, { count: 1 }, asPerson));
    expect(isUnavailable(broken.outcome)).toBe(true);
    expect(broken.outcome).toMatchObject({ retryable: false });
    expect(broken.record.outcome).toBe('Unavailable');
  }),
);

it.effect('maps a route problem and an unreachable provider through the executor', () =>
  Effect.gen(function* routeProblems() {
    const notFound = yield* harness({ moduleAnswer: problem(404) }).execute(
      requestOf(moduleCall, { count: 1 }, asPerson),
    );
    expect(isNotFound(notFound.outcome)).toBe(true);
    const rejected = yield* harness({ moduleAnswer: problem(409, 'stale') }).execute(
      requestOf(moduleCall, { count: 1 }, asPerson),
    );
    expect(isRejected(rejected.outcome)).toBe(true);
    expect(rejected.outcome).toMatchObject({ code: 'stale' });
    const down = yield* harness({ moduleAnswer: unreachable('gone') }).execute(
      requestOf(moduleCall, { count: 1 }, asPerson),
    );
    expect(isUnavailable(down.outcome)).toBe(true);
    expect(down.outcome).toMatchObject({ reason: 'gone', retryable: true });
  }),
);

it.effect('answers a missing requirement and a provider mismatch as Unavailable without sending', () =>
  Effect.gen(function* unresolved() {
    for (const reason of ['not_declared', 'provider_mismatch', 'lease_mismatch'] as const) {
      const { execute, sent } = harness({ resolve: Effect.fail(new CallRequirementUnresolved({ reason })) });
      const result = yield* execute(requestOf(moduleCall, { count: 1 }, asPerson));
      expect(isUnavailable(result.outcome)).toBe(true);
      expect(result.outcome).toMatchObject({ retryable: reason === 'lease_mismatch' });
      expect(result.record.callerKind).toBe('refused');
      expect(sent).toHaveLength(0);
    }
  }),
);

it.effect('answers Forbidden without sending when the implied caller kind is not permitted', () =>
  Effect.gen(function* notPermitted() {
    const { execute, sent } = harness({ resolve: Effect.succeed(resolvedModule(registeredCallers(false))) });
    const result = yield* execute(requestOf(moduleCall, { count: 1 }, asPerson));
    expect(isForbidden(result.outcome)).toBe(true);
    expect(result.record.callerKind).toBe('refused');
    expect(sent).toHaveLength(0);
  }),
);

it.effect('sends a recovery call as the registered caller with the hash of the decoded input', () =>
  Effect.gen(function* recovery() {
    const { execute, sent } = harness({ resolve: Effect.succeed(resolvedModule(registeredCallers(true))) });
    const result = yield* execute(requestOf(moduleCall, { count: 5 }, { _tag: 'Request', via: 'recovery' }));
    expect(isOk(result.outcome)).toBe(true);
    expect(sent[0]?.request.caller).toEqual({
      declarationKey: 'commerce.market-catalog.subject.read',
      expectedPrincipalId: principalId,
      kind: 'registered',
      legalEntityScope: 'tenant',
      recoveryRequestHash: computeCanonicalValueHash({ count: 5 }),
    });
  }),
);

it.effect('runs a Core provider in-process for every identity kind, without caller selection', () =>
  Effect.gen(function* coreForEveryone() {
    const identities: readonly ExecutionIdentity[] = [
      asPerson,
      { _tag: 'Request', via: 'workload' },
      { _tag: 'Request', via: 'recovery' },
      { _tag: 'Request', via: 'system' },
      actionInvocation,
    ];
    const legalEntityRef = {
      moduleId: 'core.identity',
      resourceId: '00000000-0000-4000-8000-000000000002',
      resourceType: 'core.identity.legal-entity',
      tenantId,
    };
    for (const identity of identities) {
      const { execute, sent } = harness({
        coreAnswer: answered({ legalEntityRef, status: 'active' }),
        resolve: Effect.succeed({
          callers: [],
          compositionRevision: revision,
          provider: coreCall.operation.provider,
          providerAppId: 'core.identity',
          requirementKey: coreCall.requirementKey,
        }),
        withModuleRoute: false,
      });
      const result = yield* execute(requestOf(coreCall, { legalEntityRef }, identity));
      expect(isOk(result.outcome)).toBe(true);
      expect(result.record.callerKind).toBe('in_process');
      expect(result.record.route).toBe('Core');
      expect(sent.map(({ request, route }) => [route, request.caller.kind])).toEqual([['Core', 'in_process']]);
    }
  }),
);

it.effect('dies module_call_without_route when the host provides no module route', () =>
  Effect.gen(function* withoutRoute() {
    const exit = yield* Effect.exit(
      harness({ withModuleRoute: false }).execute(requestOf(moduleCall, { count: 1 }, asPerson)),
    );
    expect(ruleOf(exit)).toBe('module_call_without_route');
  }),
);
