// @effect-diagnostics asyncFunction:off strictEffectProvide:off -- Node test and logger capture entrypoints; expires: 2026-12-31.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runEffectTestPromise } from '../../src/testing/effect-runtime.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { ModuleStateCheckUnavailableError } from '../../src/modules/module-state-check-unavailable-error.ts';
import { ModuleStateDeniedError } from '../../src/modules/module-state-denied-error.ts';
import { OperationAuthenticationRequired } from '../../src/operations/operation-authentication-required.ts';
import { OperationContextDenied } from '../../src/operations/operation-context-denied.ts';
import { OperationContextInvalid } from '../../src/operations/operation-context-invalid.ts';
import { OperationContextUnavailable } from '../../src/operations/operation-context-unavailable.ts';
import { ReadEvidencePersistenceError } from '../../src/reads/read-evidence-persistence-error.ts';
import { ReadEvidenceValidationError } from '../../src/reads/read-evidence-validation-error.ts';
import { ReadHandlerExecutionError } from '../../src/reads/read-handler-execution-error.ts';
import { ReadHandlerNotFound } from '../../src/reads/read-handler-not-found.ts';
import { ReadHandlerUnavailable } from '../../src/reads/read-handler-unavailable.ts';
import { ReadInputValidationError } from '../../src/reads/read-input-validation-error.ts';
import { ReadPermissionDenied } from '../../src/reads/read-permission-denied.ts';
import { ReadPermissionUnavailable } from '../../src/reads/read-permission-unavailable.ts';
import { ReadPolicyDenied } from '../../src/reads/read-policy-denied.ts';
import { ReadPolicyEvaluationError } from '../../src/reads/read-policy-evaluation-error.ts';
import { ReadResultValidationError } from '../../src/reads/read-result-validation-error.ts';
import {
  classifyReadCoreError,
  makeGovernedReadHttpHandler,
} from '../../src/http/governed-read.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { ReadRuntime } from '../../src/reads/runtime.ts';
import type { ReadCoreError } from '../../src/reads/errors.ts';
import type { ReadRuntimeService } from '../../src/reads/runtime.ts';
import { Cause, Effect, Exit, Logger, Redacted, Schema } from 'effect';
import { Headers, HttpServerRequest } from 'effect/unstable/http';

const problem = <const Kind extends string, const Status extends number>(
  kind: Kind,
  status: Status,
) => ({ kind, status });

const problems = {
  authentication: () => problem('authentication', 401),
  forbidden: () => problem('forbidden', 403),
  internal: () => problem('internal', 500),
  invalid: () => problem('invalid', 400),
  notFound: () => problem('not-found', 404),
  policyConflict: () => problem('policy-conflict', 409),
  policyIneligible: () => problem('policy-ineligible', 422),
  unavailable: () => problem('unavailable', 503),
};

const capturedLoggerLayer = (entries: string[]) =>
  Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);

const reason = 'safe reason';
const coreFailures: readonly [
  ReadCoreError,
  ReturnType<(typeof problems)[keyof typeof problems]>,
][] = [
  [
    new ModuleStateCheckUnavailableError({ code: 'module_state_check_unavailable', reason }),
    problems.unavailable(),
  ],
  [new ModuleStateDeniedError({ code: 'module_state_denied', reason }), problems.forbidden()],
  [
    new OperationAuthenticationRequired({ code: 'operation_authentication_required', reason }),
    problems.authentication(),
  ],
  [new OperationContextDenied({ code: 'operation_context_denied', reason }), problems.forbidden()],
  [
    new OperationContextInvalid({ code: 'operation_context_invalid', reason }),
    problems.forbidden(),
  ],
  [
    new OperationContextUnavailable({ code: 'operation_context_unavailable', reason }),
    problems.unavailable(),
  ],
  [
    new ReadEvidencePersistenceError({ code: 'read_evidence_persistence_failed', reason }),
    problems.unavailable(),
  ],
  [new ReadEvidenceValidationError({ code: 'read_evidence_invalid', reason }), problems.internal()],
  [
    new ReadHandlerExecutionError({ code: 'read_handler_execution_failed', reason }),
    problems.internal(),
  ],
  [new ReadHandlerNotFound({ code: 'read_handler_not_found', reason }), problems.notFound()],
  [
    new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason }),
    problems.unavailable(),
  ],
  [new ReadInputValidationError({ code: 'read_input_invalid', reason }), problems.invalid()],
  [new ReadPermissionDenied({ code: 'read_permission_denied', reason }), problems.forbidden()],
  [
    new ReadPermissionUnavailable({ code: 'read_permission_unavailable', reason }),
    problems.unavailable(),
  ],
  [
    new ReadPolicyEvaluationError({ code: 'read_policy_evaluation_failed', reason }),
    problems.unavailable(),
  ],
  [new ReadResultValidationError({ code: 'read_result_invalid', reason }), problems.internal()],
];

