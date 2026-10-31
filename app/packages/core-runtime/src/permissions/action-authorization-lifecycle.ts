import { v1 } from '@authzed/authzed-node';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Context, Effect, Layer, Redacted } from 'effect';

import { CoreDatabase } from '../db/client.ts';
import { DatabaseConfig } from '../db/config.ts';
import type { CoreTransaction } from '../db/types.ts';
import { withPostgresSessionAdvisoryLock } from '../db/session-advisory-lock.ts';
import { legalEntities, principalCompanyMemberships, principals, tenantModuleStates, tenants } from '../db/schema.ts';
import { reconcileScopedActionAuthorization } from '../install/action-authorization-provisioning.ts';
import type {
  ActionAuthorizationInstalledModuleScope,
  ActionAuthorizationProvisioningAction,
} from '../install/action-authorization-provisioning.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
import { coreActionCatalog } from '../modules/actions/catalog.ts';
import { readLatestAgentOperatorCommand } from '../modules/actions/agent-operator-command.ts';
import type { AgentOperatorCommand } from '../modules/actions/agent-operator-command.ts';
import { lockApplicationCompositionAuthority } from '../modules/application-composition-authority.ts';
import { buildApplicationCompositionCatalog } from '../modules/application-composition-catalog.ts';
import { readCurrentAuditedAgentProfile, reconcileCurrentAgentProfiles } from './agent-profile-lifecycle.ts';
import { buildCompanyMembershipUpdates } from './company-membership.ts';
import { SpiceDbConfig } from './config.ts';
import { openSpiceDbRpc } from './spicedb-transaction-guard.ts';
import { ScopedRoleMembershipLifecycle } from './scoped-role-membership-lifecycle.ts';
import type { ScopedRoleIdentity } from './scoped-role.ts';
import { fullyConsistent } from './client.ts';
import { toLegalEntityAccessObjectId } from './context-access.ts';
import { operatorChanges } from './principal-operators.ts';
import type { SpiceDbRpc } from './spicedb-rpc.ts';

import { ActionAuthorizationLifecycleError } from './action-authorization-lifecycle-error.ts';

const coreModuleKeys = coreActionCatalog.map(({ owningModuleKey }) => owningModuleKey);

const failed = (cause?: unknown) =>
  new ActionAuthorizationLifecycleError({
    cause,
    reason: 'Installed Action authorization could not be reconciled safely',
  });

export interface ActionAuthorizationInstallationSnapshot {
  readonly companies: readonly { readonly legalEntityId: string; readonly status: string }[];
  readonly coreModuleKeys: readonly string[];
  readonly publishedModuleKeys: readonly string[];
  readonly tenantActive: boolean;
  readonly tenantId: string;
  readonly tenantModules: readonly { readonly moduleKey: string; readonly state: string }[];
}

/** Tenant installation is multiplied by companies; it is never a per-company module switch. */
export const deriveActionAuthorizationInstalledScopes = (
  snapshot: ActionAuthorizationInstallationSnapshot,
): readonly ActionAuthorizationInstalledModuleScope[] => {
  const published = new Set(snapshot.publishedModuleKeys);
  const moduleKeys = snapshot.tenantActive
    ? [
        ...new Set([
          ...snapshot.coreModuleKeys,
          ...snapshot.tenantModules.flatMap(({ moduleKey, state }) =>
            state === 'active' && published.has(moduleKey) ? [moduleKey] : [],
          ),
        ]),
      ].toSorted()
    : [];
  return [
    { moduleKeys, tenantId: snapshot.tenantId },
    ...snapshot.companies.map(({ legalEntityId, status }) => ({
      legalEntityId,
      moduleKeys: status === 'active' ? moduleKeys : [],
      tenantId: snapshot.tenantId,
    })),
  ];
};

