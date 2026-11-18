import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { CallRouteRequest, CoreRunRead, RouteAnswer } from '../../src/execution/contract.ts';
import { coreCallRouteFor, readErrorProblem } from '../../src/execution/core-route.ts';
import { RouteAnswerSchema } from '../../src/execution/module-call-route.ts';
import { legalEntityDetailRead } from '../../src/generated-reads/legal-entity-detail.ts';
import { coreOperationRegistrations, isGenuineCoreOperation } from '../../src/modules/module-operation-execution.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { governedReadRegistration } from '../../src/reads/definition.ts';
import { ReadHandlerNotFound, ReadInputValidationError, ReadPolicyDenied } from '../../src/reads/errors.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { coreOperations } from '../../src/sdk/core-operations.ts';
import type { AnyReadOperationRef } from '../../src/sdk/index.ts';
import { makeTestBoundAccessGate } from '../../src/testing/access-gate.ts';
import { makeTestDatabase } from '../support/database.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

/**
 * Core's in-process route: a Core operation runs through the read runtime's own `runRead` with the
 * execution's principal, under the Core read's own decision and field groups, and its answer comes
 * back encoded by the operation's response schema or as the problem a provider would answer.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000004';

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:core-route',
  authMethod: 'session',
  principalId,
  tenantId,
});
const scope: OperationalScope = Object.freeze({
  ...principal,
  correlationId: 'correlation-core',
  traceId: 'trace-core',
});
const legalEntityRef = {
  moduleId: 'core.identity',
  resourceId: '00000000-0000-4000-8000-000000000002',
  resourceType: 'core.identity.legal-entity',
  tenantId,
};
/** The legal entity read's answer, encoded by its response schema as the route must answer it. */
const legalEntityAnswer = Schema.encodeSync(coreOperations.legalEntityDetail.response)({
  legalEntityRef: Schema.decodeUnknownSync(coreOperations.legalEntityDetail.request)({ legalEntityRef }).legalEntityRef,
  legalName: 'Example Manufacturing',
  status: 'active',
});
const operationAt = DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-11-03T09:00:00.000Z')));

const makeRuntime = Effect.fn('CoreRouteSuite.makeRuntime')(function* makeRuntime(
  accessDecision: ReturnType<typeof makeTestBoundAccessGate>['bound'],
) {
  const database = {
    executor: yield* makeTestDatabase((text) => {
      if (text.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      if (text.includes('set_config')) {
        return Effect.succeed([]);
      }
      if (text.includes('transaction_timestamp')) {
        return Effect.succeed([{ operation_at: operationAt }]);
      }
      if (text.includes('"legal_entities"')) {
        return Effect.succeed([{ legalName: 'Example Manufacturing', status: 'active' }]);
      }
      return text.includes('current_setting')
        ? Effect.succeed([{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenantId }])
        : Effect.succeed([]);
    }),
  };
  return makeReadRuntime(
    database,
    openModuleEntrypointGateway,
    { resolve: () => Effect.succeed(scope) },
    {
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    },
    { accessDecision },
  );
});

/** The read runtime's own `runRead`, recording what the route handed it. */
type Runtime = Effect.Success<ReturnType<typeof makeRuntime>>;

/** The read runtime's own `runRead`, as the read runtime hands it to the route. */
const coreRunReadOf =
  (runtime: Runtime): CoreRunRead =>
  (input) =>
    runtime.runRead({ ...input, registration: governedReadRegistration(input.registration) });

/** The same, recording what the route handed it. */
const recordingRunRead = (runtime: Runtime) => {
  const seen: Parameters<CoreRunRead>[0][] = [];
  const run = coreRunReadOf(runtime);
  const runRead: CoreRunRead = (input) => {
    seen.push(input);
    return run(input);
  };
  return { runRead, seen };
};

const [answeredSchema, problemSchema] = RouteAnswerSchema.members;
const isAnswered = Schema.is(answeredSchema);
const isProblem = Schema.is(problemSchema);
const statusOf = (answer: RouteAnswer): number | undefined => (isProblem(answer) ? answer.status : undefined);

const requestOf = (operation: AnyReadOperationRef, encodedInput: Schema.Json): CallRouteRequest => ({
  caller: { kind: 'in_process' },
  encodedInput,
  execution: {
    callerSource: { _tag: 'RequestPrincipal', principal },
    facts: {
      compositionRevision: 'a'.repeat(64),
      identity: { _tag: 'Request', via: 'workload' },
      operationKey: 'commerce.pricing.api.price-result-lookup',
      owningModuleKey: 'commerce.pricing',
    },
    scope,
  },
  operation,
  requirement: {
    callers: [],
    compositionRevision: 'a'.repeat(64),
    provider: operation.provider,
    providerAppId: operation.provider.moduleId,
    requirementKey: 'commerce.pricing.requirement.core',
  },
});

const allowAll = () => makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } }).bound;

