import { v1 } from '@authzed/authzed-node';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { auditEvents } from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';
import { agentGrantRelationships } from '../install/agent-entity-grants.ts';
import { replaceAgentScopedRolePolicy } from '../install/agent-scoped-role-policy.ts';
import { demoAccountObjectIdParts } from '../install/demo-account-administration.ts';
import type { DemoAccountRelationship } from '../install/demo-account-administration.ts';
import { ConfigureAgentAuditEvidenceSchema } from '../modules/actions/configure-agent.action.ts';
import type { InstalledModuleCatalog } from '../modules/catalog.ts';
import { coreActionCatalog } from '../modules/actions/catalog.ts';
import { ActionAuthorizationLifecycleError } from './action-authorization-lifecycle-error.ts';
import { fullyConsistent } from './client.ts';
import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from './context-access.ts';
import type { SpiceDbRpc } from './spicedb-rpc.ts';

export interface CurrentAgentCompanyProfile {
  readonly active: boolean;
  readonly legalEntityId: string;
  readonly profile: Pick<typeof ConfigureAgentAuditEvidenceSchema.Type, 'modules' | 'writePolicy'> | null;
}

const failed = (cause?: unknown) =>
  new ActionAuthorizationLifecycleError({
    cause,
    reason: 'Agent policy could not be reconciled from current audited profile evidence',
  });

/** Read under the worker's exact company RLS and composition authority fence. */
export const readCurrentAuditedAgentProfile = Effect.fn('AgentProfileLifecycle.readCurrent')(function* readCurrent(
  transaction: CoreTransaction,
  tenantId: string,
  legalEntityId: string,
  principalId: string,
) {
  const [row] = yield* transaction
    .select({ evidence: auditEvents.evidenceJson })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.legalEntityId, legalEntityId),
        eq(auditEvents.eventType, 'action.executed'),
        eq(auditEvents.outcome, 'succeeded'),
        sql`${auditEvents.evidenceJson}->>'actionKey' = 'core.identity.configure-agent'`,
        sql`${auditEvents.evidenceJson}->>'targetPrincipalId' = ${principalId}`,
      ),
    )
    .orderBy(
      sql`(${auditEvents.evidenceJson}->>'revision')::integer desc`,
      desc(auditEvents.occurredAt),
      desc(auditEvents.auditEventId),
    )
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const profile = yield* Schema.decodeUnknownEffect(ConfigureAgentAuditEvidenceSchema)(row.evidence).pipe(
    Effect.mapError(failed),
  );
  if (profile.legalEntityId !== legalEntityId || profile.targetPrincipalId !== principalId) {
    return yield* failed();
  }
  return profile;
});

/** Only composition-owned Actions and module-declared relations can become writes. */
export const currentAgentProfileRelationships = (input: {
  readonly catalog: InstalledModuleCatalog;
  readonly company: CurrentAgentCompanyProfile;
  readonly installedModuleKeys: ReadonlySet<string>;
  readonly namedPermissions: readonly DemoAccountRelationship[];
  readonly principalId: string;
  readonly tenantId: string;
}): readonly v1.Relationship[] => {
  const { company, principalId, tenantId } = input;
  if (!company.active || company.profile === null) {
    return [];
  }
  const contracts = input.catalog.contracts.filter(({ manifest }) => input.installedModuleKeys.has(manifest.module.id));
  const published = new Set(contracts.map(({ manifest }) => manifest.module.id));
  const writeRelations = new Map(
    contracts.map(({ manifest }) => [manifest.module.id, manifest.publicSurface.mcp?.legalEntityWriteRelations ?? []]),
  );
  const companyId = toLegalEntityAccessObjectId(tenantId, company.legalEntityId) ?? '';
  const template: DemoAccountRelationship[] = [
    { relation: 'party_identity_reader', resourceId: tenantId, resourceType: 'tenant' },
    { relation: 'counterparty_reader', resourceId: companyId, resourceType: 'legal_entity' },
    ...[...writeRelations.values()]
      .flat()
      .map((relation) => ({ relation, resourceId: companyId, resourceType: 'legal_entity' })),
    {
      relation: 'accessor_role',
      resourceId: toModuleAccessObjectId(tenantId, company.legalEntityId, 'core.shell') ?? '',
      resourceType: 'module_access',
    },
    ...input.namedPermissions,
  ];
  return agentGrantRelationships({
    actions: [
      // Core Actions are intrinsically installed, as in deriveActionAuthorizationInstalledScopes.
      // They are not business deployment contracts or selectable administration modules.
      ...coreActionCatalog,
      ...contracts.flatMap(({ manifest }) =>
        manifest.publicSurface.actions.map((action) => ({
          actionKey: action.actionKey,
          legalEntityScope: action.legalEntityScope,
          owningModuleKey: action.owningModuleId,
        })),
      ),
    ],
    legalEntityId: company.legalEntityId,
    legalEntityWriteRelations: writeRelations,
    modules: company.profile.modules.filter(({ moduleId }) => published.has(moduleId)),
    principalId,
    template,
    tenantId,
    writePolicy: company.profile.writePolicy,
  });
};

