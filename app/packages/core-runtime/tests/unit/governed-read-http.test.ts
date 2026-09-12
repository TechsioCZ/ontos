import { Cause, Effect, Exit, Logger, Redacted, Schema } from 'effect';
// @effect-diagnostics strictEffectProvide:off -- Test-owned logger capture entrypoint; expires: 2026-12-31.
import { expect, it } from 'effect-rstest';
import { Headers, HttpServerRequest } from 'effect/unstable/http';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { classifyReadCoreError, makeGovernedReadHttpHandler } from '../../src/http/governed-read.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { ModuleStateCheckUnavailableError } from '../../src/modules/module-state-check-unavailable-error.ts';
import { ModuleStateDeniedError } from '../../src/modules/module-state-denied-error.ts';
import { OperationAuthenticationRequired } from '../../src/operations/operation-authentication-required.ts';
import { OperationContextDenied } from '../../src/operations/operation-context-denied.ts';
import { OperationContextInvalid } from '../../src/operations/operation-context-invalid.ts';
import { OperationContextUnavailable } from '../../src/operations/operation-context-unavailable.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { ReadCoreError } from '../../src/reads/errors.ts';
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
import { ReadRuntime } from '../../src/reads/runtime.ts';
import type { ReadRuntimeService } from '../../src/reads/runtime.ts';

const problem = <const Kind extends string, const Status extends number>(kind: Kind, status: Status) => ({
  kind,
  status,
});

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
const coreFailures: readonly [ReadCoreError, ReturnType<(typeof problems)[keyof typeof problems]>][] = [
  [
    new ModuleStateCheckUnavailableError({
      code: 'module_state_check_unavailable',
      reason,
    }),
    problems.unavailable(),
  ],
  [new ModuleStateDeniedError({ code: 'module_state_denied', reason }), problems.forbidden()],
  [
    new OperationAuthenticationRequired({
      code: 'operation_authentication_required',
      reason,
    }),
    problems.authentication(),
  ],
  [new OperationContextDenied({ code: 'operation_context_denied', reason }), problems.forbidden()],
  [new OperationContextInvalid({ code: 'operation_context_invalid', reason }), problems.forbidden()],
  [
    new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason,
    }),
    problems.unavailable(),
  ],
  [
    new ReadEvidencePersistenceError({
      code: 'read_evidence_persistence_failed',
      reason,
    }),
    problems.unavailable(),
  ],
  [new ReadEvidenceValidationError({ code: 'read_evidence_invalid', reason }), problems.internal()],
  [
    new ReadHandlerExecutionError({
      code: 'read_handler_execution_failed',
      reason,
    }),
    problems.internal(),
  ],
  [new ReadHandlerNotFound({ code: 'read_handler_not_found', reason }), problems.notFound()],
  [new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason }), problems.unavailable()],
  [new ReadInputValidationError({ code: 'read_input_invalid', reason }), problems.invalid()],
  [new ReadPermissionDenied({ code: 'read_permission_denied', reason }), problems.forbidden()],
  [
    new ReadPermissionUnavailable({
      code: 'read_permission_unavailable',
      reason,
    }),
    problems.unavailable(),
  ],
  [
    new ReadPolicyEvaluationError({
      code: 'read_policy_evaluation_failed',
      reason,
    }),
    problems.unavailable(),
  ],
  [new ReadResultValidationError({ code: 'read_result_invalid', reason }), problems.internal()],
];

it('classifies every Core governed-read failure through the endpoint problem set', () => {
  for (const [failure, expected] of coreFailures) {
    const actual = classifyReadCoreError(failure, problems);
    expect(actual.kind, JSON.stringify(failure)).toBe(expected.kind);
    expect(actual.status, JSON.stringify(failure)).toBe(expected.status);
  }
});

it('preserves the explicit Policy denial HTTP status', () => {
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
    expect(actual.kind).toBe(expected);
    expect(actual.status).toBe(httpStatus);
  }
});

