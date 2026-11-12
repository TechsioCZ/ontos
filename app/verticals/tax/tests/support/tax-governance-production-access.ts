import {
  AccessDecisionLive,
  AccessDecisionLog,
  AccessIntentLive,
  AccessPrincipalKindSource,
  DecisionCheck,
  LegalEntityCandidates,
  makeDrizzleAccessDecisionLog,
  makeDrizzleAccessPrincipalKinds,
  makeDrizzleLegalEntityCandidates,
} from '@app/core-runtime/access/enforcement';
import type { AccessDecisionLogEntry, PrincipalKindQuery } from '@app/core-runtime/access/enforcement';
import type { DatabaseIdentityEnrollment } from '@app/core-runtime';
import type { CoreDatabase } from '@app/core-runtime/db/client';
import { makeTenantIntentLoader, TenantIntentLoader } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { makeActionTestAccessFences } from '@app/core-runtime/testing/actions';
import type { ActionTestAccessFenceQuery, ActionTestAccessFenceRow } from '@app/core-runtime/testing/actions';
import { Crypto, Effect, Layer, Option, Schema } from 'effect';
import { expect } from 'effect-rstest';

import { createTaxRuleAction } from '../../src/actions/create-tax-rule.action.ts';

const tenantScopeId = '99999999-9999-4999-8999-999999999998';
const sellerScopeId = '99999999-9999-4999-8999-999999999999';
const otherSellerScopeId = '99999999-9999-4999-8999-999999999997';
const roleId = '50000000-0000-4000-8000-000000000001';
const assignmentId = '60000000-0000-4000-8000-000000000001';
const roleRevisionId = '50000000-0000-4000-8000-000000000002';
const grantId = '60000000-0000-4000-8000-000000000002';
const catalogSnapshotId = '70000000-0000-4000-8000-000000000001';
const recordedAt = '2026-11-01T00:00:00.000Z';

interface TaxProductionFixtureDatabase {
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly executor: (typeof CoreDatabase)['Service']['executor'];
}

// Exact projection test vectors for this fixture's original tenant, seller, role and capability.
// The production engine derives these identities; the external check double must see all four
// correlated questions, not an arbitrary allow for a capability or a different seller.
const projected = {
  assignment:
    'as_WyIxMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCI5OTk5OTk5OS05OTk5LTQ5OTktODk5OS05OTk5OTk5OTk5OTkiLCI2MDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiXQ',
  binding:
    'rb_WyIxMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCI5OTk5OTk5OS05OTk5LTQ5OTktODk5OS05OTk5OTk5OTk5OTkiLCI1MDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiXQ',
  capability:
    'cp_WyIxMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCI5OTk5OTk5OS05OTk5LTQ5OTktODk5OS05OTk5OTk5OTk5OTkiLCJjb21tZXJjZS50YXgudGF4LXJ1bGUuY3JlYXRlIl0',
  grant:
    'gr_WyIxMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCI5OTk5OTk5OS05OTk5LTQ5OTktODk5OS05OTk5OTk5OTk5OTkiLCI1MDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJjb21tZXJjZS50YXgudGF4LXJ1bGUuY3JlYXRlIiwicnVuIiwiYWxsIl0',
};

