import { v1 } from '@authzed/authzed-node';
import { and, eq, or } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import { CompanyAffiliationSchema, isCompanyAffiliationValid } from '../permissions/company-membership.ts';

import {
  legalEntities,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenants,
} from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';
import {
  ActionAuthorizationProvisioningError,
  buildActionAuthorizationRelationships,
  buildActionAuthorizationRoleGrantRelationships,
  deriveScopedActionAuthorization,
} from './action-authorization-provisioning.ts';
import type { ActionAuthorizationProvisioningAction } from './action-authorization-provisioning.ts';
import type { ScopedRoleIdentity } from '../permissions/scoped-role.ts';

/** Explicit seed selection only. Account creation and role grants never imply a membership. */
export const BootstrapCompanyMembershipSchema = Schema.Struct({
  affiliation: Schema.OptionFromNullOr(CompanyAffiliationSchema),
  legalEntityId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('BootstrapCompanyMembershipLegalEntityId')),
  principalId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('BootstrapCompanyMembershipPrincipalId')),
});

export class BootstrapCompanyMembershipConflict extends Schema.TaggedError<BootstrapCompanyMembershipConflict>()(
  'BootstrapCompanyMembershipConflict',
  { reason: Schema.String },
) {}

/** Initial development fixtures are insert-only; a rerun may never reactivate or reclassify an actor. */
export const installBootstrapCompanyMemberships = Effect.fn('DevelopmentBootstrap.explicitCompanyMemberships')(
  function* installMemberships(
    transaction: CoreTransaction,
    tenantId: string,
    memberships: readonly (typeof BootstrapCompanyMembershipSchema.Type)[],
  ) {
    const keys = memberships.map((member) => `${member.principalId}:${member.legalEntityId}`);
    if (new Set(keys).size !== keys.length) {
      return yield* new BootstrapCompanyMembershipConflict({
        reason: 'Development membership selections must be unique',
      });
    }
    return yield* Effect.forEach(
      memberships,
      Effect.fn('DevelopmentBootstrap.installMembership')(function* installMembership(membership) {
        const affiliation = Option.getOrNull(membership.affiliation);
        const [target] = yield* transaction
          .select({
            companyStatus: legalEntities.status,
            kind: principals.kind,
            principalStatus: principals.status,
            tenantStatus: tenants.status,
          })
          .from(principals)
          .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
          .innerJoin(
            legalEntities,
            and(
              eq(legalEntities.tenantId, principals.tenantId),
              eq(legalEntities.legalEntityId, membership.legalEntityId),
            ),
          )
          .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, membership.principalId)));
        if (
          target === undefined ||
          target.tenantStatus !== 'active' ||
          target.companyStatus !== 'active' ||
          target.principalStatus !== 'active' ||
          !isCompanyAffiliationValid(target.kind, affiliation)
        ) {
          return yield* new BootstrapCompanyMembershipConflict({
            reason:
              'Development membership requires an existing active tenant-local company actor and explicit valid affiliation',
          });
        }
        const identity = { legalEntityId: membership.legalEntityId, principalId: membership.principalId, tenantId };
        yield* transaction
          .insert(principalCompanyMemberships)
          .values({ ...identity, affiliation, status: 'active' })
          .onConflictDoNothing();
        const [current] = yield* transaction
          .select({ affiliation: principalCompanyMemberships.affiliation, status: principalCompanyMemberships.status })
          .from(principalCompanyMemberships)
          .where(
            and(
              eq(principalCompanyMemberships.tenantId, tenantId),
              eq(principalCompanyMemberships.legalEntityId, membership.legalEntityId),
              eq(principalCompanyMemberships.principalId, membership.principalId),
            ),
          );
        if (current === undefined || current.status !== 'active' || current.affiliation !== affiliation) {
          return yield* new BootstrapCompanyMembershipConflict({
            reason:
              'Existing company membership differs from the initial fixture; use the governed membership Action instead',
          });
        }
        return yield* Effect.void;
      }),
      { concurrency: 1, discard: true },
    );
  },
);

interface BootstrapIdentity {
  readonly authBindingId: string;
  readonly legalEntityId: string;
  readonly legalName: string;
  readonly principalDisplayName: string;
  readonly principalId: string;
  readonly registrationCountry: string;
  readonly registrationNumber: string;
  readonly tenantId: string;
}

export const selectBootstrapLegalEntities = (transaction: CoreTransaction, context: BootstrapIdentity) =>
  transaction
    .select({
      legalEntityId: legalEntities.legalEntityId,
      legalName: legalEntities.legalName,
      registrationCountry: legalEntities.registrationCountry,
      registrationNumber: legalEntities.registrationNumber,
      status: legalEntities.status,
      tenantId: legalEntities.tenantId,
    })
    .from(legalEntities)
    .where(
      or(
        eq(legalEntities.legalEntityId, context.legalEntityId),
        and(
          eq(legalEntities.tenantId, context.tenantId),
          eq(legalEntities.registrationCountry, context.registrationCountry),
          eq(legalEntities.registrationNumber, context.registrationNumber),
        ),
      ),
    )
    .limit(2);