const registration = defineRead(
  {
    accessKind: 'detail',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: {
        kind: 'context_permission',
        permission: 'module.access',
      },
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
  () =>
    Effect.succeed({
      evidence: { resultCount: 1 },
      result: { ok: true as const },
    }),
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

it.effect('validates correlation before authentication or ReadRuntime acquisition', () =>
  Effect.gen(function* validateCorrelationFirst() {
    let authenticationCalls = 0;
    const handler = makeGovernedReadHttpHandler({
      authenticatePrincipal: () => {
        authenticationCalls += 1;
        return Effect.succeed(principal);
      },
      problems,
      registration,
    });
    const exit = yield* Effect.exit(
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
    );
    expect(authenticationCalls).toBe(0);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toEqual(problems.invalid());
    }
  }),
);

it.effect('sanitizes synchronous defects across correlation validation and authentication', () =>
  Effect.gen(function* sanitizeSynchronousDefects() {
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
        headers: Headers.fromInput({
          'x-correlation-id': 'synchronous-defect',
        }),
      },
    ];
    const exits = yield* Effect.forEach(
      cases,
      ({ handler, headers }) =>
        Effect.exit(handler({ payload: { query: 'fixture' }, request: { headers } })).pipe(
          Effect.provideService(ReadRuntime, readRuntime),
          Effect.provideService(HttpServerRequest.HttpServerRequest, requestService),
        ),
      { concurrency: 'unbounded' },
    );
    for (const exit of exits) {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const publicFailure = Cause.squash(exit.cause);
        expect(publicFailure).toEqual(problems.internal());
        expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(publicFailure)).not.toMatch(
          /private/u,
        );
      }
    }
  }),
);

