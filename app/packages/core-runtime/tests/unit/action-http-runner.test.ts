import { Effect, Redacted, Schema } from 'effect';
import { Headers } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { defineAction } from '../../src/actions/definition.ts';
import { ActionAlreadyCommitted } from '../../src/actions/errors.ts';
import type { ActionCoreError } from '../../src/actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { ActionRuntime } from '../../src/actions/runtime.ts';
import type { ActionRuntimeService } from '../../src/actions/runtime.ts';
import {
  bindGovernedActionHttp,
  decodeActionEndpointHeaders,
  runGovernedActionHttp,
} from '../../src/http/http-instrumentation-seam.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'runner-test',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
});

const BusinessResultSchema = Schema.TaggedStruct('BusinessResult', {});
const ActionInvocationIdSchema = Schema.String.pipe(Schema.brand('ActionInvocationId'), Schema.decodeTo(Schema.String));
const CommittedRetryReceiptSchema = Schema.TaggedStruct('CommittedRetryReceipt', {
  invocationId: ActionInvocationIdSchema,
});

const registration = defineAction(
  {
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.test.http-runner.access.v1',
    },
    actionKey: 'core.test.http-runner',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineSystemModuleEntrypoint({
      access: 'write',
      authorization: {
        kind: 'action_execution',
        provisioning: 'tenant_membership_default',
      },
      entrypointKey: 'core.test.http-runner',
      moduleKey: 'core.shell',
      role: 'action',
    }),
    idempotency: 'optional',
    legalEntityScope: 'optional',
    owningModuleKey: 'core.shell',
    payloadSchema: Schema.Struct({}),
    policies: [],
    resultSchema: BusinessResultSchema,
    schemaVersion: '1',
  },
  () => Effect.succeed(BusinessResultSchema.make({})),
);

const unusedRuntime = (onRun: () => void): ActionRuntimeService => ({
  resolveActionCommit: () => Effect.die('Action commit recovery is outside the runner fixture'),
  runAction: () => {
    onRun();
    return Effect.die('The Action runtime must not be reached');
  },
});

const invalidProblem = { _tag: 'InvalidProblem' as const };
const internalProblem = { _tag: 'InternalProblem' as const };
const authorization = (value?: string) => Redacted.make(value);

const alreadyCommittedRuntime = (failure: ActionAlreadyCommitted): ActionRuntimeService => ({
  resolveActionCommit: () => Effect.die('Action commit recovery is outside the runner fixture'),
  runAction: () => Effect.fail(failure),
});

it.effect('invalid correlation metadata is rejected before principal acquisition and runtime lookup', () =>
  Effect.gen(function* rejectInvalidCorrelation() {
    const requestHeaders = [{}, { 'x-correlation-id': '' }, { 'x-correlation-id': '   ' }] as const;
    let authenticationCalls = 0;
    let runtimeCalls = 0;
    const runtime = unusedRuntime(() => {
      runtimeCalls += 1;
    });
    const authenticate = () => {
      authenticationCalls += 1;
      return Effect.succeed(principal);
    };

    for (const headers of requestHeaders) {
      const effect = runGovernedActionHttp({
        endpointHeaders: {
          idempotencyKey: 'not-reached',
          traceId: 'not-reached',
        },
        internalProblem: () => internalProblem,
        invalidCorrelationProblem: () => invalidProblem,
        mapError: () => internalProblem,
        payload: {},
        principal: { authenticate },
        registration,
        requestHeaders: { authorization: authorization(), ...headers },
      }).pipe(Effect.provideService(ActionRuntime, runtime));

      expect(yield* Effect.flip(effect)).toBe(invalidProblem);
    }

    expect(authenticationCalls).toBe(0);
    expect(runtimeCalls).toBe(0);
  }),
);

it.effect('principal authentication failure prevents Action runtime execution', () =>
  Effect.gen(function* rejectAuthenticationFailure() {
    const authenticationProblem = { _tag: 'AuthenticationProblem' as const };
    let runtimeCalls = 0;
    const effect = runGovernedActionHttp({
      endpointHeaders: {
        idempotencyKey: 'not-reached',
        traceId: 'not-reached',
      },
      internalProblem: () => internalProblem,
      invalidCorrelationProblem: () => invalidProblem,
      mapError: () => internalProblem,
      payload: {},
      principal: { authenticate: () => Effect.fail(authenticationProblem) },
      registration,
      requestHeaders: {
        authorization: authorization(),
        'x-correlation-id': 'correlation-test',
      },
    }).pipe(
      Effect.provideService(
        ActionRuntime,
        unusedRuntime(() => {
          runtimeCalls += 1;
        }),
      ),
    );

    expect(yield* Effect.flip(effect)).toBe(authenticationProblem);
    expect(runtimeCalls).toBe(0);
  }),
);

it.effect('synchronous endpoint callback defects are sanitized before the Action runtime', () =>
  Effect.gen(function* sanitizeCallbackDefects() {
    const callbackDefects = [
      {
        invalidCorrelationProblem: () => {
          throw new Error('private invalid-problem constructor defect');
        },
        principal: { authenticate: () => Effect.succeed(principal) },
        requestHeaders: {
          authorization: authorization('Bearer private-token'),
        },
      },
      {
        invalidCorrelationProblem: () => invalidProblem,
        principal: {
          authenticate: () => {
            throw new Error('private principal authentication defect');
          },
        },
        requestHeaders: {
          authorization: authorization('Bearer private-token'),
          'x-correlation-id': 'correlation-auth-defect',
        },
      },
    ] as const;
    let runtimeCalls = 0;
    const runtime = unusedRuntime(() => {
      runtimeCalls += 1;
    });

    for (const fixture of callbackDefects) {
      const effect = runGovernedActionHttp({
        endpointHeaders: {
          idempotencyKey: 'not-reached',
          traceId: 'not-reached',
        },
        internalProblem: () => internalProblem,
        invalidCorrelationProblem: fixture.invalidCorrelationProblem,
        mapError: () => internalProblem,
        payload: {},
        principal: fixture.principal,
        registration,
        requestHeaders: fixture.requestHeaders,
      }).pipe(Effect.provideService(ActionRuntime, runtime));

      expect(yield* Effect.flip(effect)).toBe(internalProblem);
    }

    expect(runtimeCalls).toBe(0);
  }),
);