export const selectBootstrapPrincipals = (transaction: CoreTransaction, context: BootstrapIdentity) =>
  transaction
    .select({
      displayName: principals.displayName,
      kind: principals.kind,
      principalId: principals.principalId,
      status: principals.status,
      tenantId: principals.tenantId,
    })
    .from(principals)
    .where(eq(principals.principalId, context.principalId))
    .limit(1);

export const selectBootstrapAuthBindings = (
  transaction: CoreTransaction,
  context: BootstrapIdentity,
  authUserId: string,
  authenticationNamespaceId: string,
) =>
  transaction
    .select({
      authenticationNamespaceId: principalAuthBindings.authenticationNamespaceId,
      principalAuthBindingId: principalAuthBindings.principalAuthBindingId,
      principalId: principalAuthBindings.principalId,
      provider: principalAuthBindings.provider,
      providerSubjectId: principalAuthBindings.providerSubjectId,
      status: principalAuthBindings.status,
      subjectType: principalAuthBindings.subjectType,
      tenantId: principalAuthBindings.tenantId,
    })
    .from(principalAuthBindings)
    .where(
      and(
        eq(principalAuthBindings.authenticationNamespaceId, authenticationNamespaceId),
        or(
          eq(principalAuthBindings.principalAuthBindingId, context.authBindingId),
          and(
            eq(principalAuthBindings.tenantId, context.tenantId),
            eq(principalAuthBindings.provider, 'better_auth'),
            eq(principalAuthBindings.subjectType, 'user'),
            eq(principalAuthBindings.providerSubjectId, authUserId),
          ),
        ),
      ),
    )
    .limit(2);

export const bootstrapPrincipalRecord = (context: BootstrapIdentity) =>
  ({
    displayName: context.principalDisplayName,
    kind: 'human',
    principalId: context.principalId,
    status: 'active',
    tenantId: context.tenantId,
  }) as const;

export interface BootstrapRelationship {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly subjectId: string;
  readonly subjectRelation?: string;
  readonly subjectType: string;
}

/** Exact wire projection, including usersets; conditional evidence must never be silently weakened. */
export const bootstrapRelationshipsFromNative = (
  relationships: readonly v1.Relationship[],
): readonly BootstrapRelationship[] =>
  relationships.map((item) => {
    if (
      item.resource === undefined ||
      item.subject?.object === undefined ||
      item.optionalCaveat !== undefined ||
      item.optionalExpiresAt !== undefined
    ) {
      throw new ActionAuthorizationProvisioningError({
        code: 'action_authorization_input_invalid',
        reason: 'Bootstrap relationships require complete unconditional native authorization evidence',
      });
    }
    return {
      relation: item.relation,
      resourceId: item.resource.objectId,
      resourceType: item.resource.objectType,
      subjectId: item.subject.object.objectId,
      subjectRelation: item.subject.optionalRelation,
      subjectType: item.subject.object.objectType,
    };
  });

/** Explicit role policy in exactly one valid descriptor scope; never creates membership or guesses ownership. */
export const scopedActionRoleBootstrapRelationships = (
  input: ScopedRoleIdentity & {
    readonly action: ActionAuthorizationProvisioningAction;
  },
): readonly BootstrapRelationship[] => {
  const { action, ...scope } = input;
  const installed = [{ ...scope, moduleKeys: [action.owningModuleKey] }];
  const actions = deriveScopedActionAuthorization([action], installed);
  if (actions.length !== 1) {
    throw new ActionAuthorizationProvisioningError({
      code: 'action_authorization_input_invalid',
      reason: 'The selected bootstrap Action does not exist in the explicit role scope',
    });
  }
  return bootstrapRelationshipsFromNative([
    ...buildActionAuthorizationRelationships(actions),
    ...buildActionAuthorizationRoleGrantRelationships(
      actions.map((item) => ({ ...item, roleKey: scope.roleKey })),
      installed,
    ),
  ]);
};

export const bootstrapRelationshipRequest = (relationships: readonly BootstrapRelationship[]) =>
  v1.WriteRelationshipsRequest.create({
    updates: relationships.map((item) =>
      v1.RelationshipUpdate.create({
        operation: v1.RelationshipUpdate_Operation.TOUCH,
        relationship: v1.Relationship.create({
          relation: item.relation,
          resource: v1.ObjectReference.create({
            objectId: item.resourceId,
            objectType: item.resourceType,
          }),
          subject: v1.SubjectReference.create({
            object: v1.ObjectReference.create({
              objectId: item.subjectId,
              objectType: item.subjectType,
            }),
            optionalRelation: item.subjectRelation ?? '',
          }),
        }),
      }),
    ),
  });