test('classifies every Core governed-read failure through the endpoint problem set', () => {
  for (const [failure, expected] of coreFailures) {
    const actual = classifyReadCoreError(failure, problems);
    assert.equal(actual.kind, expected.kind, failure._tag);
    assert.equal(actual.status, expected.status, failure._tag);
  }
});

test('preserves the explicit Policy denial HTTP status', () => {
  for (const [httpStatus, expected] of [
    [409, 'policy-conflict'],
    [422, 'policy-ineligible'],
  ] as const) {
    const failure = new ReadPolicyDenied({
      code: 'read_policy_denied',
      httpStatus,
      policyReasonCode: 'policy_reason',
      reason,
    });
    const actual = classifyReadCoreError(failure, problems);
    assert.equal(actual.kind, expected);
    assert.equal(actual.status, httpStatus);
  }
});

const registration = defineRead(
  {
    accessKind: 'detail',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'core.shell.governed-http-test',
      moduleKey: 'core.shell',
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.shell.governed-http-test.v1',
    },
    inputSchema: Schema.Struct({ query: Schema.String }),
    legalEntityScope: 'forbidden',
    owningModuleKey: 'core.shell',
    permissionTarget: 'module',
    policies: [],
    readKey: 'core.shell.governed-http-test',
    resultSchema: Schema.Struct({ ok: Schema.Literal(true) }),
    schemaVersion: '1',
  },
  () => Effect.succeed({ evidence: { resultCount: 1 }, result: { ok: true as const } }),
  () => Effect.succeed({}),
  () => ({ kind: 'module', moduleId: 'core.shell' }),
);

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000002',
  authContextRef: 'better-auth-session:governed-http-test',
  authMethod: 'session',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
});

const observed: Parameters<ReadRuntimeService['runRead']>[0][] = [];
// SAFETY: This test double exercises only the handler's runRead call and deliberately omits no
// other ReadRuntimeService member; remove when the generic runtime interface exposes a test port.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test-only generic service double; expires: 2026-12-31.
const readRuntime = {
  runRead: (input: Parameters<ReadRuntimeService['runRead']>[0]) => {
    observed.push(input);
    return Effect.succeed({ ok: true as const });
  },
} as ReadRuntimeService;
const requestService = HttpServerRequest.fromWeb(new Request('https://ontos.test/reads/fixture'));

test('validates correlation before authentication or ReadRuntime acquisition', async () => {
  let authenticationCalls = 0;
  const handler = makeGovernedReadHttpHandler({
    authenticatePrincipal: () => {
      authenticationCalls += 1;
      return Effect.succeed(principal);
    },
    problems,
    registration,
  });
  const exit = await runEffectTestPromise(
    Effect.exit(
      handler({
        payload: { query: 'fixture' },
        request: {
          headers: Headers.fromInput({
            authorization: 'Bearer private',
            'x-correlation-id': '   ',
          }),
        },
      }),
    ).pipe(
      Effect.provideService(ReadRuntime, readRuntime),
      Effect.provideService(HttpServerRequest.HttpServerRequest, requestService),
    ),
  );
  assert.equal(authenticationCalls, 0);
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    assert.deepEqual(Cause.squash(exit.cause), problems.invalid());
  }
});

