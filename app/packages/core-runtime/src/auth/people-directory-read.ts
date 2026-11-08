import { and, asc, eq, or, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import {
  emailDeliveries,
  legalEntities,
  personInvitations,
  principalCompanyMemberships,
  principals,
  tenants,
} from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import { CompanyMembershipSchema } from '../permissions/company-membership.ts';
import { PrincipalRefSchema } from '../permissions/principal-ref.ts';
import type { ReadFinishContext, ReadLoadContext } from '../reads/context.ts';
import { defineRead } from '../reads/definition.ts';
import { ReadHandlerUnavailable } from '../reads/errors.ts';
import { invitationDeliveryFromLedger, PersonInvitationDeliverySchema } from './person-invitation.ts';

/*
 * The organisation half of the people directory: who belongs to the selected company (or to the tenant),
 * the affiliation and membership status an administrator recorded, and the state of their invitation.
 *
 * It is deliberately NOT the role authority. A person's roles and role assignments are access intent, so
 * they are read from the canonical access administration (`api/access-admin/people.ts` over
 * `AccessPeopleCommands`) and never from a graph relationship of this read. This read therefore reports no
 * role assignment and no membership projection: a role label or a membership projection derived from the
 * old `scoped_role` graph would be a second, trailing answer to a question the canonical intent already
 * owns.
 *
 * A platform-operated login (a warm-up reader, a service account) is excluded by its own principal kind,
 * not by the role key it happens to hold: only `human` and `agent` principals are listed.
 */

export const PeopleDirectoryInputSchema = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 })),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** The exact scope this directory answers for: the tenant context, or exactly one company. */
export const PeopleDirectoryScopeSchema = Schema.Union([
  Schema.TaggedStruct('tenant', {}),
  Schema.TaggedStruct('company', { legalEntityId: CompanyMembershipSchema.fields.legalEntityId }),
]);

/** This read covers the trusted selected scope, never an implicit all-company membership view. */
export const PeopleDirectoryResultSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      displayName: Schema.String,
      invitationDelivery: Schema.OptionFromNullOr(PersonInvitationDeliverySchema),
      kind: Schema.Literals(['human', 'agent']),
      principalRef: PrincipalRefSchema,
      principalStatus: Schema.Literals(['active', 'disabled', 'archived']),
      selectedCompanyMembership: Schema.OptionFromNullOr(CompanyMembershipSchema),
    }),
  ),
  nextOffset: Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  scope: PeopleDirectoryScopeSchema,
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

const load = (input: typeof PeopleDirectoryInputSchema.Type, context: ReadLoadContext<PeopleServices>) =>
  context.services.list(input);
const finish = Effect.fn('PeopleDirectory.finish')(function* finishDirectory(
  _input: typeof PeopleDirectoryInputSchema.Type,
  context: ReadFinishContext<undefined, LoadedPeople>,
) {
  const { legalEntityId, tenantId } = context.scope;
  const items = context.loaded.rows.map((row) => {
    const principalRef = { principalId: row.principalId, tenantId };
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
    };
  });
  const result = yield* Schema.decodeUnknownEffect(PeopleDirectoryResultSchema)({
    items,
    nextOffset: context.loaded.nextOffset,
    scope: legalEntityId === undefined ? { _tag: 'tenant' } : { _tag: 'company', legalEntityId },
    tenantId,
  }).pipe(Effect.mapError(unavailable));
  return { evidence: { resultCount: result.items.length }, result };
});

export const peopleDirectoryRead = defineRead(
  {
    // The tenant/company people directory is a governed read (O62, O72): the access gate decides it, and
    // its rows are the scope's own (the owner already filters by tenant and selected company).
    accessDeclaration: {
      key: 'core.identity.people-directory.list',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'identity', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'core.identity.people-directory',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.identity.people-directory.access.v1' },
    inputSchema: PeopleDirectoryInputSchema,
    legalEntityScope: 'optional',
    owningModuleKey: 'core.identity',
    policies: [],
    readKey: 'core.identity.people-directory',
    resultSchema: PeopleDirectoryResultSchema,
    schemaVersion: '1',
  },
  { finish, load },
  (transaction) => Effect.succeed(peopleDirectoryServices(transaction)),
);