/** Shared read-only metadata input for lifecycle reconciliation and reviewed transition planning. */
export const readCurrentAgentNamedPermissions = Effect.fn('AgentProfileLifecycle.readNamedPermissions')(
  function* readNamedPermissions(
    rpc: SpiceDbRpc,
    scope: { readonly legalEntityId: string; readonly tenantId: string },
  ) {
    // Scope links are installed named-permission metadata, not another person's grants
    // or a seeded persona. Exact canonical identity rejects foreign/ambiguous links.
    const companyId = toLegalEntityAccessObjectId(scope.tenantId, scope.legalEntityId) ?? '';
    const links = yield* rpc.readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency: fullyConsistent,
        relationshipFilter: {
          optionalRelation: 'legal_entity',
          optionalSubjectFilter: {
            optionalSubjectId: companyId,
            subjectType: 'legal_entity',
          },
          resourceType: 'context_permission',
        },
      }),
    );
    const namedPermissions: DemoAccountRelationship[] = [];
    for (const { relationship } of links) {
      if (
        relationship?.resource === undefined ||
        relationship.optionalCaveat !== undefined ||
        relationship.optionalExpiresAt !== undefined
      ) {
        return yield* failed();
      }
      const resourceId = relationship.resource.objectId;
      const [tenantId, kind, companyIdPart, moduleId, permission] = demoAccountObjectIdParts(resourceId);
      if (
        tenantId !== scope.tenantId ||
        kind !== 'legal_entity' ||
        companyIdPart !== scope.legalEntityId ||
        moduleId === undefined ||
        permission === undefined ||
        resourceId !== toContextPermissionAccessObjectId(scope.tenantId, scope.legalEntityId, { moduleId, permission })
      ) {
        return yield* failed();
      }
      namedPermissions.push({
        relation: 'role_grantee',
        resourceId,
        resourceType: 'context_permission',
      });
    }
    return namedPermissions;
  },
);

/** The caller holds principal serialization; no SQL transaction remains open during these RPCs. */
export const reconcileCurrentAgentProfiles = Effect.fn('AgentProfileLifecycle.reconcile')(function* reconcile(
  rpc: SpiceDbRpc,
  input: {
    readonly catalog: InstalledModuleCatalog;
    readonly companies: readonly CurrentAgentCompanyProfile[];
    readonly installedModuleKeys: ReadonlySet<string>;
    readonly principalId: string;
    readonly tenantId: string;
  },
) {
  const currentGroups = yield* Effect.forEach(
    ['tenant', 'legal_entity', 'module_access', 'context_permission', 'action', 'action_grant'],
    (resourceType) =>
      rpc.readRelationships(
        v1.ReadRelationshipsRequest.create({
          consistency: fullyConsistent,
          relationshipFilter: {
            optionalSubjectFilter: { optionalSubjectId: input.principalId, subjectType: 'principal' },
            resourceType,
          },
        }),
      ),
    { concurrency: 2 },
  );
  const currentPrincipalRelationships: v1.Relationship[] = [];
  for (const { relationship } of currentGroups.flat()) {
    if (relationship === undefined) {
      return yield* failed();
    }
    currentPrincipalRelationships.push(relationship);
  }
  yield* Effect.forEach(
    input.companies,
    Effect.fn('AgentProfileLifecycle.reconcileCompany')(function* reconcileCompany(company) {
      const namedPermissions = yield* readCurrentAgentNamedPermissions(rpc, {
        legalEntityId: company.legalEntityId,
        tenantId: input.tenantId,
      });
      yield* replaceAgentScopedRolePolicy(rpc, {
        currentPrincipalRelationships,
        desired: currentAgentProfileRelationships({ ...input, company, namedPermissions }),
        legalEntityId: company.legalEntityId,
        principalId: input.principalId,
        tenantId: input.tenantId,
      });
      return yield* Effect.void;
    }),
    { concurrency: 1 },
  );
  return yield* Effect.void;
});
