/**
 * Sales-demo account administration: SpiceDB side. Roles are predefined per company and each role is backed by
 * an existing template persona (the accounts `scripts/demo/reset-permissions.mts` grants). Assigning a role
 * copies the template's company-scoped grants (company membership, module access, context permissions), its
 * tenant relations and its Action executor grants to the target principal, i.e. the same relationships the
 * demo permission scripts write, without re-implementing the role matrix.
 */
import { v1 } from '@authzed/authzed-node';
import { openSpiceDbRpc } from '../permissions/spicedb-transaction-guard.ts';
import { Effect, Option, Schema } from 'effect';
import { fromScopedRoleObjectId } from '../permissions/scoped-role.ts';

import { IdentityPersistenceUnavailableError } from '../auth/principal-management-errors.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import { toLegalEntityAccessObjectId } from '../permissions/context-access.ts';
import type { SpiceDbRpc } from '../permissions/spicedb-rpc.ts';
import { replaceAgentScopedRolePolicy } from './agent-scoped-role-policy.ts';

export interface DemoAccountRelationship {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

/** Relationship types that carry a role. Resource-level grants (assigned clients, ...) are never copied. */
const roleResourceTypes = ['tenant', 'legal_entity', 'module_access', 'context_permission', 'action'] as const;
const companyScopedTypes: ReadonlySet<string> = new Set(['legal_entity', 'module_access', 'context_permission']);

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'Authorization grants are temporarily unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );

const ObjectIdParts = Schema.fromJsonString(Schema.Array(Schema.String));
/** Context-access object IDs are `ctx_` + base64url(JSON array of parts); hashed IDs decode to nothing. */
export const demoAccountObjectIdParts = (objectId: string): readonly string[] => {
  if (!objectId.startsWith('ctx_')) {
    return [];
  }
  const decoded = Schema.decodeOption(ObjectIdParts)(
    Buffer.from(objectId.slice('ctx_'.length), 'base64url').toString('utf-8'),
  );
  return Option.getOrElse(decoded, () => []);
};

const belongsToCompany = (relationship: DemoAccountRelationship, legalEntityId: string) =>
  demoAccountObjectIdParts(relationship.resourceId).includes(legalEntityId);

const principalSubject = (principalId: string) =>
  v1.SubjectReference.create({ object: v1.ObjectReference.create({ objectId: principalId, objectType: 'principal' }) });

const update = (
  operation: v1.RelationshipUpdate_Operation,
  principalId: string,
  relationship: DemoAccountRelationship,
) =>
  v1.RelationshipUpdate.create({
    operation,
    relationship: v1.Relationship.create({
      relation: relationship.relation,
      resource: v1.ObjectReference.create({ objectId: relationship.resourceId, objectType: relationship.resourceType }),
      subject: principalSubject(principalId),
    }),
  });

const fullyConsistent = v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });

const relationshipsOf = (rpc: SpiceDbRpc, principalId: string) =>
  Effect.forEach(
    roleResourceTypes,
    (resourceType) =>
      rpc
        .readRelationships(
          v1.ReadRelationshipsRequest.create({
            consistency: fullyConsistent,
            relationshipFilter: v1.RelationshipFilter.create({
              optionalSubjectFilter: v1.SubjectFilter.create({
                optionalSubjectId: principalId,
                subjectType: 'principal',
              }),
              resourceType,
            }),
          }),
        )
        .pipe(
          Effect.map((responses) =>
            responses.flatMap(({ relationship }) =>
              relationship?.resource === undefined
                ? []
                : [
                    {
                      relation: relationship.relation,
                      resourceId: relationship.resource.objectId,
                      resourceType: relationship.resource.objectType,
                    },
                  ],
            ),
          ),
        ),
    // Workers allow six concurrent outbound connections per request and callers fan out over several principals.
    { concurrency: 2 },
  ).pipe(
    Effect.map((groups) => groups.flat()),
    Effect.mapError(unavailable),
  );

