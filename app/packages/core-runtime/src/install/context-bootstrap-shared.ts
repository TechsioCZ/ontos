import { v1 } from '@authzed/authzed-node';
import { and, eq, or } from 'drizzle-orm';

import {
  legalEntities,
  principalAuthBindings,
  principals,
} from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';

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

export const selectBootstrapLegalEntities = (
  transaction: CoreTransaction,
  context: BootstrapIdentity
) =>
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
          eq(legalEntities.registrationNumber, context.registrationNumber)
        )
      )
    )
    .limit(2);

export const selectBootstrapPrincipals = (
  transaction: CoreTransaction,
  context: BootstrapIdentity
) =>
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
  authUserId: string
) =>
  transaction
    .select({
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
      or(
        eq(principalAuthBindings.principalAuthBindingId, context.authBindingId),
        and(
          eq(principalAuthBindings.tenantId, context.tenantId),
          eq(principalAuthBindings.provider, 'better_auth'),
          eq(principalAuthBindings.subjectType, 'user'),
          eq(principalAuthBindings.providerSubjectId, authUserId)
        )
      )
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

interface BootstrapRelationship {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly subjectId: string;
  readonly subjectType: string;
}

export const bootstrapRelationshipRequest = (
  relationships: readonly BootstrapRelationship[]
) =>
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
          }),
        }),
      })
    ),
  });