/** Structural tenancy is not a grant. Only an active human receives the exact reflexive self edge. */
export const buildPrincipalSelfCredentialUpdates = (input: {
  readonly kind: string;
  readonly principalId: string;
  readonly status: string;
  readonly tenantActive: boolean;
  readonly tenantId: string;
}): readonly v1.RelationshipUpdate[] => [
  v1.RelationshipUpdate.create({
    operation: v1.RelationshipUpdate_Operation.TOUCH,
    relationship: {
      relation: 'tenant',
      resource: { objectId: input.principalId, objectType: 'principal' },
      subject: { object: { objectId: input.tenantId, objectType: 'tenant' } },
    },
  }),
  v1.RelationshipUpdate.create({
    operation:
      input.kind === 'human' && input.status === 'active' && input.tenantActive
        ? v1.RelationshipUpdate_Operation.TOUCH
        : v1.RelationshipUpdate_Operation.DELETE,
    relationship: {
      relation: 'self',
      resource: { objectId: input.principalId, objectType: 'principal' },
      subject: { object: { objectId: input.principalId, objectType: 'principal' } },
    },
  }),
];

/** Separate provenance prevents company departure from deleting independent tenant admission. */
export const buildCompanyTenantAdmissionUpdate = (input: {
  readonly membershipUpdates: readonly v1.RelationshipUpdate[];
  readonly principalId: string;
  readonly tenantId: string;
}): v1.RelationshipUpdate =>
  v1.RelationshipUpdate.create({
    operation: input.membershipUpdates.some((update) => update.operation === v1.RelationshipUpdate_Operation.TOUCH)
      ? v1.RelationshipUpdate_Operation.TOUCH
      : v1.RelationshipUpdate_Operation.DELETE,
    relationship: {
      relation: 'company_member',
      resource: { objectId: input.tenantId, objectType: 'tenant' },
      subject: { object: { objectId: input.principalId, objectType: 'principal' } },
    },
  });

