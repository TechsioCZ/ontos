import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { decodeAccessDeclarationOrThrow, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';
import { expect, it } from 'effect-rstest';

import { AccessApprovalsAuthoritySource } from '../../api/access-admin/approvals-authority.ts';
import { AccessApprovalsCommands } from '../../api/access-admin/approvals-commands.ts';
import type { AccessApprovalsCommandsService } from '../../api/access-admin/approvals-commands.ts';
import { approvalOwnerRefused, approvalOwnerUnavailable } from '../../api/access-admin/approval-owner-errors.ts';
import {
  AccessApprovalsBffLive,
  accessAdminApprovalsGroupLive,
  accessApprovalsDeclarations,
} from '../../api/access-admin/approvals.ts';
import { AccessAdminSession } from '../../api/access-admin/session.ts';
import { AccessApprovalSchema, ListAccessApprovalsResponseSchema } from '../../shared/access-admin-api.ts';
import { ShellAuthenticationApi } from '../../shared/api.ts';
import { approvalOwnerCompanyId, approvalOwnerProposal, approvalOwnerTenantScope } from '../fixtures/approval-owner.ts';

const createRoot = Effect.fn('OwnerApprovalHttpRootTest.createRoot')(function* createRoot(
  outcome: 'approved' | 'denied' | 'unavailable' = 'approved',
  surface: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE' = 'ALLOWED',
  inspection?: 'allowed' | 'denied' | 'unavailable',
) {
  const calls: Parameters<AccessApprovalsCommandsService['approve']>[] = [];
  const inspectionCalls: Parameters<AccessApprovalsCommandsService['inspect']>[] = [];
  const gate = makeTestAccessDecision({
    answers: {
      [accessApprovalsDeclarations.decide.key]: { outcome: surface },
      [accessApprovalsDeclarations.list.key]: { outcome: surface },
    },
    defaultAnswer: { outcome: 'DENIED' },
  });
  const declaration = {
    key: approvalOwnerProposal.capabilityKey,
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    placement: { group: 'records', level: 'basic' },
    risk: 'sensitive',
    selectors: ['all'],
  };
  const services = Context.make(AccessAdminSession, {
    requireTenantContext: () => Effect.succeed(approvalOwnerTenantScope),
  }).pipe(
    Context.add(AccessDecisionGate, gate),
    Context.add(AccessApprovalsAuthoritySource, {
      capability: () =>
        Effect.succeed(
          Option.some({
            declaration: decodeAccessDeclarationOrThrow(
              declaration,
              defineTenantModuleEntrypoint({
                access: 'write',
                authorization: { kind: 'protected' },
                entrypointKey: 'demo.governing-read.change',
                moduleKey: 'demo.governing-read',
                role: 'action',
              }),
            ),
            label: 'Original owner Action',
            moduleKey: 'demo.governing-read',
          }),
        ),
      isAdministrator: () => Effect.succeed(false),
      person: () => Effect.succeed(Option.none()),
      principalKind: () => Effect.succeed(Option.some('human')),
      scope: () =>
        Effect.succeed(
          Option.some({
            accessScopeId: approvalOwnerProposal.scopeId,
            kind: 'company',
            legalEntityId: approvalOwnerCompanyId,
          }),
        ),
    }),
    Context.add(AccessApprovalsCommands, {
      approve: (scope, input) => {
        calls.push([scope, input]);
        if (outcome === 'denied') {
          return Effect.fail(approvalOwnerRefused());
        }
        if (outcome === 'unavailable') {
          return Effect.fail(approvalOwnerUnavailable());
        }
        return Effect.succeed({
          ...approvalOwnerProposal,
          approval: {
            approvedAt: new Date('2026-11-07T01:00:00.000Z'),
            approverId: scope.principalId,
            expiresAt: new Date('2026-11-08T00:00:00.000Z'),
          },
          status: 'approved',
        });
      },
      governedAmount: () =>
        inspection === undefined
          ? Effect.die('Approving must not ask the old scalar amount authority')
          : Effect.fail(approvalOwnerUnavailable()),
      inspect: (scope, input) => {
        inspectionCalls.push([scope, input]);
        if (inspection === undefined) {
          return Effect.die('Approving is not a nonmutating inspection');
        }
        return inspection === 'unavailable'
          ? Effect.fail(approvalOwnerUnavailable())
          : Effect.succeed(inspection === 'allowed');
      },
      load: () => Effect.succeed(Option.some(approvalOwnerProposal)),
      open: () => Effect.succeed([approvalOwnerProposal]),
      preview: () =>
        Effect.succeed(
          Option.some({
            actionKey: 'demo.governing-read.change',
            capabilityKey: approvalOwnerProposal.capabilityKey,
            digestShort: approvalOwnerProposal.commandDigest.slice(0, 12),
            fields: [],
            frozenAt: approvalOwnerProposal.createdAt,
            redactedFieldCount: 2,
          }),
        ),
      reject: () => Effect.die('The approval request cannot reject'),
      withdraw: () => Effect.die('The approval request cannot withdraw'),
    }),
  );
  const runtime = assembleEffectBffRuntime({
    api: HttpApi.make(ShellAuthenticationApi.identifier).add(ShellAuthenticationApi.groups.accessAdminApprovals),
    handlers: accessAdminApprovalsGroupLive.pipe(
      Layer.provide(AccessApprovalsBffLive),
      Layer.provide(Layer.succeedContext(services)),
    ),
  });
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => runtime.createHandler({ dataPlatform: { enabled: false }, openapi: false })),
    (handler) => Effect.promise(() => handler.dispose()),
  );
  const request = (revision = 'pending.0.0') =>
    Effect.promise(() =>
      server.handler(
        new Request('https://shell.example/shell/access/approvals/decide', {
          body: JSON.stringify({
            decision: 'approve',
            expectedStatus: 'pending',
            proposalId: approvalOwnerProposal.id,
            revision,
          }),
          headers: { 'content-type': 'application/json', 'idempotency-key': 'owner-approval-http-root' },
          method: 'POST',
        }),
      ),
    );
  const list = () =>
    Effect.promise(() =>
      server.handler(
        new Request('https://shell.example/shell/access/approvals/list', {
          body: JSON.stringify({ limit: 10 }),
          headers: { 'content-type': 'application/json', 'x-owner-inspection-test': 'fresh-session' },
          method: 'POST',
        }),
      ),
    );
  return { calls, gate, inspectionCalls, list, request };
});

