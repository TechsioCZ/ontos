import { v1 } from '@authzed/authzed-node';
import { and, eq, sql } from 'drizzle-orm';
import { Context, Effect, Layer, Redacted } from 'effect';
import type { Reactivity } from 'effect/unstable/reactivity';

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
import { lockApplicationCompositionAuthority } from '../modules/application-composition-authority.ts';
import { buildApplicationCompositionCatalog } from '../modules/application-composition-catalog.ts';
import { buildCompanyMembershipUpdates } from './company-membership.ts';
import { loadSpiceDbConfig } from './config.ts';
import { openSpiceDbRpc } from './spicedb-transaction-guard.ts';
import { ScopedRoleMembershipLifecycle } from './scoped-role-membership-lifecycle.ts';
import type { ScopedRoleIdentity } from './scoped-role.ts';

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
      return membership === undefined
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
    }),
    { concurrency: 1 },
  );
  return membershipUpdates.flat();
});

export class ActionAuthorizationLifecycle extends Context.Service<
  ActionAuthorizationLifecycle,
  {
    readonly reconcilePrincipal: (
      tenantId: string,
      principalId: string,
      compositionRevision: string,
    ) => Effect.Effect<void, ActionAuthorizationLifecycleError, Reactivity.Reactivity>;
    readonly reconcileScopedRoleMembership: (
      role: ScopedRoleIdentity,
      principalId: string,
      compositionRevision: string,
    ) => Effect.Effect<void, ActionAuthorizationLifecycleError, Reactivity.Reactivity>;
    readonly reconcileTenant: (
      tenantId: string,
      compositionRevision: string,
    ) => Effect.Effect<void, ActionAuthorizationLifecycleError, Reactivity.Reactivity>;
  }
>()('@app/core-runtime/permissions/ActionAuthorizationLifecycle') {}

export const ActionAuthorizationLifecycleLive = Layer.effect(
  ActionAuthorizationLifecycle,
  Effect.gen(function* makeActionAuthorizationLifecycle() {
    const database = yield* CoreDatabase;
    const configuration = yield* DatabaseConfig;
    const authority = yield* ActiveApplicationCompositionService;
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
            const spiceConfiguration = yield* loadSpiceDbConfig();
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
                const membershipUpdates = yield* readCurrentCompanyMembershipUpdates(
                  transaction,
                  principal,
                  tenantId,
                  principalId,
                );
                return { ...principal, membershipUpdates };
              }),
            );
            // The SQL fence ended. An old delivery always applies the current row, never old event authority.
            const client = yield* Effect.acquireRelease(
              Effect.try({ catch: failed, try: () => openSpiceDbRpc(spiceConfiguration, 5000) }),
              (rpc) => Effect.sync(rpc.close),
            );
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
                  ],
                }),
              )
              .pipe(Effect.asVoid);
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
            const spiceConfiguration = yield* loadSpiceDbConfig();
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
