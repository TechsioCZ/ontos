import { v1 } from '@authzed/authzed-node';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import {
  emailDeliveries,
  legalEntities,
  personInvitations,
  principalCompanyMemberships,
  principals,
  tenants,
} from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { invitationDeliveryFromLedger, PersonInvitationDeliverySchema } from './person-invitation.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import {
  ScopedRoleMembershipRoleSchema,
  ScopedRoleScopeSchema,
} from '../outbox/core-identity-scoped-role-membership-changed-v1.ts';
import { fullyConsistent } from '../permissions/client.ts';
import { CompanyMembershipSchema, buildCompanyMembershipUpdates } from '../permissions/company-membership.ts';
import { toLegalEntityAccessObjectId } from '../permissions/context-access.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import { PrincipalRefSchema } from '../permissions/principal-ref.ts';
import { fromScopedRoleObjectId } from '../permissions/scoped-role.ts';
import { openSpiceDbRpc } from '../permissions/spicedb-transaction-guard.ts';
import type { SpiceDbRpc } from '../permissions/spicedb-rpc.ts';
import type { ReadFinishContext, ReadLoadContext } from '../reads/context.ts';
import { defineRead } from '../reads/definition.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';

export const PeopleDirectoryInputSchema = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 })),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** This read covers the trusted selected scope, never an implicit all-company membership view. */
export const PeopleDirectoryResultSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      displayName: Schema.String,
      invitationDelivery: Schema.OptionFromNullOr(PersonInvitationDeliverySchema),
      kind: Schema.Literals(['human', 'agent']),
      principalRef: PrincipalRefSchema,
      principalStatus: Schema.Literals(['active', 'disabled', 'archived']),
      roleAssignments: Schema.Array(ScopedRoleMembershipRoleSchema),
      selectedCompanyMembership: Schema.OptionFromNullOr(CompanyMembershipSchema),
      selectedCompanyMembershipProjection: Schema.OptionFromNullOr(
        Schema.Struct({
          expectedMember: Schema.Boolean,
          observedMember: Schema.Boolean,
        }),
      ),
    }),
  ),
  nextOffset: Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  scope: ScopedRoleScopeSchema,
  tenantId: PrincipalRefSchema.fields.tenantId,
});

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'People and their exact scoped role assignments are temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

