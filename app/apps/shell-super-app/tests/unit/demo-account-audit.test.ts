import { ReadRuntime } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { auditTrail } from '../../api/auth/demo-accounts.ts';

const company = '00000000-0000-4000-8000-000000000002';
const actorId = '00000000-0000-4000-8000-000000000003';
const agentId = '00000000-0000-4000-8000-000000000004';
const targetId = '00000000-0000-4000-8000-000000000006';
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:demo-audit',
  authMethod: 'session',
  legalEntityId: company,
  principalId: actorId,
  tenantId: '00000000-0000-4000-8000-000000000001',
});
const caller = { legalName: 'Company', principal: { ...principal, legalEntityId: company } };
const transport = { correlationId: 'persisted-demo-audit-read' };
const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-25T12:00:00.000Z'));
interface AuditFixtureEvidence {
  readonly actionKey?: string;
  readonly agentPrincipalId?: string;
  readonly context?: string;
  readonly description?: null;
  readonly desiredOperatorPrincipalIds?: readonly string[];
  readonly displayName?: string | { readonly untrusted: string };
  readonly legalEntityId?: string;
  readonly modules?: readonly { readonly moduleKey: string; readonly read: boolean }[];
  readonly newStatus?: string;
  readonly operation?: string;
  readonly ownerPrincipalId?: null;
  readonly previousProfile?: { readonly displayName: string };
  readonly previousRevision?: number;
  readonly previousStatus?: string;
  readonly principalKind?: string;
  readonly reason?: string;
  readonly resultHash?: string;
  readonly revision?: number;
  readonly revokedConnections?: number | string;
  readonly subjectType?: string;
  readonly targetPrincipalId?: string;
  readonly writePolicy?: string;
}
const fixture = (
  evidence?: AuditFixtureEvidence,
  eventType = 'action.executed',
  principalId = actorId,
  allowed = true,
) =>
  makeReadTestHarness({
    executeOwnerQuery: ({ params, scope, sql }) => {
      expect(scope).toEqual({ legalEntityId: company, tenantId: principal.tenantId });
      if (sql.startsWith('select') && sql.includes('"core"."audit_events"')) {
        expect(params).toContain(principal.tenantId);
        expect(params).toContain(company);
        return Effect.succeed(
          evidence === undefined
            ? []
            : [
                {
                  actorName: 'Administrator',
                  auditEventId: '00000000-0000-4000-8000-000000000007',
                  eventType,
                  evidence,
                  occurredAt,
                  outcome: eventType === 'action.rejected' || eventType === 'authn.rejected' ? 'denied' : 'allowed',
                  outcomeCode: 'fixture',
                  principalId,
                },
              ],
        );
      }
      if (sql.startsWith('select') && sql.includes('"core"."principals"')) {
        expect(params).toContain(principal.tenantId);
        return Effect.succeed([{ displayName: 'Target', principalId: targetId }]);
      }
      return Effect.die(`Unexpected audit SQL: ${sql}`);
    },
    operationTime: occurredAt,
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: allowed ? 'allowed' : 'denied',
    scope: { ...caller.principal, correlationId: transport.correlationId },
  });
const project = (evidence: AuditFixtureEvidence, eventType = 'action.executed', principalId = actorId) =>
  Effect.gen(function* projectNativeAudit() {
    const harness = yield* fixture(evidence, eventType, principalId);
    const entries = yield* auditTrail(caller, transport, 'agents').pipe(
      Effect.provideService(ReadRuntime, harness.runtime),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.occurredAt).toBe('2026-10-25T12:00:00.000Z');
    expect(entries[0]?.actorName).toBe('Administrator');
    expect(harness.snapshot().evidenceWrites).toBe(1);
    return entries[0]?.details;
  });

it.effect('native scoped audit includes profile, status and operator history without requiring principalKind', () =>
  Effect.gen(function* nativeAgentAuditPredicate() {
    const harness = yield* fixture();
    expect(
      yield* auditTrail(caller, transport, 'agents').pipe(Effect.provideService(ReadRuntime, harness.runtime)),
    ).toEqual([]);
    const [query] = harness.snapshot().ownerQueries;
    expect(query?.sql).toContain(
      "'core.identity.configure-agent', 'core.identity.manage-agent-status', 'core.identity.replace-agent-operators'",
    );
    expect(query?.sql).toContain("->>'principalKind' = 'agent'");
    expect(query?.params).toContain(company);
    expect(query?.params).toContain('action.executed');
    expect(query?.params).toContain('action.rejected');
    expect(query?.params).toContain('identity.agent_operators_changed');
  }),
);

it.effect('native people audit excludes agent configurations and derives retained company members internally', () =>
  Effect.gen(function* nativePeopleAuditPredicate() {
    const harness = yield* fixture();
    yield* auditTrail(caller, transport, 'people').pipe(Effect.provideService(ReadRuntime, harness.runtime));
    const [query] = harness.snapshot().ownerQueries;
    expect(query?.sql).not.toContain('core.identity.configure-agent');
    expect(query?.sql).toContain("->>'principalKind', 'human') <> 'agent'");
    expect(query?.sql).toContain('"core"."principal_company_memberships"');
    expect(query?.params).toContain(company);
    expect(query?.params).toContain('principal_inactive');
    expect(query?.sql).toContain('"legal_entity_id" is null');
  }),
);

