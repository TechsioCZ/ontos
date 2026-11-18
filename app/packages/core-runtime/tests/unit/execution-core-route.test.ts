import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { CallRouteRequest, CoreRunRead, RouteAnswer } from '../../src/execution/contract.ts';
import {
  actionCommitStateRead,
  assignablePrincipalsRead,
  classifyActionCommitState,
  classifyAssignablePrincipals,
  coreOperationRegistrations,
} from '../../src/execution/core-operations.ts';
import { coreCallRouteFor, readErrorProblem } from '../../src/execution/core-route.ts';
import { RouteAnswerSchema } from '../../src/execution/module-call-route.ts';
import { legalEntityDetailRead } from '../../src/generated-reads/legal-entity-detail.ts';
import { isGenuineCoreOperation } from '../../src/modules/module-operation-execution.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { governedReadRegistration } from '../../src/reads/definition.ts';
import {
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPolicyDenied,
} from '../../src/reads/errors.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import {
  ASSIGNABLE_PRINCIPAL_NAMES_FIELD_GROUP,
  AssignablePrincipalsRequestSchema,
  coreOperations,
} from '../../src/sdk/core-operations.ts';
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
const invocationId = '00000000-0000-4000-8000-0000000000aa';
const colleagueId = '00000000-0000-4000-8000-0000000000c1';
const departedId = '00000000-0000-4000-8000-0000000000c2';
const serviceId = '00000000-0000-4000-8000-0000000000c3';

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
const repeatedCandidate = Schema.decodeUnknownSync(AssignablePrincipalsRequestSchema)({
  candidatePrincipalIds: [colleagueId, colleagueId],
  capabilityKey: 'commerce.pricing.task.assign',
});
const operationAt = DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-11-03T09:00:00.000Z')));

const ownerRows = (text: string): readonly object[] | undefined => {
  if (text.includes('"legal_entities"')) {
    return [{ legalName: 'Example Manufacturing', status: 'active' }];
  }
  if (text.includes('"action_invocations"')) {
    return [{ completedAt: null, status: 'succeeded' }];
  }
  if (text.includes('"access_memberships"')) {
    return [{ principalId: colleagueId }];
  }
  if (text.includes('"principals"')) {
    return [
      { displayName: 'Ada Colleague', kind: 'human', principalId: colleagueId, status: 'active' },
      { displayName: 'Bob Departed', kind: 'human', principalId: departedId, status: 'disabled' },
      { displayName: 'Robot', kind: 'service', principalId: serviceId, status: 'active' },
    ];
  }
  return undefined;
};

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
      const rows = ownerRows(text);
      if (rows !== undefined) {
        return Effect.succeed(rows);
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

it('derives the route registry and the genuine Core reads from the same registrations', () => {
  expect(coreOperationRegistrations.map(({ operation }) => operation.provider.entrypointKey).toSorted()).toEqual([
    'core.identity.api.assignable-principals',
    'core.identity.api.legal-entity-detail',
    'core.identity.managed-principals',
    'core.modules.api.action-commit-state',
  ]);
  for (const { operation, registration } of coreOperationRegistrations) {
    expect(isGenuineCoreOperation(registration)).toBe(true);
    expect(registration.descriptor.entrypoint.entrypointKey).toBe(operation.provider.entrypointKey);
  }
  expect(assignablePrincipalsRead.descriptor.accessFieldGroups?.map(({ fields, key }) => [key, fields])).toEqual([
    [ASSIGNABLE_PRINCIPAL_NAMES_FIELD_GROUP, ['eligible.displayName']],
  ]);
  expect(actionCommitStateRead.descriptor.accessDeclaration?.key).toBe('core.modules.action-commit-state.read');
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

it.effect('answers the commit state of an own Action and refuses an Action key of another module', () =>
  Effect.gen(function* commitState() {
    const runtime = yield* makeRuntime(allowAll());
    const { runRead, seen } = recordingRunRead(runtime);
    const route = coreCallRouteFor(runRead);
    const foreign = yield* route.send(
      requestOf(coreOperations.actionCommitState, { actionKey: 'commerce.order.place-order', invocationId }),
    );
    expect(statusOf(foreign)).toBe(403);
    expect(foreign).toMatchObject({ code: 'core_operation_foreign_key' });
    expect(seen).toHaveLength(0);
    const own = yield* route.send(
      requestOf(coreOperations.actionCommitState, { actionKey: 'commerce.pricing.change-price', invocationId }),
    );
    expect(isAnswered(own)).toBe(true);
    expect(own).toMatchObject({
      encoded: { actionKey: 'commerce.pricing.change-price', invocationId, state: 'COMMITTED' },
    });
  }),
);

it.effect('omits displayName without the names field group and keeps it with the grant', () =>
  Effect.gen(function* names() {
    const input = {
      candidatePrincipalIds: [colleagueId, departedId, serviceId, '00000000-0000-4000-8000-0000000000ff'],
      capabilityKey: 'commerce.pricing.task.assign',
    };
    const withoutNames = yield* makeRuntime(
      makeTestBoundAccessGate({
        answers: {
          [ASSIGNABLE_PRINCIPAL_NAMES_FIELD_GROUP]: { outcome: 'DENIED' },
          'core.identity.assignable-principal.read': { outcome: 'ALLOWED' },
        },
      }).bound,
    );
    const unnamed = yield* coreCallRouteFor(coreRunReadOf(withoutNames)).send(
      requestOf(coreOperations.assignablePrincipals, input),
    );
    expect(isAnswered(unnamed) ? unnamed.encoded : undefined).toEqual({
      departedPrincipalIds: [departedId],
      eligible: [{ principalId: colleagueId }],
    });
    const withNames = yield* makeRuntime(allowAll());
    const named = yield* coreCallRouteFor(coreRunReadOf(withNames)).send(
      requestOf(coreOperations.assignablePrincipals, input),
    );
    expect(isAnswered(named) ? named.encoded : undefined).toEqual({
      departedPrincipalIds: [departedId],
      eligible: [{ displayName: 'Ada Colleague', principalId: colleagueId }],
    });
    const foreign = yield* coreCallRouteFor(coreRunReadOf(withNames)).send(
      requestOf(coreOperations.assignablePrincipals, { ...input, capabilityKey: 'commerce.order.task.assign' }),
    );
    expect(statusOf(foreign)).toBe(403);
  }),
);

it.effect('classifies commit states and assignable principals exactly', () =>
  Effect.gen(function* classifiers() {
    expect(yield* classifyActionCommitState([])).toBe('ABSENT');
    expect(yield* classifyActionCommitState([{ completedAt: null, status: 'succeeded' }])).toBe('COMMITTED');
    expect(yield* classifyActionCommitState([{ completedAt: null, status: 'running' }])).toBe('OPEN');
    const terminal = yield* Effect.flip(classifyActionCommitState([{ completedAt: operationAt, status: 'failed' }]));
    expect(Schema.is(ReadHandlerUnavailable)(terminal)).toBe(true);
    const result = yield* classifyAssignablePrincipals(repeatedCandidate, [
      { displayName: 'Ada', kind: 'agent', member: true, principalId: colleagueId, status: 'active' },
    ]);
    expect(result).toEqual({ departedPrincipalIds: [], eligible: [{ displayName: 'Ada', principalId: colleagueId }] });
  }),
);