const peopleDirectoryServices = (transaction: ScopedTransactionExecutor) => ({
  list: Effect.fn('PeopleDirectory.list')(function* list(input: typeof PeopleDirectoryInputSchema.Type) {
    const { legalEntityId, tenantId } = transaction.scope;
    const rows = yield* transaction
      .select({
        affiliation: principalCompanyMemberships.affiliation,
        companyId: principalCompanyMemberships.legalEntityId,
        companyStatus: legalEntities.status,
        displayName: principals.displayName,
        invitationErrorTag: emailDeliveries.errorTag,
        invitationExpired: sql<boolean | null>`${personInvitations.expiresAt} <= now()`,
        invitationId: personInvitations.invitationId,
        invitationStatus: emailDeliveries.status,
        kind: principals.kind,
        membershipRevision: principalCompanyMemberships.revision,
        membershipStatus: principalCompanyMemberships.status,
        principalId: principals.principalId,
        principalStatus: principals.status,
        tenantStatus: tenants.status,
      })
      .from(principals)
      .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
      .leftJoin(
        principalCompanyMemberships,
        and(
          eq(principalCompanyMemberships.tenantId, principals.tenantId),
          eq(principalCompanyMemberships.principalId, principals.principalId),
          legalEntityId === undefined ? sql`false` : eq(principalCompanyMemberships.legalEntityId, legalEntityId),
        ),
      )
      .leftJoin(
        legalEntities,
        and(
          eq(legalEntities.tenantId, principalCompanyMemberships.tenantId),
          eq(legalEntities.legalEntityId, principalCompanyMemberships.legalEntityId),
        ),
      )
      .leftJoin(
        personInvitations,
        and(
          eq(personInvitations.tenantId, principals.tenantId),
          eq(personInvitations.principalId, principals.principalId),
          legalEntityId === undefined ? sql`false` : eq(personInvitations.legalEntityId, legalEntityId),
        ),
      )
      .leftJoin(
        emailDeliveries,
        and(
          eq(emailDeliveries.tenantId, personInvitations.tenantId),
          eq(emailDeliveries.legalEntityId, personInvitations.legalEntityId),
          eq(emailDeliveries.source, 'person-invitation'),
          eq(emailDeliveries.subjectId, sql`${personInvitations.invitationId}::text`),
          eq(emailDeliveries.dedupeKey, sql`'person-invitation:' || ${personInvitations.invitationId}::text`),
        ),
      )
      .where(
        and(
          eq(principals.tenantId, tenantId),
          or(eq(principals.kind, 'human'), eq(principals.kind, 'agent')),
          legalEntityId === undefined ? undefined : eq(principalCompanyMemberships.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(asc(principals.displayName), asc(principals.principalId))
      .limit(input.limit + 1)
      .offset(input.offset)
      .pipe(Effect.mapError(unavailable));
    return {
      nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
      rows: rows.slice(0, input.limit),
    };
  }),
});
type PeopleServices = ReturnType<typeof peopleDirectoryServices>;
type LoadedPeople = Effect.Success<ReturnType<PeopleServices['list']>>;

const rolesOf = Effect.fn('PeopleDirectory.rolesOf')(function* rolesOf(
  client: SpiceDbRpc,
  input: { readonly legalEntityId?: string; readonly principalId: string; readonly tenantId: string },
) {
  const relationships = yield* client.readRelationships(
    v1.ReadRelationshipsRequest.create({
      consistency: fullyConsistent,
      relationshipFilter: {
        optionalRelation: 'member',
        optionalSubjectFilter: { optionalSubjectId: input.principalId, subjectType: 'principal' },
        resourceType: 'scoped_role',
      },
    }),
  );
  const roles = yield* Effect.forEach(
    relationships,
    Effect.fn(function* readRole(response: v1.ReadRelationshipsResponse) {
      const edge = response.relationship;
      if (
        edge?.resource?.objectType !== 'scoped_role' ||
        edge.relation !== 'member' ||
        edge.subject?.object?.objectType !== 'principal' ||
        edge.subject.object.objectId !== input.principalId ||
        edge.subject.optionalRelation !== ''
      ) {
        return yield* unavailable('Unexpected role relationship');
      }
      const role = fromScopedRoleObjectId(edge.resource.objectId);
      if (Option.isNone(role) || role.value.tenantId !== input.tenantId) {
        return yield* unavailable('Role relationship has a malformed or foreign-tenant identity');
      }
      if (role.value.legalEntityId !== input.legalEntityId) {
        return [];
      }
      const decoded = yield* Schema.decodeEffect(ScopedRoleMembershipRoleSchema)({
        roleKey: role.value.roleKey,
        scope:
          role.value.legalEntityId === undefined
            ? { _tag: 'tenant' }
            : { _tag: 'company', legalEntityId: role.value.legalEntityId },
        tenantId: role.value.tenantId,
      });
      return [decoded];
    }),
    { concurrency: 1 },
  );
  return roles.flat().toSorted((left, right) => left.roleKey.localeCompare(right.roleKey));
});

const membershipProjection = Effect.fn('PeopleDirectory.membershipProjection')(function* membershipProjection(
  client: SpiceDbRpc,
  row: LoadedPeople['rows'][number],
  tenantId: string,
) {
  if (row.companyId === null) {
    return null;
  }
  if (row.membershipStatus === null || row.companyStatus === null) {
    return yield* unavailable('Selected membership has no exact company owner state');
  }
  const companyObjectId = toLegalEntityAccessObjectId(tenantId, row.companyId);
  if (companyObjectId === undefined) {
    return yield* unavailable('Selected company identity is invalid');
  }
  const relationships = yield* client.readRelationships(
    v1.ReadRelationshipsRequest.create({
      consistency: fullyConsistent,
      relationshipFilter: {
        optionalRelation: 'member',
        optionalResourceId: companyObjectId,
        optionalSubjectFilter: { optionalSubjectId: row.principalId, subjectType: 'principal' },
        resourceType: 'legal_entity',
      },
    }),
  );
  if (
    relationships.length > 1 ||
    relationships.some(
      ({ relationship: edge }) =>
        edge?.resource?.objectType !== 'legal_entity' ||
        edge.resource.objectId !== companyObjectId ||
        edge.relation !== 'member' ||
        edge.subject?.object?.objectType !== 'principal' ||
        edge.subject.object.objectId !== row.principalId ||
        edge.subject.optionalRelation !== '',
    )
  ) {
    return yield* unavailable('Selected company membership graph evidence is ambiguous');
  }
  const [expectedUpdate] = buildCompanyMembershipUpdates({
    affiliation: row.affiliation,
    companyActive: row.companyStatus === 'active',
    kind: row.kind,
    legalEntityId: row.companyId,
    principalId: row.principalId,
    principalStatus: row.principalStatus,
    status: row.membershipStatus,
    tenantActive: row.tenantStatus === 'active',
    tenantId,
  });
  return {
    expectedMember: expectedUpdate?.operation === v1.RelationshipUpdate_Operation.TOUCH,
    observedMember: relationships.length === 1,
  };
});

const load = (input: typeof PeopleDirectoryInputSchema.Type, context: ReadLoadContext<PeopleServices>) =>
  context.services.list(input);
const finish = Effect.fn('PeopleDirectory.finish')(function* finish(
  _input: typeof PeopleDirectoryInputSchema.Type,
  context: ReadFinishContext<undefined, LoadedPeople>,
) {
  return yield* Effect.scoped(
    Effect.gen(function* finishOutsideSqlTransaction() {
      const configuration = yield* loadSpiceDbConfig();
      const client = yield* Effect.acquireRelease(
        Effect.try({ catch: unavailable, try: () => openSpiceDbRpc(configuration, 5000) }),
        (rpc) => Effect.sync(rpc.close),
      );
      const { legalEntityId, tenantId } = context.scope;
      const items = yield* Effect.forEach(
        context.loaded.rows,
        Effect.fn(function* enrichPerson(row: LoadedPeople['rows'][number]) {
          const principalRef = { principalId: row.principalId, tenantId };
          const identity = legalEntityId === undefined ? principalRef : { ...principalRef, legalEntityId };
          const [roleAssignments, selectedCompanyMembershipProjection] = yield* Effect.all(
            [rolesOf(client, identity), membershipProjection(client, row, tenantId)],
            { concurrency: 2 },
          );
          return {
            displayName: row.displayName,
            invitationDelivery:
              row.invitationId === null
                ? null
                : invitationDeliveryFromLedger({
                    errorTag: row.invitationErrorTag,
                    expired: row.invitationExpired,
                    status: row.invitationStatus,
                  }),
            kind: row.kind,
            principalRef,
            principalStatus: row.principalStatus,
            roleAssignments,
            selectedCompanyMembership:
              row.companyId === null
                ? null
                : {
                    affiliation: row.affiliation,
                    legalEntityId: row.companyId,
                    principalRef,
                    revision: row.membershipRevision,
                    status: row.membershipStatus,
                  },
            selectedCompanyMembershipProjection,
          };
        }),
        { concurrency: 4 },
      );
      const result = yield* Schema.decodeUnknownEffect(PeopleDirectoryResultSchema)({
        items,
        nextOffset: context.loaded.nextOffset,
        scope: legalEntityId === undefined ? { _tag: 'tenant' } : { _tag: 'company', legalEntityId },
        tenantId,
      });
      return { evidence: { resultCount: result.items.length }, result };
    }),
  ).pipe(Effect.mapError(unavailable));
});

export const peopleDirectoryRead = defineRead(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'core.identity.people-directory',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.identity.people-directory.access.v1' },
    inputSchema: PeopleDirectoryInputSchema,
    legalEntityScope: 'optional',
    owningModuleKey: 'core.identity',
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.people-directory',
    resultSchema: PeopleDirectoryResultSchema,
    schemaVersion: '1',
  },
  { finish, load },
  (transaction) => Effect.succeed(peopleDirectoryServices(transaction)),
  (_input, scope) =>
    scope.legalEntityId === undefined
      ? { kind: 'tenant', permission: 'read_people' }
      : {
          kind: 'any_of',
          targets: [
            { kind: 'tenant', permission: 'read_people' },
            { kind: 'legal_entity', legalEntityId: scope.legalEntityId, permission: 'read_people' },
          ],
        },
);