/** Catalog evidence follows actual role memberships and retains native userset relation names. */
export const readScopedRoleTemplatePolicy = Effect.fn('DemoAccountGrants.readScopedRoleTemplatePolicy')(
  function* readScopedRoleTemplatePolicy(rpc: SpiceDbRpc, principalId: string) {
    const memberships = yield* rpc
      .readRelationships(
        v1.ReadRelationshipsRequest.create({
          consistency: fullyConsistent,
          relationshipFilter: {
            optionalRelation: 'member',
            optionalSubjectFilter: { optionalSubjectId: principalId, subjectType: 'principal' },
            resourceType: 'scoped_role',
          },
        }),
      )
      .pipe(Effect.mapError(unavailable));
    const roles = new Set<string>();
    for (const { relationship } of memberships) {
      if (
        relationship?.resource?.objectType !== 'scoped_role' ||
        Option.isNone(fromScopedRoleObjectId(relationship.resource.objectId)) ||
        relationship.relation !== 'member' ||
        relationship.subject?.object?.objectType !== 'principal' ||
        relationship.subject.object.objectId !== principalId ||
        relationship.subject.optionalRelation !== '' ||
        relationship.optionalCaveat !== undefined ||
        relationship.optionalExpiresAt !== undefined
      ) {
        return yield* unavailable('Role membership discovery returned incomplete or conditional evidence');
      }
      roles.add(relationship.resource.objectId);
    }
    const filters = [...roles].flatMap((roleId) =>
      ['tenant', 'legal_entity', 'module_access', 'context_permission'].map((resourceType) => ({
        resourceType,
        roleId,
      })),
    );
    const groups = yield* Effect.forEach(
      filters,
      Effect.fn('DemoAccountGrants.readRolePolicy')(function* readPolicy({ resourceType, roleId }) {
        const responses = yield* rpc
          .readRelationships(
            v1.ReadRelationshipsRequest.create({
              consistency: fullyConsistent,
              relationshipFilter: {
                optionalSubjectFilter: {
                  optionalRelation: { relation: 'member' },
                  optionalSubjectId: roleId,
                  subjectType: 'scoped_role',
                },
                resourceType,
              },
            }),
          )
          .pipe(Effect.mapError(unavailable));
        return yield* Effect.forEach(
          responses,
          ({ relationship }) => {
            if (
              relationship?.resource?.objectType !== resourceType ||
              relationship.subject?.object?.objectType !== 'scoped_role' ||
              relationship.subject.object.objectId !== roleId ||
              relationship.subject.optionalRelation !== 'member' ||
              relationship.optionalCaveat !== undefined ||
              relationship.optionalExpiresAt !== undefined
            ) {
              return unavailable('Role policy discovery returned incomplete or conditional evidence');
            }
            return Effect.succeed({
              relation: relationship.relation,
              resourceId: relationship.resource.objectId,
              resourceType,
            });
          },
          { concurrency: 1 },
        );
      }),
      { concurrency: 2 },
    );
    const exact = new Map(
      groups.flat().map((item) => [`${item.resourceType}:${item.resourceId}:${item.relation}`, item]),
    );
    return [...exact.values()];
  },
);

const write = (
  rpc: SpiceDbRpc,
  operation: v1.RelationshipUpdate_Operation,
  principalId: string,
  relationships: readonly DemoAccountRelationship[],
) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(relationships.length / 100) }, (_, index) =>
      relationships.slice(index * 100, index * 100 + 100),
    ),
    (chunk) =>
      rpc.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: chunk.map((relationship) => update(operation, principalId, relationship)),
        }),
      ),
    { concurrency: 1, discard: true },
  ).pipe(Effect.mapError(unavailable));

