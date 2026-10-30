import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  IdentityAdministrationAuditEvidenceSchema,
  IdentityAdministrationAuditInputSchema,
  IdentityAdministrationAuditResultSchema,
  identityAdministrationAuditDetails,
} from '../../src/auth/identity-administration-audit-contract.ts';
import { identityAdministrationAuditRead } from '../../src/auth/identity-administration-audit-read.ts';
import { getReadPermissionTargetResolver } from '../../src/reads/definition.ts';
import { ReadInputValidationError } from '../../src/reads/errors.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const targetId = '30000000-0000-4000-8000-000000000002';
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-25T12:00:00.000Z'));
const principal = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:identity-administration-audit',
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
};
const scopeEffect = Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(principal).pipe(
  Effect.map((admitted) => ({ ...admitted, correlationId: 'original-audit-request' })),
);
const transport = { correlationId: 'original-audit-request' };

it.layer(NodeCrypto.layer)('identity-administration-audit-read', (suite) => {
  suite.effect('declares only tenant manage_identity OR the original selected-company manage_people', () =>
    Effect.gen(function* permissionContract() {
      const scope = yield* scopeEffect;
      const resolver = getReadPermissionTargetResolver(identityAdministrationAuditRead);
      expect(Predicate.isFunction(resolver)).toBe(true);
      if (Predicate.isFunction(resolver)) {
        expect(resolver({ subjects: 'people' }, scope)).toEqual({
          kind: 'any_of',
          targets: [
            { kind: 'tenant', permission: 'manage_identity' },
            { kind: 'legal_entity', permission: 'manage_people' },
          ],
        });
      }
      expect(identityAdministrationAuditRead.descriptor.legalEntityScope).toBe('required');
      expect(identityAdministrationAuditRead.descriptor.entrypoint.authorization).toEqual({
        kind: 'authenticated_principal',
      });
      expect(Object.keys(IdentityAdministrationAuditInputSchema.fields)).toEqual(['subjects']);
    }),
  );

  suite.effect('rejects supplied memberships, tenant/company authority and unknown subjects before SQL', () =>
    Effect.gen(function* forgedInput() {
      const scope = yield* scopeEffect;
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('Unvalidated input reached audit SQL'),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      for (const input of [
        { members: [targetId], subjects: 'people' },
        { memberIds: [targetId], subjects: 'people' },
        { subjects: 'agents', tenantId },
        { legalEntityId, subjects: 'agents' },
        { subjects: 'all' },
      ]) {
        const failure = yield* harness.runtime
          .runRead({ input, principal: scope, registration: identityAdministrationAuditRead, transport })
          .pipe(Effect.flip);
        expect(Schema.is(ReadInputValidationError)(failure)).toBe(true);
      }
      expect(harness.snapshot().ownerQueries).toEqual([]);
    }),
  );

  suite.effect('denied, cross-tenant and missing-company callers execute no audit, member or name SQL', () =>
    Effect.gen(function* admissionBeforeSql() {
      const scope = yield* scopeEffect;
      const denied = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('Denied caller reached audit SQL'),
        operationTime,
        scope,
      });
      yield* denied.runtime
        .runRead({
          input: { subjects: 'people' },
          principal: scope,
          registration: identityAdministrationAuditRead,
          transport,
        })
        .pipe(Effect.flip);
      expect(denied.snapshot().ownerQueries).toEqual([]);
      const allowed = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('Invalid scope reached audit SQL'),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const { legalEntityId: _company, ...withoutCompany } = scope;
      for (const original of [{ ...scope, tenantId: '10000000-0000-4000-8000-000000000099' }, withoutCompany]) {
        yield* allowed.runtime
          .runRead({
            input: { subjects: 'people' },
            principal: original,
            registration: identityAdministrationAuditRead,
            transport,
          })
          .pipe(Effect.flip);
      }
      expect(allowed.snapshot().ownerQueries).toEqual([]);
    }),
  );

  for (const subjects of ['agents', 'people'] as const) {
    suite.effect(
      `${subjects} SQL retains exact scope, event selection, newest-first order, ID tie-break and 80 bound`,
      () =>
        Effect.gen(function* scopedEventSelection() {
          const scope = yield* scopeEffect;
          const harness = yield* makeReadTestHarness({
            executeOwnerQuery: (query) => {
              expect(query.scope).toEqual({ legalEntityId, tenantId });
              expect(query.params).toContain(tenantId);
              expect(query.params).toContain(legalEntityId);
              expect(query.params).toContain('action.executed');
              expect(query.params).toContain('action.rejected');
              expect(query.params.at(-1)).toBe(80);
              expect(query.sql).toContain(
                'order by "core"."audit_events"."occurred_at" desc, "core"."audit_events"."audit_event_id" desc',
              );
              expect(query.sql).toContain('core.identity.manage-demo-account');
              if (subjects === 'agents') {
                for (const action of ['configure-agent', 'manage-agent-status', 'replace-agent-operators']) {
                  expect(query.sql).toContain(`core.identity.${action}`);
                }
                expect(query.params).toContain('identity.agent_operators_changed');
                expect(query.sql).not.toContain('principal_company_memberships');
                expect(query.params).not.toContain('authn.rejected');
              } else {
                expect(query.params).toContain('authn.rejected');
                expect(query.params).toContain('principal_inactive');
                expect(query.params).toContain('human');
                expect(query.sql).toContain('"core"."principal_company_memberships"');
                expect(query.sql).toContain('"core"."principal_company_memberships"."tenant_id" =');
                expect(query.sql).toContain('"core"."principal_company_memberships"."legal_entity_id" =');
                expect(query.sql).not.toContain('"core"."principal_company_memberships"."status" =');
                expect(query.sql).toContain('"core"."audit_events"."legal_entity_id" is null');
                expect(query.params).not.toContain('identity.agent_operators_changed');
              }
              return Effect.succeed([]);
            },
            operationTime,
            ownerAuthorizationDecision: 'allowed',
            permissionDecision: 'allowed',
            scope,
          });
          const result = yield* harness.runtime.runRead({
            input: { subjects },
            principal: scope,
            registration: identityAdministrationAuditRead,
            transport,
          });
          expect(result).toEqual({ entries: [] });
          expect(harness.snapshot().ownerQueries).toHaveLength(1);
          expect(harness.snapshot().evidenceWrites).toBe(1);
        }),
    );
  }

  suite.effect(
    'projects names, safe details and chronology without raw JSON, profile/operator arrays or capabilities',
    () =>
      Effect.gen(function* finiteProjection() {
        const scope = yield* scopeEffect;
        const harness = yield* makeReadTestHarness({
          executeOwnerQuery: (query) => {
            if (query.sql.includes('from "core"."principals"')) {
              expect(query.params).toContain(tenantId);
              expect(query.params).toContain(targetId);
              return Effect.succeed([{ displayName: 'Named agent', principalId: targetId }]);
            }
            return Effect.succeed([
              {
                actorName: 'Administrator',
                auditEventId: '50000000-0000-4000-8000-000000000003',
                eventType: 'action.executed',
                evidence: {
                  actionKey: 'core.identity.replace-agent-operators',
                  agentPrincipalId: targetId,
                  desiredOperatorPrincipalIds: [principalId],
                  operation: 'internal',
                  profile: { private: true },
                  revokedConnections: 2,
                  token: 'must-not-leave-core',
                },
                occurredAt: operationTime,
                outcome: 'succeeded',
                outcomeCode: 'operators_replaced',
                principalId,
              },
              {
                actorName: null,
                auditEventId: '50000000-0000-4000-8000-000000000002',
                eventType: 'action.rejected',
                evidence: {
                  actionKey: 'core.identity.manage-demo-account',
                  displayName: 'Retained name',
                  reason: 'company_administrator_required',
                  targetPrincipalId: '30000000-0000-4000-8000-000000000003',
                },
                occurredAt: operationTime,
                outcome: 'denied',
                outcomeCode: 'company_administrator_required',
                principalId: null,
              },
            ]);
          },
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'allowed',
          scope,
        });
        const result = yield* harness.runtime.runRead({
          input: { subjects: 'agents' },
          principal: scope,
          registration: identityAdministrationAuditRead,
          transport,
        });
        const wire = yield* Schema.encodeEffect(IdentityAdministrationAuditResultSchema)(result);
        expect(wire.entries.map((row) => row.auditEventId)).toEqual([
          '50000000-0000-4000-8000-000000000003',
          '50000000-0000-4000-8000-000000000002',
        ]);
        expect(wire.entries[0]).toMatchObject({
          actorName: 'Administrator',
          details: {
            agentPrincipalId: targetId,
            operation: 'replace-agent-operators',
            revokedConnections: '2',
            targetPrincipalId: targetId,
          },
          occurredAt: '2026-10-25T12:00:00.000Z',
          targetName: 'Named agent',
        });
        expect(wire.entries[1]).toMatchObject({ actorName: null, targetName: 'Retained name' });
        expect(Object.keys(wire.entries[0]?.details ?? {}).toSorted()).toEqual([
          'agentPrincipalId',
          'operation',
          'revokedConnections',
          'targetPrincipalId',
        ]);
        expect(Object.keys(wire).toSorted()).toEqual(['entries']);
        expect(harness.snapshot().ownerQueries).toHaveLength(2);
      }),
  );

  suite.effect('inactive-person rejection targets the retained principal; optional scalars become native Options', () =>
    Effect.gen(function* inactiveDetails() {
      const evidence = yield* Schema.decodeUnknownEffect(IdentityAdministrationAuditEvidenceSchema)({
        audience: null,
        reason: 'principal_disabled',
        source: 'operational_scope',
        targetPrincipalId: targetId,
      });
      const details = yield* identityAdministrationAuditDetails(evidence, 'authn.rejected', principalId);
      expect(details.targetPrincipalId).toEqual(Option.some(principalId));
      expect(details.audience).toEqual(Option.none());
      expect(details.reason).toEqual(Option.some('principal_disabled'));
      expect(details).not.toHaveProperty('source');
      const unsupported = yield* identityAdministrationAuditDetails({ revokedConnections: 7 }, 'action.executed', null);
      expect(unsupported).not.toHaveProperty('revokedConnections');
    }),
  );
});