const readCurrentCompanyMembershipUpdates = Effect.fn(
  'ActionAuthorizationLifecycle.readCurrentCompanyMembershipUpdates',
)(function* readCurrentCompanyMembershipUpdates(
  transaction: CoreTransaction,
  principal: {
    readonly kind: string;
    readonly status: string;
    readonly tenantStatus: string;
  },
  tenantId: string,
  principalId: string,
) {
  const companies = yield* transaction
    .select({ legalEntityId: legalEntities.legalEntityId, status: legalEntities.status })
    .from(legalEntities)
    .where(eq(legalEntities.tenantId, tenantId));
  const membershipUpdates = yield* Effect.forEach(
    companies,
    Effect.fn(function* readCompanyMembership(company) {
      // Membership RLS remains exact company scope, including for an attested Core worker.
      // These settings are transaction-local and never escape to another pool user.
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${company.legalEntityId}, true)`,
        'objects',
      );
      const [membership] = yield* transaction
        .select({
          affiliation: principalCompanyMemberships.affiliation,
          status: principalCompanyMemberships.status,
        })
        .from(principalCompanyMemberships)
        .where(
          and(
            eq(principalCompanyMemberships.tenantId, tenantId),
            eq(principalCompanyMemberships.legalEntityId, company.legalEntityId),
            eq(principalCompanyMemberships.principalId, principalId),
          ),
        );
      const updates =
        membership === undefined
          ? []
          : buildCompanyMembershipUpdates({
              affiliation: membership.affiliation,
              companyActive: company.status === 'active',
              kind: principal.kind,
              legalEntityId: company.legalEntityId,
              principalId,
              principalStatus: principal.status,
              status: membership.status,
              tenantActive: principal.tenantStatus === 'active',
              tenantId,
            });
      const profile =
        principal.kind === 'agent' && principal.status !== 'archived'
          ? yield* readCurrentAuditedAgentProfile(transaction, tenantId, company.legalEntityId, principalId)
          : null;
      return {
        agentProfile: {
          active: updates.some((update) => update.operation === v1.RelationshipUpdate_Operation.TOUCH),
          legalEntityId: company.legalEntityId,
          profile,
        },
        updates,
      };
    }),
    { concurrency: 1 },
  );
  return {
    agentProfiles: membershipUpdates.map(({ agentProfile }) => agentProfile),
    membershipUpdates: membershipUpdates.flatMap(({ updates }) => updates),
  };
});

interface CurrentAgentOperatorState {
  readonly activeHumanIds: readonly string[];
  readonly command: AgentOperatorCommand | null;
  readonly companyActive: boolean;
}

/** No-command agents retain their pre-native operators; archive cleanup is unconditional. */
export const deriveCurrentAgentOperatorSet = (
  input: CurrentAgentOperatorState & {
    readonly companyMemberIds: readonly string[];
    readonly status: string;
    readonly tenantActive: boolean;
  },
): readonly string[] | null => {
  if (input.status === 'archived') {
    return [];
  }
  if (input.command === null) {
    return null;
  }
  const members = new Set(input.companyMemberIds);
  if (
    !input.tenantActive ||
    input.status !== 'active' ||
    !input.companyActive ||
    !members.has(input.command.agentPrincipalId)
  ) {
    return [];
  }
  const activeHumans = new Set(input.activeHumanIds);
  return input.command.desiredOperatorPrincipalIds.filter((id) => activeHumans.has(id) && members.has(id));
};

const readCurrentAgentOperatorState = Effect.fn('ActionAuthorizationLifecycle.readCurrentAgentOperators')(
  function* readCurrentAgentOperators(
    transaction: CoreTransaction,
    tenantId: string,
    principalId: string,
    status: string,
  ) {
    // Archive cleanup must not depend on old evidence remaining decodable.
    const command =
      status === 'archived' ? null : yield* readLatestAgentOperatorCommand(transaction, tenantId, principalId);
    if (command === null) {
      return { activeHumanIds: [], command, companyActive: false } satisfies CurrentAgentOperatorState;
    }
    const [company] = yield* transaction
      .select({ status: legalEntities.status })
      .from(legalEntities)
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.legalEntityId, command.legalEntityId)));
    const humans =
      command.desiredOperatorPrincipalIds.length === 0
        ? []
        : yield* transaction
            .select({ principalId: principals.principalId })
            .from(principals)
            .where(
              and(
                eq(principals.tenantId, tenantId),
                eq(principals.kind, 'human'),
                eq(principals.status, 'active'),
                inArray(principals.principalId, [...command.desiredOperatorPrincipalIds]),
              ),
            );
    return {
      activeHumanIds: humans.map(({ principalId: id }) => id),
      command,
      companyActive: company?.status === 'active',
    } satisfies CurrentAgentOperatorState;
  },
);

const exactPrincipalSubjects = (responses: readonly v1.ReadRelationshipsResponse[]) =>
  Effect.forEach(
    responses,
    ({ relationship }) => {
      if (
        relationship?.subject?.object?.objectType !== 'principal' ||
        relationship.subject.optionalRelation !== '' ||
        relationship.optionalCaveat !== undefined ||
        relationship.optionalExpiresAt !== undefined
      ) {
        return Effect.fail(failed());
      }
      return Effect.succeed(relationship.subject.object.objectId);
    },
    { concurrency: 1 },
  );

/** Runs only after SQL ends, under the EXISTING per-principal session lock. */
const reconcileCurrentAgentOperators = Effect.fn('ActionAuthorizationLifecycle.reconcileCurrentAgentOperators')(
  function* reconcileCurrentAgentOperators(
    rpc: SpiceDbRpc,
    input: CurrentAgentOperatorState & {
      readonly principalId: string;
      readonly status: string;
      readonly tenantActive: boolean;
      readonly tenantId: string;
    },
  ) {
    if (input.status !== 'archived' && input.command === null) {
      return;
    }
    const companyMemberIds =
      input.command === null
        ? []
        : yield* rpc
            .readRelationships(
              v1.ReadRelationshipsRequest.create({
                consistency: fullyConsistent,
                relationshipFilter: {
                  optionalRelation: 'member',
                  optionalResourceId: toLegalEntityAccessObjectId(input.tenantId, input.command.legalEntityId) ?? '',
                  optionalSubjectFilter: { subjectType: 'principal' },
                  resourceType: 'legal_entity',
                },
              }),
            )
            .pipe(Effect.flatMap(exactPrincipalSubjects));
    const desired = deriveCurrentAgentOperatorSet({ ...input, companyMemberIds });
    if (desired === null) {
      return;
    }
    const current = yield* rpc
      .readRelationships(
        v1.ReadRelationshipsRequest.create({
          consistency: fullyConsistent,
          relationshipFilter: {
            optionalRelation: 'operator',
            optionalResourceId: input.principalId,
            resourceType: 'principal',
          },
        }),
      )
      .pipe(Effect.flatMap(exactPrincipalSubjects));
    const changes = operatorChanges(current, desired);
    const update = (id: string, operation: v1.RelationshipUpdate_Operation) =>
      v1.RelationshipUpdate.create({
        operation,
        relationship: {
          relation: 'operator',
          resource: { objectId: input.principalId, objectType: 'principal' },
          subject: { object: { objectId: id, objectType: 'principal' } },
        },
      });
    const updates = [
      ...changes.add.map((id) => update(id, v1.RelationshipUpdate_Operation.TOUCH)),
      ...changes.remove.map((id) => update(id, v1.RelationshipUpdate_Operation.DELETE)),
    ];
    if (updates.length > 0) {
      yield* rpc.writeRelationships(v1.WriteRelationshipsRequest.create({ updates }));
    }
  },
);

export class ActionAuthorizationLifecycle extends Context.Service<
  ActionAuthorizationLifecycle,
  {
    readonly reconcilePrincipal: (
      tenantId: string,
      principalId: string,
      compositionRevision: string,
    ) => Effect.Effect<void, ActionAuthorizationLifecycleError>;
    readonly reconcileScopedRoleMembership: (
      role: ScopedRoleIdentity,
      principalId: string,
      compositionRevision: string,
    ) => Effect.Effect<void, ActionAuthorizationLifecycleError>;
    readonly reconcileTenant: (
      tenantId: string,
      compositionRevision: string,
    ) => Effect.Effect<void, ActionAuthorizationLifecycleError>;
  }
>()('@app/core-runtime/permissions/action-authorization-lifecycle/ActionAuthorizationLifecycle') {}

export const ActionAuthorizationLifecycleLive = Layer.effect(
  ActionAuthorizationLifecycle,
  Effect.gen(function* makeActionAuthorizationLifecycle() {
    const database = yield* CoreDatabase;
    const configuration = yield* DatabaseConfig;
    const authority = yield* ActiveApplicationCompositionService;
    const spiceConfiguration = yield* SpiceDbConfig;
    const roleLifecycle = yield* ScopedRoleMembershipLifecycle;
    return {
      reconcilePrincipal: Effect.fn('ActionAuthorizationLifecycle.reconcilePrincipal')(function* reconcilePrincipal(
        tenantId: string,
        principalId: string,
        compositionRevision: string,
      ) {
        return yield* withPostgresSessionAdvisoryLock(
          Redacted.make(configuration.connectionString),
          `ontos.principal-self-credentials:${tenantId}:${principalId}`,
          Effect.gen(function* reconcileSerializedPrincipal() {
            const snapshot = yield* authority.load.pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
            if (snapshot.composition.revision !== compositionRevision) {
              return yield* failed();
            }
            const current = yield* database.executor.transaction(
              Effect.fn(function* readLatestPrincipal(transaction) {
                yield* lockApplicationCompositionAuthority(transaction, compositionRevision, 'worker');
                const [principal] = yield* transaction
                  .select({
                    kind: principals.kind,
                    status: principals.status,
                    tenantStatus: tenants.status,
                  })
                  .from(principals)
                  .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
                  .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, principalId)));
                if (principal === undefined) {
                  return yield* failed();
                }
                const membership = yield* readCurrentCompanyMembershipUpdates(
                  transaction,
                  principal,
                  tenantId,
                  principalId,
                );
                const installedModules =
                  principal.kind === 'agent'
                    ? yield* transaction
                        .select({ moduleKey: tenantModuleStates.moduleKey })
                        .from(tenantModuleStates)
                        .where(and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.state, 'active')))
                    : [];
                const operators =
                  principal.kind === 'agent'
                    ? yield* readCurrentAgentOperatorState(transaction, tenantId, principalId, principal.status)
                    : null;
                return { ...principal, ...membership, installedModules, operators };
              }),
            );
            // The SQL fence ended. An old delivery always applies the current row, never old event authority.
            const client = yield* Effect.acquireRelease(
              Effect.try({ catch: failed, try: () => openSpiceDbRpc(spiceConfiguration, 5000) }),
              (rpc) => Effect.sync(rpc.close),
            );
            if (current.kind === 'agent') {
              const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
              yield* reconcileCurrentAgentProfiles(client, {
                catalog,
                companies: current.agentProfiles,
                installedModuleKeys: new Set(current.installedModules.map(({ moduleKey }) => moduleKey)),
                principalId,
                tenantId,
              });
            }
            yield* client
              .writeRelationships(
                v1.WriteRelationshipsRequest.create({
                  updates: [
                    ...buildPrincipalSelfCredentialUpdates({
                      kind: current.kind,
                      principalId,
                      status: current.status,
                      tenantActive: current.tenantStatus === 'active',
                      tenantId,
                    }),
                    ...current.membershipUpdates,
                    buildCompanyTenantAdmissionUpdate({
                      membershipUpdates: current.membershipUpdates,
                      principalId,
                      tenantId,
                    }),
                  ],
                }),
              )
              .pipe(Effect.asVoid);
            if (current.operators !== null) {
              yield* reconcileCurrentAgentOperators(client, {
                ...current.operators,
                principalId,
                status: current.status,
                tenantActive: current.tenantStatus === 'active',
                tenantId,
              });
            }
            return yield* roleLifecycle.reconcilePrincipal(tenantId, principalId, compositionRevision);
          }),
        ).pipe(Effect.mapError(failed));
      }),
      reconcileScopedRoleMembership: roleLifecycle.reconcile,
      reconcileTenant: Effect.fn('ActionAuthorizationLifecycle.reconcileTenant')(function* reconcileTenant(
        tenantId: string,
        compositionRevision: string,
      ) {
        return yield* withPostgresSessionAdvisoryLock(
          Redacted.make(configuration.connectionString),
          `ontos.action-authorization:${tenantId}`,
          Effect.gen(function* reconcileSerializedTenant() {
            // Every retry loads the latest authority AFTER serialization. No event payload
            // or earlier job's snapshot can overwrite a newer reconciler's graph state.
            const snapshot = yield* authority.load.pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
            if (snapshot.composition.revision !== compositionRevision) {
              return yield* failed();
            }
            const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
            const actions: ActionAuthorizationProvisioningAction[] = [];
            for (const { manifest } of catalog.contracts) {
              for (const action of manifest.publicSurface.actions) {
                if (action.entrypoint.authorization.kind !== 'action_execution') {
                  return yield* failed();
                }
                actions.push({
                  actionKey: action.actionKey,
                  legalEntityScope: action.legalEntityScope,
                  owningModuleKey: action.owningModuleId,
                  provisioning: action.entrypoint.authorization.provisioning,
                });
              }
            }
            for (const action of coreActionCatalog) {
              if (action.entrypoint.authorization.kind !== 'action_execution') {
                return yield* failed();
              }
              actions.push({
                actionKey: action.actionKey,
                legalEntityScope: action.legalEntityScope,
                owningModuleKey: action.owningModuleKey,
                provisioning: action.entrypoint.authorization.provisioning,
              });
            }
            const installation = yield* database.executor.transaction(
              Effect.fn(function* readLatestInstallation(transaction) {
                yield* lockApplicationCompositionAuthority(transaction, compositionRevision, 'worker');
                const [tenant] = yield* transaction
                  .select({ status: tenants.status })
                  .from(tenants)
                  .where(eq(tenants.tenantId, tenantId));
                if (tenant === undefined) {
                  return yield* failed();
                }
                // A transaction uses one physical connection; keep its reads serialized.
                const [companies, tenantModules] = yield* Effect.all(
                  [
                    transaction
                      .select({ legalEntityId: legalEntities.legalEntityId, status: legalEntities.status })
                      .from(legalEntities)
                      .where(eq(legalEntities.tenantId, tenantId)),
                    transaction
                      .select({ moduleKey: tenantModuleStates.moduleKey, state: tenantModuleStates.state })
                      .from(tenantModuleStates)
                      .where(eq(tenantModuleStates.tenantId, tenantId)),
                  ],
                  { concurrency: 1 },
                );
                return deriveActionAuthorizationInstalledScopes({
                  companies,
                  coreModuleKeys,
                  publishedModuleKeys: catalog.moduleIds,
                  tenantActive: tenant.status === 'active',
                  tenantId,
                  tenantModules,
                });
              }),
            );
            // The DB transaction has ended before any SpiceDB I/O begins.
            const client = yield* Effect.acquireRelease(
              Effect.try({ catch: failed, try: () => openSpiceDbRpc(spiceConfiguration, 5000) }),
              (rpc) => Effect.sync(rpc.close),
            );
            return yield* reconcileScopedActionAuthorization(client, { actions, installedModuleScopes: installation });
          }),
        ).pipe(Effect.mapError(failed));
      }),
    };
  }),
);