export interface DemoAccountGrants {
  /**
   * Gives `principalId` the role of `templatePrincipalId` in `legalEntityId`. With `replace`, the target's
   * previous company-scoped grants are removed first; tenant and Action grants are removed only when the target
   * belongs to no other company (they are tenant-wide).
   */
  readonly assignRole: (input: {
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly replace: boolean;
    readonly templatePrincipalId: string;
  }) => Effect.Effect<{ readonly granted: number; readonly revoked: number }, IdentityPersistenceUnavailableError>;
  /** Legal entities the principal is a member of (decoded from its `legal_entity#member` grants). */
  readonly companiesOf: (principalId: string) => Effect.Effect<readonly string[], IdentityPersistenceUnavailableError>;
  /** Principals with `member` on the company. */
  readonly companyMembers: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly string[], IdentityPersistenceUnavailableError>;
  /** Role-carrying relationships whose subject is the principal (tenant, company, module, context permission, Action). */
  readonly relationshipsOf: (
    principalId: string,
  ) => Effect.Effect<readonly DemoAccountRelationship[], IdentityPersistenceUnavailableError>;
  /** Atomically replaces one company's explicit agent role, its policy and membership. */
  readonly replaceAgentGrants: (input: {
    readonly desired: readonly v1.Relationship[];
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<{ readonly granted: number; readonly revoked: number }, IdentityPersistenceUnavailableError>;
  /** Actual native userset policy reached through explicit role memberships, never synthetic principal grants. */
  readonly rolePolicyOf: (
    principalId: string,
  ) => Effect.Effect<readonly DemoAccountRelationship[], IdentityPersistenceUnavailableError>;
}

const membershipCompanies = (relationships: readonly DemoAccountRelationship[]) =>
  relationships.flatMap((relationship) =>
    relationship.resourceType === 'legal_entity' && relationship.relation === 'member'
      ? demoAccountObjectIdParts(relationship.resourceId).slice(1, 2)
      : [],
  );
const policyKey = (relationship: DemoAccountRelationship) =>
  `${relationship.resourceType}|${relationship.resourceId}|${relationship.relation}`;

const makeGrants = (rpc: SpiceDbRpc): DemoAccountGrants => ({
  assignRole: Effect.fn('DemoAccountGrants.assignRole')(function* assignRole(input) {
    const template = yield* relationshipsOf(rpc, input.templatePrincipalId);
    const desired = template.filter(
      (relationship) =>
        !companyScopedTypes.has(relationship.resourceType) || belongsToCompany(relationship, input.legalEntityId),
    );
    const current = yield* relationshipsOf(rpc, input.principalId);
    const desiredKeys = new Set(desired.map(policyKey));
    const otherCompanies = membershipCompanies(current).filter((company) => company !== input.legalEntityId);
    const revoke = input.replace
      ? current.filter((relationship) => {
          if (desiredKeys.has(policyKey(relationship))) {
            return false;
          }
          if (companyScopedTypes.has(relationship.resourceType)) {
            return belongsToCompany(relationship, input.legalEntityId);
          }
          // Tenant-wide grants stay while another company still needs them; tenant membership always stays.
          return (
            otherCompanies.length === 0 &&
            !(relationship.resourceType === 'tenant' && relationship.relation === 'member')
          );
        })
      : [];
    yield* write(rpc, v1.RelationshipUpdate_Operation.DELETE, input.principalId, revoke);
    yield* write(rpc, v1.RelationshipUpdate_Operation.TOUCH, input.principalId, desired);
    return { granted: desired.length, revoked: revoke.length };
  }),
  companiesOf: (principalId) =>
    relationshipsOf(rpc, principalId).pipe(Effect.map((relationships) => membershipCompanies(relationships))),
  companyMembers: (tenantId, legalEntityId) =>
    rpc
      .readRelationships(
        v1.ReadRelationshipsRequest.create({
          consistency: fullyConsistent,
          relationshipFilter: v1.RelationshipFilter.create({
            optionalRelation: 'member',
            optionalResourceId: toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '',
            optionalSubjectFilter: v1.SubjectFilter.create({ subjectType: 'principal' }),
            resourceType: 'legal_entity',
          }),
        }),
      )
      .pipe(
        Effect.map((responses) =>
          responses.flatMap(({ relationship }) =>
            relationship?.subject?.object === undefined ? [] : [relationship.subject.object.objectId],
          ),
        ),
        Effect.mapError(unavailable),
      ),
  relationshipsOf: (principalId) => relationshipsOf(rpc, principalId),
  replaceAgentGrants: Effect.fn('DemoAccountGrants.replaceAgentGrants')(function* replaceAgentGrants(input) {
    const current = yield* relationshipsOf(rpc, input.principalId);
    return yield* replaceAgentScopedRolePolicy(rpc, {
      ...input,
      currentPrincipalRelationships: current
        .map(
          (relationship) => update(v1.RelationshipUpdate_Operation.TOUCH, input.principalId, relationship).relationship,
        )
        .filter((relationship) => relationship !== undefined),
    });
  }),
  rolePolicyOf: (principalId) => readScopedRoleTemplatePolicy(rpc, principalId),
});

/** Opens one SpiceDB client for the scope of a request (local development SpiceDB from `SPICEDB_*`). */
export const openDemoAccountGrants = Effect.acquireRelease(
  loadSpiceDbConfig().pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((configuration) =>
      Effect.try({ catch: unavailable, try: () => openSpiceDbRpc(configuration, 10_000) }),
    ),
  ),
  (rpc) => Effect.sync(() => rpc.close()),
).pipe(Effect.map(makeGrants));
