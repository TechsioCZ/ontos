import { Effect, Schema, Predicate, Struct } from 'effect';
/* oxlint-disable sonarjs/no-undefined-assignment -- Existing compatibility boundary; expires: 2026-12-31. */
import { expect, it } from 'effect-rstest';

import { defineAction } from '../../src/actions/definition.ts';
import { ActionAlreadyCommitted } from '../../src/actions/errors.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:commit-recovery-test',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
} as const;

it.effect(
  'committed retry and explicit recovery return the same invocation without rerunning or replaying the result',
  () =>
    Effect.gen(function* migratedTest() {
      let executions = 0;
      const registration = defineAction(
        {
          accessEvidencePolicy: {
            captureMode: 'metadata_only',
            policyKey: 'test.recovery.read.v1',
          },
          actionKey: 'test.recovery.execute',
          auditProfile: 'minimal',
          domainErrorSchema: Schema.Never,
          domainEvents: {},
          entrypoint: defineTenantModuleEntrypoint({
            access: 'write',
            authorization: {
              kind: 'action_execution',
              provisioning: 'tenant_membership_default',
            },
            entrypointKey: 'test.recovery.execute',
            moduleKey: 'test.recovery',
            role: 'action',
          }),
          idempotency: 'required',
          legalEntityScope: 'optional',
          owningModuleKey: 'test.recovery',
          payloadSchema: Schema.Struct({ amount: Schema.Finite }),
          policies: [],
          resultSchema: Schema.Struct({ total: Schema.Finite }),
          schemaVersion: '1',
        },
        (payload) =>
          Effect.sync(() => {
            executions += 1;
            return { total: payload.amount * executions };
          })
      );
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
      });
      const request = {
        payload: { amount: 2 },
        principal,
        registration,
        transport: {
          correlationId: 'commit-recovery-test',
          idempotencyKey: 'commit-once',
        },
      } as const;

      expect(yield* harness.runtime.runAction(request)).toEqual({ total: 2 });
      const invocationId =
        harness.snapshot().invocations[0]?.actionInvocationId;
      expect(invocationId).toBeDefined();
      if (invocationId === undefined) {
        throw new Error('Missing invocationId');
      }
      const replay = yield* harness.runtime
        .runAction(request)
        .pipe(Effect.flip);
      const recovered = yield* harness.runtime
        .resolveActionCommit({ invocationId, principal })
        .pipe(Effect.flip);

      for (const outcome of [replay, recovered]) {
        expect(Predicate.isTagged(outcome, 'ActionAlreadyCommitted')).toBe(
          true
        );
        expect(
          'invocationId' in outcome ? outcome.invocationId : undefined
        ).toBe(invocationId);
        expect('total' in outcome).toBe(false);
        expect('result' in outcome).toBe(false);
      }
      expect(executions).toBe(1);
      expect(harness.snapshot().committed.length).toBe(1);
      expect(harness.snapshot().transactionCount).toBe(1);
    })
);

it.effect(
  'committed error schema requires and preserves the recovery invocation identifier',
  () =>
    Effect.gen(function* migratedTest() {
      const encoded = {
        _tag: 'ActionAlreadyCommitted',
        code: 'action_already_committed',
        invocationId: '40000000-0000-4000-8000-000000000001',
        reason: 'This idempotency key already committed successfully',
      } as const;
      const decoded = yield* Schema.decodeEffect(ActionAlreadyCommitted)(
        encoded
      );
      const reencoded = yield* decoded.pipe(
        Schema.encodeEffect(ActionAlreadyCommitted)
      );
      expect(
        Schema.is(Schema.toEncoded(ActionAlreadyCommitted))(reencoded)
      ).toBe(true);
      expect(Struct.omit(reencoded, ['_tag'])).toEqual(
        Struct.omit(encoded, ['_tag'])
      );
      expect(
        Schema.is(ActionAlreadyCommitted)({
          _tag: 'ActionAlreadyCommitted',
          code: 'action_already_committed',
          reason: 'This idempotency key already committed successfully',
        })
      ).toBe(false);
      expect('result' in decoded).toBe(false);
      expect('status' in decoded).toBe(false);
    })
);

it.effect(
  'lost commit acknowledgement recovers the committed invocation and faults only once',
  () =>
    Effect.gen(function* migratedTest() {
      let executions = 0;
      const registration = defineAction(
        {
          accessEvidencePolicy: {
            captureMode: 'metadata_only',
            policyKey: 'test.recovery.read.v1',
          },
          actionKey: 'test.recovery.acknowledgement',
          auditProfile: 'minimal',
          domainErrorSchema: Schema.Never,
          domainEvents: {},
          entrypoint: defineTenantModuleEntrypoint({
            access: 'write',
            authorization: {
              kind: 'action_execution',
              provisioning: 'tenant_membership_default',
            },
            entrypointKey: 'test.recovery.acknowledgement',
            moduleKey: 'test.recovery',
            role: 'action',
          }),
          idempotency: 'required',
          legalEntityScope: 'optional',
          owningModuleKey: 'test.recovery',
          payloadSchema: Schema.Void,
          policies: [],
          resultSchema: Schema.Finite,
          schemaVersion: '1',
        },
        () =>
          Effect.sync(() => {
            executions += 1;
            return executions;
          })
      );
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        commitAcknowledgement: 'indeterminate-once',
      });
      const request = {
        payload: undefined,
        principal,
        registration,
        transport: {
          correlationId: 'lost-acknowledgement',
          idempotencyKey: 'commit-once',
        },
      } as const;

      const uncertain = yield* harness.runtime
        .runAction(request)
        .pipe(Effect.flip);
      expect(Predicate.isTagged(uncertain, 'ActionCommitIndeterminate')).toBe(
        true
      );
      expect('invocationId' in uncertain).toBe(true);
      if (!('invocationId' in uncertain)) {
        throw new Error('Missing invocation identifier');
      }
      expect(uncertain.invocationId).toBe(
        harness.snapshot().invocations[0]?.actionInvocationId
      );
      expect(harness.snapshot().invocations[0]?.status).toBe('succeeded');

      const recovered = yield* harness.runtime
        .resolveActionCommit({
          invocationId: uncertain.invocationId,
          principal,
        })
        .pipe(Effect.flip);
      const replay = yield* harness.runtime
        .runAction(request)
        .pipe(Effect.flip);
      for (const outcome of [recovered, replay]) {
        expect(Predicate.isTagged(outcome, 'ActionAlreadyCommitted')).toBe(
          true
        );
        expect('invocationId' in outcome).toBe(true);
        if (!('invocationId' in outcome)) {
          throw new Error('Missing invocation identifier');
        }
        expect(outcome.invocationId).toBe(uncertain.invocationId);
      }
      expect(executions).toBe(1);
      expect(harness.snapshot().committed.length).toBe(1);
      expect(harness.snapshot().transactionCount).toBe(1);

      expect(
        yield* harness.runtime.runAction({
          ...request,
          transport: {
            correlationId: 'acknowledged-next',
            idempotencyKey: 'next-invocation',
          },
        })
      ).toBe(2);
      expect(harness.snapshot().committed.length).toBe(2);
    })
);
