import { NodeCrypto } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/context.ts';
import { ActionInvocationNotFound, ActionPayloadValidationError } from '../../src/actions/errors.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import type { ActionInvocationRecord } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeTestDatabase } from '../support/database.ts';

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '10000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-api-key:original-request-test',
  authenticationNamespaceId: 'core-identity',
  authMethod: 'api_key',
  legalEntityId: '10000000-0000-4000-8000-000000000002',
  principalId: '10000000-0000-4000-8000-000000000003',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
const invocationId = '10000000-0000-4000-8000-000000000005';
const requestHash = 'a'.repeat(64);
const lookup = {
  actionKey: 'commerce.customer-context.start-portal-enrollment',
  idempotencyKey: 'original',
  principal,
};

const harness = Effect.fn(function* harness(status: ActionInvocationRecord['status'], missing: boolean) {
  const crypto = yield* Crypto.Crypto;
  const executor = yield* makeTestDatabase(() => Effect.die('Unexpected database I/O'));
  let reads = 0;
  const repository = {
    ...makeActionRepository(crypto),
    resolveInvocation: (
      _executor: Parameters<ReturnType<typeof makeActionRepository>['resolveInvocation']>[0],
      input: Parameters<ReturnType<typeof makeActionRepository>['resolveInvocation']>[1],
    ) => {
      reads += 1;
      expect(input.principal).toEqual(principal);
      return missing
        ? Effect.fail(new ActionInvocationNotFound({ code: 'action_invocation_not_found', reason: 'Missing' }))
        : Effect.succeed({
            actionInvocationId: invocationId,
            actionKey: lookup.actionKey,
            completedAt:
              status === 'succeeded' || status === 'rejected' ? DateTime.toDateUtc(DateTime.makeUnsafe(0)) : null,
            requestHash,
            status,
          });
    },
  };
  return {
    reads: () => reads,
    runtime: makeActionRuntime(
      { executor },
      repository,
      { checkActionPermission: () => Effect.die('No permission mutation/check expected') },
      testOperationalScopeResolver,
      openActionRuntimeOptions,
    ),
  };
});

it.layer(NodeCrypto.layer)('original request hash resolution', (suite) => {
  suite.effect('rejects malformed hashes without repository I/O and without retaining their values or causes', () =>
    Effect.gen(function* testMalformed() {
      const h = yield* harness('succeeded', false);
      for (const invalid of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), null, 123, 'private-supplied-value']) {
        const result = yield* h.runtime
          .resolveActionExecution({ ...lookup, expectedRequestHash: invalid })
          .pipe(Effect.flip);
        expect(Schema.is(ActionPayloadValidationError)(result)).toBe(true);
        if (String(invalid).length > 0) {
          const error = yield* Schema.decodeUnknownEffect(ActionPayloadValidationError)(result);
          expect(yield* Schema.encodeEffect(Schema.fromJsonString(ActionPayloadValidationError))(error)).not.toContain(
            String(invalid),
          );
        }
        expect(Object.hasOwn(result, 'cause')).toBe(false);
      }
      expect(h.reads()).toBe(0);
    }),
  );

  suite.effect('compares the expected hash before every recorded state and keeps absent-hash behavior', () =>
    Effect.gen(function* testStates() {
      const expected = [
        ['succeeded', 'COMMITTED'],
        ['received', 'RETRYABLE'],
        ['running', 'RUNNING'],
        ['indeterminate', 'RUNNING'],
        ['rejected', 'REJECTED'],
      ] as const;
      for (const [status, state] of expected) {
        const h = yield* harness(status, false);
        expect((yield* h.runtime.resolveActionExecution(lookup)).state).toBe(state);
        expect((yield* h.runtime.resolveActionExecution({ ...lookup, expectedRequestHash: requestHash })).state).toBe(
          state,
        );
        const error = yield* h.runtime
          .resolveActionExecution({ ...lookup, expectedRequestHash: 'b'.repeat(64) })
          .pipe(Effect.flip);
        expect(Schema.is(ActionPayloadValidationError)(error)).toBe(true);
        const decoded = yield* Schema.decodeUnknownEffect(ActionPayloadValidationError)(error);
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ActionPayloadValidationError))(decoded);
        expect(encoded).not.toContain(requestHash);
        expect(encoded).not.toContain('b'.repeat(64));
        expect(Object.hasOwn(error, 'cause')).toBe(false);
      }
      const missing = yield* harness('received', true);
      expect((yield* missing.runtime.resolveActionExecution(lookup)).state).toBe('NOT_STARTED');
      expect(
        Schema.is(ActionPayloadValidationError)(
          yield* missing.runtime
            .resolveActionExecution({ ...lookup, expectedRequestHash: requestHash })
            .pipe(Effect.flip),
        ),
      ).toBe(true);
    }),
  );
});