it.effect('projects native operator commands without leaking operator arrays or private result hashes', () =>
  Effect.gen(function* projectOperators() {
    expect(
      yield* project({
        actionKey: 'core.identity.replace-agent-operators',
        agentPrincipalId: agentId,
        context: 'operators-edited',
        desiredOperatorPrincipalIds: [actorId],
        legalEntityId: company,
        previousRevision: 1,
        resultHash: 'private-result-hash',
        revision: 2,
        revokedConnections: 3,
      }),
    ).toEqual({
      agentPrincipalId: agentId,
      context: 'operators-edited',
      legalEntityId: company,
      operation: 'replace-agent-operators',
      revokedConnections: '3',
      targetPrincipalId: agentId,
    });
  }),
);

it.effect('keeps native display fields and explicit clears without exposing nested profiles', () =>
  Effect.gen(function* projectProfile() {
    expect(
      yield* project({
        actionKey: 'core.identity.configure-agent',
        description: null,
        displayName: 'Agent',
        legalEntityId: company,
        modules: [{ moduleKey: 'crm', read: true }],
        operation: 'configure-agent',
        ownerPrincipalId: null,
        previousProfile: { displayName: 'Previous agent' },
        resultHash: 'private-result-hash',
        revision: 2,
        targetPrincipalId: agentId,
        writePolicy: 'approval-required',
      }),
    ).toEqual({
      description: null,
      displayName: 'Agent',
      legalEntityId: company,
      operation: 'configure-agent',
      ownerPrincipalId: null,
      targetPrincipalId: agentId,
      writePolicy: 'approval-required',
    });
  }),
);

it.effect('keeps denied status changes with their exact target and reason', () =>
  Effect.gen(function* projectDeniedStatusChange() {
    expect(
      yield* project(
        {
          actionKey: 'core.identity.manage-agent-status',
          displayName: 'Agent',
          newStatus: 'disabled',
          operation: 'change-status',
          previousStatus: 'active',
          principalKind: 'agent',
          reason: 'Policy violation',
          targetPrincipalId: targetId,
        },
        'action.rejected',
      ),
    ).toEqual({
      displayName: 'Agent',
      newStatus: 'disabled',
      operation: 'change-status',
      previousStatus: 'active',
      principalKind: 'agent',
      reason: 'Policy violation',
      targetPrincipalId: targetId,
    });
  }),
);

it.effect('preserves persisted operator counts and explicit target precedence', () =>
  Effect.gen(function* projectPersistedOperators() {
    expect(
      yield* project(
        { agentPrincipalId: agentId, context: 'agent-created', revokedConnections: '0', targetPrincipalId: targetId },
        'identity.agent_operators_changed',
      ),
    ).toEqual({
      agentPrincipalId: agentId,
      context: 'agent-created',
      revokedConnections: '0',
      targetPrincipalId: targetId,
    });
  }),
);

it.effect('uses the inactive principal as the target of persisted authentication rejections', () =>
  Effect.gen(function* projectAuthenticationRejection() {
    expect(yield* project({ reason: 'principal_disabled', subjectType: 'user' }, 'authn.rejected', targetId)).toEqual({
      reason: 'principal_disabled',
      subjectType: 'user',
      targetPrincipalId: targetId,
    });
  }),
);

it.effect('fails malformed native display evidence rather than releasing a partial or unsafe audit', () =>
  Effect.gen(function* rejectMalformedDisplayEvidence() {
    const harness = yield* fixture({ displayName: { untrusted: 'not a display name' } });
    const error = yield* auditTrail(caller, transport, 'agents').pipe(
      Effect.provideService(ReadRuntime, harness.runtime),
      Effect.flip,
    );
    expect(Predicate.isTagged(error, 'DemoAccountUnavailable')).toBe(true);
    expect(harness.snapshot().evidenceWrites).toBe(0);
  }),
);

it.effect('native company admission denial stays forbidden and runs no audit/name/member SQL', () =>
  Effect.gen(function* deniedAudit() {
    const harness = yield* fixture(undefined, 'action.executed', actorId, false);
    const error = yield* auditTrail(caller, transport, 'agents').pipe(
      Effect.provideService(ReadRuntime, harness.runtime),
      Effect.flip,
    );
    expect(Predicate.isTagged(error, 'DemoAccountForbidden')).toBe(true);
    expect(harness.snapshot().ownerQueries).toEqual([]);
    // Context denial precedes a verified scope; Core must not forge a read-evidence transaction for it.
    expect(harness.snapshot().stages).not.toContain('scope_resolved');
    expect(harness.snapshot().evidenceWrites).toBe(0);
  }),
);
