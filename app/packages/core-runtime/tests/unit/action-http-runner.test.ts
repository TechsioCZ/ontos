import { Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineAction } from '../../src/actions/definition.ts';
import { ActionRuntime } from '../../src/actions/runtime.ts';
import type { ActionRuntimeService } from '../../src/actions/runtime.ts';
import { runGovernedActionHttp } from '../../src/http/http-instrumentation-seam.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'runner-test',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
} as const;

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
    resultSchema: Schema.Struct({}),
    schemaVersion: '1',
  },
  () => Effect.succeed({}),
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