test('sanitizes synchronous defects across correlation validation and authentication', async () => {
  const cases = [
    {
      handler: makeGovernedReadHttpHandler({
        authenticatePrincipal: () => Effect.succeed(principal),
        problems: {
          ...problems,
          invalid: () => {
            throw new Error('private invalid-problem factory detail');
          },
        },
        registration,
      }),
      headers: Headers.empty,
    },
    {
      handler: makeGovernedReadHttpHandler({
        authenticatePrincipal: (): Effect.Effect<typeof principal> => {
          throw new Error('private authentication adapter detail');
        },
        problems,
        registration,
      }),
      headers: Headers.fromInput({ 'x-correlation-id': 'synchronous-defect' }),
    },
  ];
  const exits = await Promise.all(
    cases.map(
      async ({ handler, headers }) =>
        await runEffectTestPromise(
          Effect.exit(handler({ payload: { query: 'fixture' }, request: { headers } })).pipe(
            Effect.provideService(ReadRuntime, readRuntime),
            Effect.provideService(HttpServerRequest.HttpServerRequest, requestService),
          ),
        ),
    ),
  );
  for (const exit of exits) {
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      const publicFailure = Cause.squash(exit.cause);
      assert.deepEqual(publicFailure, problems.internal());
      assert.doesNotMatch(JSON.stringify(publicFailure), /private/u);
    }
  }
});

test('passes only payload, trusted principal, registration, and correlation to ReadRuntime', async () => {
  const payload = { query: 'fixture' };
  observed.length = 0;
  const handler = makeGovernedReadHttpHandler({
    authenticatePrincipal: (authorization) => {
      assert.equal(Redacted.value(authorization), 'Bearer private');
      return Effect.succeed(principal);
    },
    problems,
    registration,
  });
  const assertDecodedPayloadInput = () =>
    // @ts-expect-error The HTTP framework must pass the schema-decoded payload shape.
    handler({ payload: { query: 123 }, request: { headers: Headers.empty } });
  void assertDecodedPayloadInput;
  const result = await runEffectTestPromise(
    handler({
      payload,
      request: {
        headers: Headers.fromInput({
          authorization: 'Bearer private',
          'x-correlation-id': 'correlation-test',
        }),
      },
    }).pipe(
      Effect.provideService(ReadRuntime, readRuntime),
      Effect.provideService(HttpServerRequest.HttpServerRequest, requestService),
    ),
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(observed, [
    {
      input: payload,
      principal,
      registration,
      transport: { correlationId: 'correlation-test' },
    },
  ]);
});

test('sanitizes unexpected defects at the complete governed handler boundary', async () => {
  // SAFETY: This test double exercises only the handler's runRead call and deliberately omits no
  // other ReadRuntimeService member; remove when the generic runtime interface exposes a test port.
  const defectRuntime = {
    runRead: () => Effect.die(new Error('private database connection detail')),
  } as ReadRuntimeService;
  const handler = makeGovernedReadHttpHandler({
    authenticatePrincipal: () => Effect.succeed(principal),
    problems,
    registration,
  });
  const logEntries: string[] = [];
  const exit = await runEffectTestPromise(
    Effect.exit(
      handler({
        payload: { query: 'fixture' },
        request: {
          headers: Headers.fromInput({ 'x-correlation-id': 'correlation-defect' }),
        },
      }),
    ).pipe(
      Effect.provideService(ReadRuntime, defectRuntime),
      Effect.provideService(HttpServerRequest.HttpServerRequest, requestService),
      Effect.provide(capturedLoggerLayer(logEntries)),
    ),
  );
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    const publicFailure = Cause.squash(exit.cause);
    assert.deepEqual(publicFailure, problems.internal());
    assert.doesNotMatch(JSON.stringify(publicFailure), /private database connection detail/u);
  }
  assert.equal(logEntries.length, 1);
  assert.doesNotMatch(logEntries.join('\n'), /private database connection detail/u);
  assert.match(logEntries[0] ?? '', /correlation-defect/u);
});