it.effect('passes only payload, trusted principal, registration, and correlation to ReadRuntime', () =>
  Effect.gen(function* forwardTrustedReadInputs() {
    const payload = { query: 'fixture' };
    observed.length = 0;
    const handler = makeGovernedReadHttpHandler({
      authenticatePrincipal: (authorization) => {
        expect(Redacted.value(authorization)).toBe('Bearer private');
        return Effect.succeed(principal);
      },
      problems,
      registration,
    });
    const assertDecodedPayloadInput = () =>
      handler({
        payload: {
          // @ts-expect-error The HTTP framework must pass the schema-decoded payload shape.
          query: 123,
        },
        request: { headers: Headers.empty },
      });
    void assertDecodedPayloadInput;
    const result = yield* handler({
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
    );
    expect(result).toEqual({ ok: true });
    expect(observed).toEqual([
      {
        input: payload,
        principal,
        registration,
        transport: { correlationId: 'correlation-test' },
      },
    ]);
  }),
);

it.effect('sanitizes unexpected defects at the complete governed handler boundary', () =>
  Effect.gen(function* sanitizeHandlerDefects() {
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
    const exit = yield* Effect.exit(
      handler({
        payload: { query: 'fixture' },
        request: {
          headers: Headers.fromInput({
            'x-correlation-id': 'correlation-defect',
          }),
        },
      }),
    ).pipe(
      Effect.provideService(ReadRuntime, defectRuntime),
      Effect.provideService(HttpServerRequest.HttpServerRequest, requestService),
      Effect.provide(capturedLoggerLayer(logEntries)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const publicFailure = Cause.squash(exit.cause);
      expect(publicFailure).toEqual(problems.internal());
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(publicFailure)).not.toMatch(
        /private database connection detail/u,
      );
    }
    expect(logEntries.length).toBe(1);
    expect(logEntries.join('\n')).not.toMatch(/private database connection detail/u);
    expect(logEntries[0] ?? '').toMatch(/correlation-defect/u);
  }),
);

it.effect('maps only schema-declared owner failures to concrete public Problems', () =>
  Effect.gen(function* mapsDeclaredOwnerFailure() {
    class DeclaredHttpDomainFailure extends Schema.TaggedError<DeclaredHttpDomainFailure>()(
      'DeclaredHttpDomainFailure',
      { reasonCode: Schema.Literal('PURPOSE_NOT_ALLOWED') },
    ) {}
    const DeclaredHttpDomainProblemSchema = Schema.TaggedStruct('DeclaredHttpDomainProblem', {
      detail: Schema.String,
      reasonCode: Schema.Literal('PURPOSE_NOT_ALLOWED'),
      status: Schema.Literal(422),
      title: Schema.String,
      type: Schema.String,
    });
    const domainRegistration = defineRead(
      {
        ...registration.descriptor,
        domainErrorSchema: DeclaredHttpDomainFailure,
      },
      () =>
        Effect.fail(
          new DeclaredHttpDomainFailure({
            reasonCode: 'PURPOSE_NOT_ALLOWED',
          }),
        ),
      () => Effect.succeed({}),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );
    // SAFETY: This test double exercises only the handler's runRead call and deliberately omits no
    // other ReadRuntimeService member; remove when the generic runtime interface exposes a test port.
    const domainRuntime = {
      runRead: () =>
        Effect.fail(
          new DeclaredHttpDomainFailure({
            reasonCode: 'PURPOSE_NOT_ALLOWED',
          }),
        ),
    } as ReadRuntimeService;
    const handler = makeGovernedReadHttpHandler({
      authenticatePrincipal: () => Effect.succeed(principal),
      mapDomainError: (error: DeclaredHttpDomainFailure) => ({
        _tag: 'DeclaredHttpDomainProblem' as const,
        detail: 'The requested purpose is not allowed.',
        reasonCode: error.reasonCode,
        status: 422 as const,
        title: 'Request cannot be fulfilled',
        type: 'https://ontos.test/problems/domain-policy',
      }),
      problems,
      registration: domainRegistration,
    });
    const exit = yield* Effect.exit(
      handler({
        payload: { query: 'fixture' },
        request: {
          headers: Headers.fromInput({
            'x-correlation-id': 'correlation-domain',
          }),
        },
      }),
    ).pipe(
      Effect.provideService(ReadRuntime, domainRuntime),
      Effect.provideService(HttpServerRequest.HttpServerRequest, requestService),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause);
      expect(Schema.is(DeclaredHttpDomainProblemSchema)(failure)).toBe(true);
      expect(failure).toMatchObject({
        detail: 'The requested purpose is not allowed.',
        reasonCode: 'PURPOSE_NOT_ALLOWED',
        status: 422,
        title: 'Request cannot be fulfilled',
        type: 'https://ontos.test/problems/domain-policy',
      });
    }

    const compileOnlyInvalidMapper = () =>
      makeGovernedReadHttpHandler({
        authenticatePrincipal: () => Effect.succeed(principal),
        // @ts-expect-error Domain mappers must return a declared public Problem Details value.
        mapDomainError: () => 'not-a-problem',
        problems,
        registration: domainRegistration,
      });
    void compileOnlyInvalidMapper;

    const leakingHandler = makeGovernedReadHttpHandler({
      authenticatePrincipal: () => Effect.succeed(principal),
      mapDomainError: (error: DeclaredHttpDomainFailure) => ({
        _tag: 'DeclaredHttpDomainProblem' as const,
        detail: 'The requested purpose is not allowed.',
        reasonCode: error.reasonCode,
        secret: 'owner-private-diagnostic',
        status: 422 as const,
        title: 'Request cannot be fulfilled',
        type: 'https://ontos.test/problems/domain-policy',
      }),
      problems,
      registration: domainRegistration,
    });
    const leakingExit = yield* Effect.exit(
      leakingHandler({
        payload: { query: 'fixture' },
        request: {
          headers: Headers.fromInput({
            'x-correlation-id': 'correlation-domain-leak',
          }),
        },
      }),
    ).pipe(
      Effect.provideService(ReadRuntime, domainRuntime),
      Effect.provideService(HttpServerRequest.HttpServerRequest, requestService),
    );
    expect(Exit.isFailure(leakingExit)).toBe(true);
    if (Exit.isFailure(leakingExit)) {
      expect(Cause.squash(leakingExit.cause)).toEqual(problems.internal());
    }
  }),
);