export const makeTaxGovernanceAccessFixture = Effect.fn('TaxProductionRuntimeTest.accessRows')(
  function* accessRows(input: {
    readonly fenceState: 'Ready' | 'Changing' | 'missing';
    readonly grantedSellers: readonly string[];
    readonly graphAnswer: 'has' | 'error';
    readonly principalId: string;
    readonly sellerA: string;
    readonly sellerB: string;
    readonly tenantId: string;
    readonly transactionOpen: () => boolean;
  }) {
    const { principalId, sellerA, sellerB, tenantId } = input;
    expect(input.grantedSellers.every((seller) => seller === sellerA)).toBe(true);
    const declaration = createTaxRuleAction.descriptor.accessDeclaration;
    if (declaration === undefined) {
      return yield* Effect.die('The original Tax Action must publish its capability');
    }
    const capabilityKey = declaration.key;
    expect(capabilityKey).toBe('commerce.tax.tax-rule.create');
    const scopes = [
      { legalEntityId: null, scopeId: tenantScopeId, tenantContextId: null, tenantId },
      { legalEntityId: sellerA, scopeId: sellerScopeId, tenantContextId: tenantScopeId, tenantId },
      { legalEntityId: sellerB, scopeId: otherSellerScopeId, tenantContextId: tenantScopeId, tenantId },
    ];
    const fences = yield* makeActionTestAccessFences(
      scopes.flatMap((scope) => {
        if (scope.legalEntityId === sellerA && input.fenceState === 'missing') {
          return [];
        }
        const row: ActionTestAccessFenceRow = {
          revision: 7,
          scopeId: scope.scopeId,
          state: scope.legalEntityId === sellerA && input.fenceState === 'Changing' ? 'Changing' : 'Ready',
          tenantId,
        };
        return [scope.legalEntityId === null ? row : { ...row, legalEntityId: scope.legalEntityId }];
      }),
    );
    const kindQueries: PrincipalKindQuery[] = [];
    const decisions: AccessDecisionLogEntry[] = [];
    let remoteChecks = 0;
    const read = (query: ActionTestAccessFenceQuery) => {
      const fence = fences.read(query);
      if (Option.isSome(fence)) {
        return fence;
      }
      const sql = query.sql.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
      const { params, scope } = query;
      const scoped = () => {
        expect(scope.tenantId).toBe(tenantId);
        expect([sellerA, sellerB]).toContain(scope.legalEntityId);
        expect(params).toContain(tenantId);
      };
      if (sql.startsWith('select "kind" from "core"."principals"')) {
        expect(scope.tenantId).toBe(tenantId);
        expect(params).toEqual([principalId, 1]);
        return Option.some(Effect.succeed([{ kind: 'human' }]));
      }
      if (sql.includes('from "core"."access_scopes"')) {
        scoped();
        expect(params).toEqual([tenantId]);
        expect(sql).toMatch(/^select "legal_entity_id", "scope_id", "tenant_context_id", "tenant_id" /u);
        return Option.some(Effect.succeed(scopes));
      }
      if (sql.includes('from "core"."access_memberships"')) {
        scoped();
        expect(params).toEqual([tenantId]);
        return Option.some(
          Effect.succeed(
            scopes.map((item, index) => ({
              agentId: null,
              createdAt: recordedAt,
              kind: 'member',
              membershipId: `80000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
              principalId,
              recordedBy: principalId,
              scopeId: item.scopeId,
              status: 'active',
              tenantId,
              validFrom: recordedAt,
              validUntil: null,
            })),
          ),
        );
      }
      if (sql.includes('from "core"."access_assignments"')) {
        scoped();
        expect(params).toContain(principalId);
        expect(params).toContain(scope.legalEntityId === sellerA ? sellerScopeId : otherSellerScopeId);
        return Option.some(
          Effect.succeed(
            scope.legalEntityId === sellerA && input.grantedSellers.includes(sellerA)
              ? [
                  {
                    agentId: null,
                    assignedBy: principalId,
                    delegatedBy: null,
                    delegationEnvelopeJson: null,
                    incarnationId: assignmentId,
                    principalId,
                    roleId,
                    roleRevisionId,
                    scopeId: sellerScopeId,
                    status: 'active',
                    tenantId,
                    validFrom: recordedAt,
                    validUntil: null,
                  },
                ]
              : [],
          ),
        );
      }
      if (sql.includes('from "core"."access_role_revisions"')) {
        scoped();
        // The cell read narrows the revision to the asked capability and mode (run or propose) in the statement.
        expect([params[0], params.slice(-2)]).toEqual([capabilityKey, [tenantId, roleRevisionId]]);
        expect(['run', 'propose']).toContain(params[1]);
        return Option.some(
          Effect.succeed([
            {
              catalogSnapshotId,
              cellsJson: [{ capabilityKey, mode: 'run', selector: { _tag: 'all' } }],
              createdAt: recordedAt,
              createdBy: principalId,
              provenance: 'manual',
              revision: 1,
              roleId,
              roleRevisionId,
              templateKey: null,
              tenantId,
            },
          ]),
        );
      }
      if (sql.includes('from "core"."access_grant_incarnations"')) {
        scoped();
        const mode = Schema.decodeUnknownSync(Schema.Literals(['run', 'propose']))(params[4]);
        expect(params).toEqual([tenantId, sellerScopeId, 'active', capabilityKey, mode, roleId]);
        // The loader indexes a batch's grants by the capability and mode each row carries, as the table stores them.
        return Option.some(
          Effect.succeed(
            mode === 'run' ? [{ capabilityKey, grantIncarnationId: grantId, mode, roleId, slot: 'all' }] : [],
          ),
        );
      }
      if (sql.includes('from "core"."access_delegations"')) {
        scoped();
        expect(params).toEqual([tenantId]);
        return Option.some(Effect.succeed([]));
      }
      if (sql.startsWith('insert into "core"."access_decision_logs"')) {
        scoped();
        expect(params).toContain(principalId);
        expect(params).toContain(capabilityKey);
        expect(params).toContain(scope.legalEntityId === sellerA ? sellerScopeId : otherSellerScopeId);
        return Option.some(Effect.succeed([]));
      }
      return Option.none();
    };
    const graphResult = () => ({ permissionship: input.graphAnswer });
    const makeLayer = Effect.fn('TaxProductionRuntimeTest.canonicalGate')(function* canonicalGate(
      database: TaxProductionFixtureDatabase,
    ) {
      const kinds = makeDrizzleAccessPrincipalKinds(database);
      const log = makeDrizzleAccessDecisionLog(database, yield* Crypto.Crypto);
      const ports = Layer.mergeAll(
        AccessIntentLive.pipe(Layer.provide(Layer.succeed(TenantIntentLoader, makeTenantIntentLoader(database)))),
        Layer.succeed(AccessPrincipalKindSource, {
          readKind: (query, transaction) => {
            kindQueries.push(query);
            return kinds.readKind(query, transaction);
          },
        }),
        Layer.succeed(AccessDecisionLog, {
          record: (entry, transaction) => {
            decisions.push(entry);
            return log.record(entry, transaction);
          },
        }),
        Layer.succeed(LegalEntityCandidates, makeDrizzleLegalEntityCandidates(database)),
        Layer.succeed(DecisionCheck, {
          checkBulk: (items) =>
            Effect.sync(() => {
              expect(input.transactionOpen()).toBe(false);
              const subject = { id: principalId, type: 'principal' };
              expect(items).toEqual([
                { permission: 'use', resource: { id: projected.grant, type: 'access_grant' }, subject },
                {
                  permission: 'run_all_grant',
                  resource: { id: projected.capability, type: 'access_capability' },
                  subject: { id: projected.grant, type: 'access_grant' },
                },
                { permission: 'eligible', resource: { id: projected.assignment, type: 'access_assignment' }, subject },
                {
                  permission: 'member',
                  resource: { id: projected.binding, type: 'access_role_binding' },
                  subject: { id: projected.assignment, relation: 'holder', type: 'access_assignment' },
                },
              ]);
              remoteChecks += 1;
              return items.map(graphResult);
            }),
        }),
      );
      return AccessDecisionLive.pipe(Layer.provideMerge(ports));
    });
    return { decisions, kindQueries, makeLayer, read, remoteChecks: () => remoteChecks };
  },
);