it.effect('takes the admission audience only from receiver configuration', () =>
  Effect.gen(function* receiverAudience() {
    const audiences: (string | undefined)[] = [];
    const runtime: ActionRuntimeService = {
      resolveActionCommit: () => Effect.die('Not exercised'),
      runAction: (input) => {
        audiences.push(input.audience);
        return Effect.die('Stop after observing the trusted boundary');
      },
    };
    const requestHeaders = {
      audience: 'untrusted-request-audience',
      authorization: authorization(),
      'x-correlation-id': 'receiver-audience-test',
    };
    for (const receivingAudience of [{}, { audience: 'test.receiver.api' }]) {
      yield* Effect.exit(
        runGovernedActionHttp({
          ...receivingAudience,
          endpointHeaders: { idempotencyKey: 'test-invocation', traceId: 'test-trace' },
          internalProblem: () => internalProblem,
          invalidCorrelationProblem: () => invalidProblem,
          mapError: () => internalProblem,
          payload: {},
          principal: { authenticate: () => Effect.succeed(principal) },
          registration,
          requestHeaders,
        }),
      ).pipe(Effect.provideService(ActionRuntime, runtime));
    }
    expect(audiences).toEqual([undefined, 'test.receiver.api']);
  }),
);

it.effect('allows an endpoint to recover an already committed Action as its declared success', () =>
  Effect.gen(function* recoverCommittedAction() {
    const committed = new ActionAlreadyCommitted({
      code: 'action_already_committed',
      invocationId: 'committed-invocation',
      reason: 'The Action already committed successfully',
    });
    let mappedErrors = 0;
    const runActionHttp = bindGovernedActionHttp({ authenticate: () => Effect.succeed(principal) });

    const result = yield* runActionHttp({
      endpointHeaders: { idempotencyKey: 'committed-invocation', traceId: 'committed-retry-trace' },
      internalProblem: () => internalProblem,
      invalidCorrelationProblem: () => invalidProblem,
      mapError: (_failure: Exclude<ActionCoreError, ActionAlreadyCommitted>) => {
        mappedErrors += 1;
        return internalProblem;
      },
      payload: {},
      recoverAlreadyCommitted: (failure) =>
        CommittedRetryReceiptSchema.make({
          invocationId: failure.invocationId,
        }),
      registration,
      requestHeaders: {
        authorization: authorization(),
        'x-correlation-id': 'committed-retry-test',
      },
    }).pipe(Effect.provideService(ActionRuntime, alreadyCommittedRuntime(committed)));

    expect(Schema.is(CommittedRetryReceiptSchema)(result)).toBe(true);
    expect(result).toHaveProperty('invocationId', 'committed-invocation');
    expect(mappedErrors).toBe(0);
  }),
);

it.effect('maps an already committed Action normally when recovery is not opted into', () =>
  Effect.gen(function* preserveDefaultCommittedMapping() {
    const committed = new ActionAlreadyCommitted({
      code: 'action_already_committed',
      invocationId: 'default-mapping-invocation',
      reason: 'The Action already committed successfully',
    });
    const mappedProblem = { _tag: 'AlreadyCommittedProblem' as const };
    let mappedFailure: unknown;

    const effect = runGovernedActionHttp({
      endpointHeaders: { idempotencyKey: 'default-mapping-invocation', traceId: 'default-mapping-trace' },
      internalProblem: () => internalProblem,
      invalidCorrelationProblem: () => invalidProblem,
      mapError: (failure) => {
        mappedFailure = failure;
        return mappedProblem;
      },
      payload: {},
      principal: { authenticate: () => Effect.succeed(principal) },
      registration,
      requestHeaders: {
        authorization: authorization(),
        'x-correlation-id': 'default-committed-mapping-test',
      },
    }).pipe(Effect.provideService(ActionRuntime, alreadyCommittedRuntime(committed)));

    expect(yield* Effect.flip(effect)).toBe(mappedProblem);
    expect(mappedFailure).toBe(committed);
  }),
);

it.effect('decodes only the Action transport headers among open browser headers', () =>
  Effect.gen(function* decodeEndpointHeaders() {
    const browserHeaders = Headers.fromInput({
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0',
    });
    const absent = yield* decodeActionEndpointHeaders(browserHeaders);
    expect(absent.idempotencyKey).toBeUndefined();
    expect(absent.traceId).toBeUndefined();
    expect(
      yield* decodeActionEndpointHeaders(
        Headers.setAll(browserHeaders, { 'idempotency-key': 'key-1', 'x-trace-id': 'trace-1' }),
      ),
    ).toEqual({ idempotencyKey: 'key-1', traceId: 'trace-1' });
    for (const rejected of ['', 'k'.repeat(201)]) {
      const failure = yield* Effect.flip(
        decodeActionEndpointHeaders(Headers.set(browserHeaders, 'idempotency-key', rejected)),
      );
      expect(Schema.isSchemaError(failure)).toBe(true);
    }
  }),
);
