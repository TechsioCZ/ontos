/**
 * Sales-demo account administration: SpiceDB side. Roles are predefined per company and each role is backed by
 * an existing template persona (the accounts `scripts/demo/reset-permissions.mts` grants). Assigning a role
 * copies the template's company-scoped grants (company membership, module access, context permissions), its
 * tenant relations and its Action executor grants to the target principal, i.e. the same relationships the
 * demo permission scripts write, without re-implementing the role matrix.
 */
import { v1 } from '@authzed/authzed-node';
import { spiceDbTransport } from '#spicedb-transport';
import { Effect, Schema } from 'effect';

import { IdentityPersistenceUnavailableError } from '../auth/principal-management-errors.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import { toLegalEntityAccessObjectId } from '../permissions/context-access.ts';
import type { SpiceDbRpc } from '../permissions/spicedb-rpc.ts';

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
  return decoded._tag === 'Some' ? decoded.value : [];
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
    { concurrency: 5 },
  ).pipe(
    Effect.map((groups) => groups.flat()),
    Effect.mapError(unavailable),
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
    { discard: true },
  ).pipe(Effect.mapError(unavailable));

export interface DemoAccountGrants {
  /** Principals with `member` on the company. */
  readonly companyMembers: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly string[], IdentityPersistenceUnavailableError>;
  /** Legal entities the principal is a member of (decoded from its `legal_entity#member` grants). */
  readonly companiesOf: (principalId: string) => Effect.Effect<readonly string[], IdentityPersistenceUnavailableError>;
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
  /** Role-carrying relationships whose subject is the principal (tenant, company, module, context permission, Action). */
  readonly relationshipsOf: (
    principalId: string,
  ) => Effect.Effect<readonly DemoAccountRelationship[], IdentityPersistenceUnavailableError>;
  /** Makes `desired` the agent's complete grant set; everything else is removed except the tenant membership. */
  readonly replaceAgentGrants: (input: {
    readonly desired: readonly DemoAccountRelationship[];
    readonly principalId: string;
  }) => Effect.Effect<{ readonly granted: number; readonly revoked: number }, IdentityPersistenceUnavailableError>;
  /** Principals with `operator` on `principal:{agentPrincipalId}` (who may connect the agent over OAuth). */
  readonly agentOperators: (
    agentPrincipalId: string,
  ) => Effect.Effect<readonly string[], IdentityPersistenceUnavailableError>;
  /** Makes `operatorPrincipalIds` the complete `principal:{agent}#operator` set. */
  readonly replaceAgentOperators: (input: {
    readonly agentPrincipalId: string;
    readonly operatorPrincipalIds: readonly string[];
  }) => Effect.Effect<{ readonly granted: number; readonly revoked: number }, IdentityPersistenceUnavailableError>;
}

const membershipCompanies = (relationships: readonly DemoAccountRelationship[]) =>
  relationships
    .filter((relationship) => relationship.resourceType === 'legal_entity' && relationship.relation === 'member')
    .flatMap((relationship) => demoAccountObjectIdParts(relationship.resourceId).slice(1, 2));

const operatorRelationship = (agentPrincipalId: string): DemoAccountRelationship => ({
  relation: 'operator',
  resourceId: agentPrincipalId,
  resourceType: 'principal',
});

const agentOperators = (rpc: SpiceDbRpc, agentPrincipalId: string) =>
  rpc
    .readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency: fullyConsistent,
        relationshipFilter: v1.RelationshipFilter.create({
          optionalRelation: 'operator',
          optionalResourceId: agentPrincipalId,
          optionalSubjectFilter: v1.SubjectFilter.create({ subjectType: 'principal' }),
          resourceType: 'principal',
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
    );

const makeGrants = (rpc: SpiceDbRpc): DemoAccountGrants => ({
  agentOperators: (agentPrincipalId) => agentOperators(rpc, agentPrincipalId),
  replaceAgentOperators: Effect.fn('DemoAccountGrants.replaceAgentOperators')(function* replaceAgentOperators(input) {
    const current = yield* agentOperators(rpc, input.agentPrincipalId);
    const wanted = [...new Set(input.operatorPrincipalIds)];
    const add = wanted.filter((id) => !current.includes(id));
    const remove = current.filter((id) => !wanted.includes(id));
    yield* Effect.forEach(
      remove,
      (operatorId) =>
        write(rpc, v1.RelationshipUpdate_Operation.DELETE, operatorId, [operatorRelationship(input.agentPrincipalId)]),
      { discard: true },
    );
    yield* Effect.forEach(
      add,
      (operatorId) =>
        write(rpc, v1.RelationshipUpdate_Operation.TOUCH, operatorId, [operatorRelationship(input.agentPrincipalId)]),
      { discard: true },
    );
    return { granted: add.length, revoked: remove.length };
  }),
  assignRole: Effect.fn('DemoAccountGrants.assignRole')(function* assignRole(input) {
    const template = yield* relationshipsOf(rpc, input.templatePrincipalId);
    const desired = template.filter(
      (relationship) =>
        !companyScopedTypes.has(relationship.resourceType) || belongsToCompany(relationship, input.legalEntityId),
    );
    const current = yield* relationshipsOf(rpc, input.principalId);
    const key = (relationship: DemoAccountRelationship) =>
      `${relationship.resourceType}|${relationship.resourceId}|${relationship.relation}`;
    const desiredKeys = new Set(desired.map(key));
    const otherCompanies = membershipCompanies(current).filter((company) => company !== input.legalEntityId);
    const revoke = input.replace
      ? current.filter((relationship) => {
          if (desiredKeys.has(key(relationship))) {
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
  relationshipsOf: (principalId) => relationshipsOf(rpc, principalId),
  replaceAgentGrants: Effect.fn('DemoAccountGrants.replaceAgentGrants')(function* replaceAgentGrants(input) {
    const key = (relationship: DemoAccountRelationship) =>
      `${relationship.resourceType}|${relationship.resourceId}|${relationship.relation}`;
    const desiredKeys = new Set(input.desired.map(key));
    const current = yield* relationshipsOf(rpc, input.principalId);
    const revoke = current.filter(
      (relationship) =>
        !desiredKeys.has(key(relationship)) &&
        !(relationship.resourceType === 'tenant' && relationship.relation === 'member'),
    );
    yield* write(rpc, v1.RelationshipUpdate_Operation.DELETE, input.principalId, revoke);
    yield* write(rpc, v1.RelationshipUpdate_Operation.TOUCH, input.principalId, input.desired);
    return { granted: input.desired.length, revoked: revoke.length };
  }),
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
});

/** Opens one SpiceDB client for the scope of a request (local development SpiceDB from `SPICEDB_*`). */
export const openDemoAccountGrants = Effect.acquireRelease(
  loadSpiceDbConfig().pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((configuration) =>
      Effect.try({ catch: unavailable, try: () => spiceDbTransport.open(configuration, 10_000) }),
    ),
  ),
  (rpc) => Effect.sync(() => rpc.close()),
).pipe(Effect.map(makeGrants));