it('pairs each Core operation with the genuine Core read that answers it, by the same wire schemas', () => {
  expect(coreOperationRegistrations).toEqual([
    { operation: coreOperations.legalEntityDetail, registration: legalEntityDetailRead },
  ]);
  expect(isGenuineCoreOperation(legalEntityDetailRead)).toBe(true);
  const { descriptor } = legalEntityDetailRead;
  expect({
    entrypointKey: descriptor.entrypoint.entrypointKey,
    moduleId: descriptor.owningModuleKey,
    schemaVersion: descriptor.schemaVersion,
  }).toEqual(coreOperations.legalEntityDetail.provider);
  expect(descriptor.inputSchema).toBe(coreOperations.legalEntityDetail.request);
  expect(descriptor.resultSchema).toBe(coreOperations.legalEntityDetail.response);
});

it.effect('runs the Core read with the execution principal and encodes its answer by the response schema', () =>
  Effect.gen(function* runsAsExecution() {
    const runtime = yield* makeRuntime(allowAll());
    const { runRead, seen } = recordingRunRead(runtime);
    const answer = yield* coreCallRouteFor(runRead).send(
      requestOf(coreOperations.legalEntityDetail, { legalEntityRef }),
    );
    expect(isAnswered(answer)).toBe(true);
    expect(answer).toMatchObject({ encoded: legalEntityAnswer });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.principal).toBe(principal);
    expect(seen[0]?.registration).toBe(legalEntityDetailRead);
    expect(seen[0]?.transport).toEqual({ correlationId: 'correlation-core', traceId: 'trace-core' });
  }),
);

it.effect('maps the Core read failures to problems: denied 403, not found 404', () =>
  Effect.gen(function* failures() {
    const denied = yield* makeRuntime(makeTestBoundAccessGate({ defaultAnswer: { outcome: 'DENIED' } }).bound);
    const deniedAnswer = yield* coreCallRouteFor(coreRunReadOf(denied)).send(
      requestOf(coreOperations.legalEntityDetail, { legalEntityRef }),
    );
    expect(isProblem(deniedAnswer)).toBe(true);
    expect(deniedAnswer).toMatchObject({ code: 'ReadPermissionDenied', status: 403 });
    const allowed = yield* makeRuntime(allowAll());
    const foreign = { ...legalEntityRef, tenantId: '00000000-0000-4000-8000-000000000099' };
    const notFound = yield* coreCallRouteFor(coreRunReadOf(allowed)).send(
      requestOf(coreOperations.legalEntityDetail, { legalEntityRef: foreign }),
    );
    expect(statusOf(notFound)).toBe(404);
  }),
);

it('maps every kind of Read error to its status', () => {
  expect(statusOf(readErrorProblem(new ReadHandlerNotFound({ code: 'read_handler_not_found', reason: 'gone' })))).toBe(
    404,
  );
  expect(statusOf(readErrorProblem(new ReadInputValidationError({ code: 'read_input_invalid', reason: 'bad' })))).toBe(
    400,
  );
  expect(
    statusOf(
      readErrorProblem(
        new ReadPolicyDenied({ code: 'read_policy_denied', httpStatus: 422, policyReasonCode: 'x', reason: 'no' }),
      ),
    ),
  ).toBe(422);
});

it.effect('answers 404 for an unknown Core operation without running anything', () =>
  Effect.gen(function* unknownKey() {
    const runtime = yield* makeRuntime(allowAll());
    const { runRead, seen } = recordingRunRead(runtime);
    const unknown = {
      ...coreOperations.legalEntityDetail,
      provider: { ...coreOperations.legalEntityDetail.provider, entrypointKey: 'core.identity.api.unknown' },
    };
    expect(statusOf(yield* coreCallRouteFor(runRead).send(requestOf(unknown, { legalEntityRef })))).toBe(404);
    const otherVersion = {
      ...coreOperations.legalEntityDetail,
      provider: { ...coreOperations.legalEntityDetail.provider, schemaVersion: '2' },
    };
    expect(statusOf(yield* coreCallRouteFor(runRead).send(requestOf(otherVersion, { legalEntityRef })))).toBe(404);
    expect(seen).toHaveLength(0);
  }),
);
