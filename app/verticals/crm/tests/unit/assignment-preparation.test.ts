import {
  ActiveApplicationCompositionService,
  DatabaseIdentityEnrollmentContext,
  SHARED_RUNTIME_IDENTITY,
  defineDatabaseIdentityEnrollment,
} from '@app/core-runtime';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { AssignablePrincipals, makeAssignablePrincipals } from '@app/core-runtime/auth/assignable-principals';
import { inertAccessEnforcementPorts, makeTestAccessGateLayers } from '@app/core-runtime/testing/access-gate';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { Effect, Layer, Option, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { ApplyCommandPayloadSchema, CrmRevisionConflict } from '../../shared/actions/apply-command.ts';
import {
  crmApplyCommandDeclaration,
  crmClientOwnerAssignGroup,
  crmRecordsReadDeclaration,
} from '../../shared/domain/access-declarations.ts';
import { CrmStateSchema } from '../../shared/domain/state.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { assignmentPolicy } from '../../src/services/assignment-policy.ts';
import { crmRegistration } from '../../vertical.registration.ts';
import { scope, state } from './search-fixtures.ts';

const assignee = '30000000-0000-4000-8000-000000000002';
const principal = {
  ...scope,
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:crm-assignment-preparation',
  authMethod: 'session' as const,
};
const payload = Schema.decodeUnknownSync(ApplyCommandPayloadSchema)({
  command: { _tag: 'AssignClient', clientId: 'client-1', toSalespersonId: 'target' },
  expectedRevision: 1,
});
const unusedRemoteBoundary = () =>
  Effect.die('No Party credential or remote request belongs to assignment preparation');
const ownerAccess = Layer.mergeAll(
  makeTestAccessGateLayers({
    spec: {
      answers: {
        [crmApplyCommandDeclaration.key]: { outcome: 'ALLOWED' },
        [crmClientOwnerAssignGroup.key]: { outcome: 'ALLOWED' },
        [crmRecordsReadDeclaration.key]: { outcome: 'ALLOWED', predicate: { groups: [] } },
      },
    },
  }),
  Layer.succeed(ActiveApplicationCompositionService, { load: unusedRemoteBoundary() }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unusedRemoteBoundary() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/actions')),
  ),
);
const scenarios = [
  'gate-denied',
  'inactive-membership',
  'inactive-principal',
  'foreign-tenant',
  'missing-member',
  'unbound-owner',
  'unassignable',
  'unavailable',
  'stale',
] as const;
type Scenario = (typeof scenarios)[number];

const registeredAssignment = (scenario: Scenario) =>
  Effect.scoped(
    Effect.gen(function* registeredPreparation() {
      let sqlDepth = 0;
      let directoryLoads = 0;
      let eligibilityChecks = 0;
      let ownerWrites = 0;
      const stored = {
        ...Schema.encodeSync(CrmStateSchema)(state),
        salespeople: [
          scenario === 'unbound-owner'
            ? { active: true, id: 'target', name: 'Unbound historical salesperson' }
            : { active: true, id: 'target', name: 'Target salesperson', principalId: assignee },
        ],
      };
      const connection = testSqlConnection((sql, params) => {
        if (/^begin/iu.test(sql)) {
          sqlDepth += 1;
          return Effect.succeed([]);
        }
        if (/^(?:commit|rollback)$/iu.test(sql)) {
          sqlDepth -= 1;
          return Effect.succeed([]);
        }
        if (sql.includes("set_config('ontos.tenant_id'")) {
          expect(params).toEqual([scope.tenantId, scope.legalEntityId]);
          return Effect.succeed([]);
        }
        if (sql.includes('current_user::text as role')) {
          return Effect.succeed([
            { legal_entity_id: scope.legalEntityId, role: SHARED_RUNTIME_IDENTITY.role, tenant_id: scope.tenantId },
          ]);
        }
        if (sql.includes('"core"."principal_company_memberships"')) {
          directoryLoads += 1;
          expect(params).toContain(scope.tenantId);
          expect(params).toContain(scope.legalEntityId);
          return Effect.succeed(
            scenario === 'missing-member'
              ? []
              : [
                  {
                    displayName: 'Target salesperson',
                    membershipStatus: scenario === 'inactive-membership' ? 'disabled' : 'active',
                    principalId: assignee,
                    principalStatus: scenario === 'inactive-principal' ? 'disabled' : 'active',
                    tenantId: scenario === 'foreign-tenant' ? assignee : scope.tenantId,
                  },
                ],
          );
        }
        if (sql.includes('"core"."access_agent_connections"')) {
          return Effect.succeed([]);
        }
        if (sql.includes('"demo_crm"."crm_states"')) {
          expect(params).toEqual([scope.tenantId, scope.legalEntityId, 1]);
          return Effect.succeed([{ revision: scenario === 'stale' ? 2 : 1, state: stored }]);
        }
        return Effect.die(`Unexpected assignment preparation SQL: ${sql}`);
      });
      const executor = yield* testCoreDatabase.pipe(
        Effect.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
      );
      const inert = inertAccessEnforcementPorts();
      const eligibility = makeAssignablePrincipals({
        ...inert,
        principalKinds: {
          readKind: (input) => {
            eligibilityChecks += 1;
            // The directory/owner snapshot is committed before any remote eligibility port runs.
            expect(sqlDepth).toBe(0);
            expect(input.principalId).toBe(assignee);
            return scenario === 'unavailable' ? inert.principalKinds.readKind(input) : Effect.succeed(Option.none());
          },
        },
      });
      const harness = yield* makeActionTestHarness({
        access: scenario === 'gate-denied' ? 'denied' : 'allowed',
        ownerRegistration: crmRegistration,
        services: [
          bindActionTestServices(applyCommandAction, {
            apply: () => {
              ownerWrites += 1;
              return Effect.fail(new CrmRevisionConflict({ code: 'crm_revision_conflict', reason: 'Stale revision' }));
            },
            loadAssignmentDirectory: () => Effect.die('Preparation must use its real Core directory snapshot'),
            loadRecords: () => Effect.die('Preparation must not call the records transport'),
          }),
        ],
      });
      const invoke = harness.runtime
        .runAction({
          payload,
          principal,
          registration: applyCommandAction,
          transport: { correlationId: scope.correlationId, idempotencyKey: `assignment-${scenario}` },
        })
        .pipe(
          Effect.provide(ownerAccess),
          Effect.provideService(CoreDatabase, { executor }),
          Effect.provideService(DatabaseIdentityEnrollmentContext, defineDatabaseIdentityEnrollment([])),
          Effect.provideService(AssignablePrincipals, eligibility),
        );
      const failure = yield* invoke.pipe(Effect.flip);
      if (scenario === 'stale') {
        expect(failure._tag).toBe('CrmRevisionConflict');
        expect(ownerWrites).toBe(1);
        expect(eligibilityChecks).toBe(0);
        expect(harness.snapshot().policyDenials).toEqual([]);
      } else if (scenario === 'gate-denied') {
        expect(failure._tag).toBe('ActionPermissionDenied');
        expect(directoryLoads).toBe(0);
        expect(ownerWrites).toBe(0);
        expect(harness.snapshot().policyDenials).toEqual([]);
      } else {
        expect(failure._tag).toBe('ActionPolicyDenied');
        expect(ownerWrites).toBe(0);
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().policyDenials).toHaveLength(1);
        expect(harness.snapshot().policyDenials[0]).toMatchObject({
          actionKey: applyCommandAction.descriptor.actionKey,
          policy: { owningModuleKey: 'demo.crm', policyKey: assignmentPolicy.policyKey, scope: 'microvertical' },
          reasonCode: scenario === 'unavailable' ? 'assignment_unavailable' : 'assignment_ineligible',
        });
        const loads = directoryLoads;
        expect((yield* invoke.pipe(Effect.flip))._tag).toBe('ActionPolicyDenied');
        expect(directoryLoads).toBe(loads);
        expect(harness.snapshot().policyDenials).toHaveLength(1);
      }
      expect(harness.snapshot().committed).toEqual([]);
      expect(sqlDepth).toBe(0);
      expect(directoryLoads).toBe(scenario === 'gate-denied' ? 0 : 1);
      expect(eligibilityChecks).toBe(Number(scenario === 'unassignable' || scenario === 'unavailable'));
      return { directoryLoads, eligibilityChecks };
    }),
  );

for (const scenario of scenarios) {
  it.effect(`actual CRM preparation preserves assignment policy and ordering: ${scenario}`, () =>
    registeredAssignment(scenario),
  );
}
