import { v1 } from '@authzed/authzed-node';
import { and, eq, or } from 'drizzle-orm';

import { legalEntities, principalAuthBindings, principals } from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';
import {
  ActionAuthorizationProvisioningError,
  buildActionAuthorizationRelationships,
  buildActionAuthorizationRoleGrantRelationships,
  deriveScopedActionAuthorization,
} from './action-authorization-provisioning.ts';
import type { ActionAuthorizationProvisioningAction } from './action-authorization-provisioning.ts';
import type { ScopedRoleIdentity } from '../permissions/scoped-role.ts';

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