it.effect(
  'the actual Shell HTTP approval branch delegates without requiring Action RUN or inventing governing Read witnesses',
  () =>
    Effect.gen(function* approvesThroughOwnerCommand() {
      const test = yield* createRoot();
      const response = yield* test.request();
      expect(response.status).toBe(200);
      const result = yield* Effect.promise(() => response.json());
      const approved = yield* Schema.decodeUnknownEffect(AccessApprovalSchema)(result);
      expect(approved.status).toBe('approved');
      expect(test.calls).toHaveLength(1);
      expect(Object.keys(test.calls[0]?.[1] ?? {}).toSorted()).toEqual(['headers', 'proposalId', 'revision']);
      expect(
        test.gate.askedDecisions.every(
          ({ carrier }) => carrier.accessDeclaration?.key === accessApprovalsDeclarations.decide.key,
        ),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain('actionAuthority');
      expect(JSON.stringify(result)).not.toContain('parentRecordRead');
    }).pipe(Effect.scoped),
);

for (const [outcome, status] of [
  ['denied', 403],
  ['unavailable', 503],
] as const) {
  it.effect(`the actual Shell HTTP root preserves an owner's ${outcome} approval as ${status}`, () =>
    Effect.gen(function* preservesOwnerRefusal() {
      const test = yield* createRoot(outcome);
      expect((yield* test.request()).status).toBe(status);
      expect(test.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
}

it.effect('a stale Shell revision never reaches the owner approval command', () =>
  Effect.gen(function* refusesStaleRevision() {
    const test = yield* createRoot();
    expect((yield* test.request('old-revision')).status).toBe(409);
    expect(test.calls).toHaveLength(0);
  }).pipe(Effect.scoped),
);

for (const inspection of ['allowed', 'denied', 'unavailable'] as const) {
  it.effect(`the actual Shell list derives approval eligibility from ${inspection} original-owner inspection`, () =>
    Effect.gen(function* listsOwnerEligibility() {
      const test = yield* createRoot('approved', 'ALLOWED', inspection);
      const response = yield* test.list();
      expect(response.status).toBe(200);
      const result = yield* Schema.decodeUnknownEffect(ListAccessApprovalsResponseSchema)(
        yield* Effect.promise(() => response.json()),
      );
      expect(result).toMatchObject({
        items: [{ permitted: { approval: { allowed: inspection === 'allowed' } } }],
      });
      if (inspection === 'unavailable') {
        expect(result).toMatchObject({
          items: [{ permitted: { approval: { reason: 'owner_approval_inspection_unavailable' } } }],
        });
      }
      expect(test.calls).toHaveLength(0);
      expect(test.inspectionCalls).toHaveLength(1);
      const [call] = test.inspectionCalls;
      expect(call?.[0]).toBe(approvalOwnerTenantScope);
      expect(call?.[1].headers.get('x-owner-inspection-test')).toBe('fresh-session');
      expect(call?.[1].proposalId).toBe(approvalOwnerProposal.id);
      expect(call?.[1].revision).toBe('pending.0.0');
      // Neither Action RUN nor the denied scalar catalog capability can grant owner approval.
      expect(
        test.gate.askedDecisions.some(
          ({ carrier, mode }) => carrier.accessDeclaration?.kind === 'action' && mode === 'run',
        ),
      ).toBe(false);
    }).pipe(Effect.scoped),
  );
}

for (const [outcome, status] of [
  ['DENIED', 403],
  ['UNAVAILABLE', 503],
] as const) {
  it.effect(`a ${outcome} Shell admission observes no owner command`, () =>
    Effect.gen(function* refusesBeforeOwnerObservation() {
      const test = yield* createRoot('approved', outcome);
      expect((yield* test.request()).status).toBe(status);
      expect(test.calls).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
}
