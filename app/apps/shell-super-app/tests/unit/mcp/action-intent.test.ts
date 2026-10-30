// @rstest-environment node
import { defineAction } from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { AgentProposalSubmitRequestSchema } from '@app/shared-contracts/agent-proposals';
import { Effect, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { AgentActionRequestIdentity } from '../../../api/auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from '../../../api/auth/agent-request-identity.ts';
import { withMcpActionIntent } from '../../../api/mcp/transport.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:mcp-intent-test',
  authMethod: 'session',
  legalEntityId: '71000000-0000-4000-8000-000000000020',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
} as const;

const request = Schema.decodeUnknownSync(AgentProposalSubmitRequestSchema)({
  instruction: 'Keep the original payload',
  legalEntityId: principal.legalEntityId,
  proposals: [
    {
      actionSlug: 'update',
      appId: 'fixture-notes',
      command: { idempotencyKey: 'Action-owned data', text: 'Original' },
      diff: [],
      reason: 'Requested change',
      risk: 'medium',
      summary: 'Update note',
      targetLabel: 'Note',
    },
  ],
  runId: 'actual-agent-run-not-the-intent-key',
});

// This is a native lifecycle fixture, not a replacement for the production proposal queue or OAuth authentication.
// Core's real runtime owns authorization, hash conflicts, persistence and committed retry evidence.
const proposalFixture = defineAction(
  {
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.mcp.intent.access.v1' },
    actionKey: 'test.mcp.submit',
    auditProfile: 'minimal',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
      entrypointKey: 'test.mcp.submit',
      moduleKey: 'test.mcp',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'required',
    owningModuleKey: 'test.mcp',
    payloadSchema: AgentProposalSubmitRequestSchema,
    policies: [],
    resultSchema: Schema.Struct({ instruction: Schema.String }),
    schemaVersion: '1',
  },
  (payload) => Effect.succeed({ instruction: payload.instruction }),
);

type Harness = Effect.Success<ReturnType<typeof makeActionTestHarness>>;
const submitNativeFixture = (harness: Harness, payload = request) =>
  Effect.gen(function* submitNativeFixtureEffect() {
    const transport = yield* AgentActionRequestIdentity;
    return yield* harness.runtime.runAction({ payload, principal, registration: proposalFixture, transport });
  });

describe('authenticated MCP caller intent boundary with native Action runtime', () => {
  it.effect(
    'retains the exact key, principal, run and payload across committed retry and changed-payload conflict',
    () =>
      Effect.gen(function* nativeIntentReplay() {
        const harness = yield* makeActionTestHarness({ actionPermission: 'allowed' });
        const intent = { idempotencyKey: 'Caller-Intent:AbC_123/retry' };
        const run = (payload = request, correlationId = 'original-http-request') =>
          withMcpActionIntent(submitNativeFixture(harness, payload), intent).pipe(
            Effect.provideService(AgentReadRequestIdentity, { correlationId }),
            // An unrelated HTTP/header identity must not override the explicit per-tool key.
            Effect.provideService(AgentActionRequestIdentity, {
              correlationId: 'foreign',
              idempotencyKey: 'header-key',
            }),
          );
        expect(yield* run()).toEqual({ instruction: request.instruction });
        const committed = yield* run(request, 'new-http-retry').pipe(Effect.flip);
        expect(Predicate.isTagged(committed, 'ActionAlreadyCommitted')).toBe(true);
        for (const changed of [
          { ...request, instruction: 'Different payload' },
          { ...request, runId: 'different-real-run' },
          {
            ...request,
            proposals: request.proposals.map((proposal) => ({
              ...proposal,
              command: { ...proposal.command, idempotencyKey: 'Different Action-owned data' },
            })),
          },
        ]) {
          const decoded = yield* Schema.decodeEffect(AgentProposalSubmitRequestSchema)(changed);
          const conflict = yield* run(decoded).pipe(Effect.flip);
          expect(Predicate.isTagged(conflict, 'ActionRequestHashConflict')).toBe(true);
        }
        const snapshot = harness.snapshot();
        expect(snapshot.committed).toHaveLength(1);
        expect(snapshot.transactionCount).toBe(1);
        expect(snapshot.invocations).toEqual([
          expect.objectContaining({
            idempotencyKey: intent.idempotencyKey,
            legalEntityId: principal.legalEntityId,
            principalId: principal.principalId,
            tenantId: principal.tenantId,
          }),
        ]);
        expect(snapshot.committed[0]?.evidence).toBeDefined();
      }),
  );

  it.effect('rejects absent or invalid tool keys and missing real request context before native mutation', () =>
    Effect.gen(function* refuseInvalidIntent() {
      const harness = yield* makeActionTestHarness({ actionPermission: 'allowed' });
      for (const key of ['', ' ', 'line\nbreak', 'x'.repeat(201)]) {
        const failure = yield* withMcpActionIntent(submitNativeFixture(harness), { idempotencyKey: key }).pipe(
          Effect.provideService(AgentReadRequestIdentity, { correlationId: 'real-http-request' }),
          Effect.flip,
        );
        expect(Predicate.isTagged(failure, 'ProposalRefused')).toBe(true);
      }
      const missingRead = yield* withMcpActionIntent(submitNativeFixture(harness), {
        idempotencyKey: 'explicit-key',
      }).pipe(Effect.flip);
      expect(Predicate.isTagged(missingRead, 'ProposalRefused')).toBe(true);
      expect(harness.snapshot().invocations).toHaveLength(0);
      expect(harness.snapshot().transactionCount).toBe(0);
    }),
  );

  it.effect('does not turn a valid intent key into native Action authority', () =>
    Effect.gen(function* keyIsNotAuthority() {
      const harness = yield* makeActionTestHarness();
      const failure = yield* withMcpActionIntent(submitNativeFixture(harness), {
        idempotencyKey: 'valid-but-not-authority',
      }).pipe(Effect.provideService(AgentReadRequestIdentity, { correlationId: 'real-http-request' }), Effect.flip);
      expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
      expect(harness.snapshot().permissionDenials).toHaveLength(1);
      expect(harness.snapshot().transactionCount).toBe(0);
    }),
  );

  it.effect('isolates distinct per-tool keys within one request and across requests', () =>
    Effect.gen(function* independentCallerIntents() {
      const harness = yield* makeActionTestHarness({ actionPermission: 'allowed' });
      for (const [index, key] of ['tool-one', 'tool-two', 'next-request'].entries()) {
        yield* withMcpActionIntent(submitNativeFixture(harness, { ...request, instruction: key }), {
          idempotencyKey: key,
        }).pipe(
          Effect.provideService(AgentReadRequestIdentity, {
            correlationId: index < 2 ? 'same-envelope' : 'next-envelope',
          }),
        );
      }
      expect(harness.snapshot().invocations.map((invocation) => invocation.idempotencyKey)).toEqual([
        'tool-one',
        'tool-two',
        'next-request',
      ]);
      expect(harness.snapshot().committed).toHaveLength(3);
    }),
  );
});
