/**
 * Legacy company membership of an agent principal, read from its `legal_entity#member` grants. Its one remaining reader
 * is the OAuth connection live check for agent-acting grants; v2 tenants carry no such grant, so it answers no company.
 */
import {
  Consistency,
  ReadRelationshipsRequest,
  RelationshipFilter,
  SubjectFilter,
} from '@authzed/authzed-node/v1/permissions';
import { openSpiceDbRpc } from '../permissions/spicedb-transaction-guard.ts';
import { Effect, Option, Schema } from 'effect';

import { IdentityPersistenceUnavailableError } from '../auth/principal-management-errors.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import type { SpiceDbRpc } from '../permissions/spicedb-rpc.ts';

export interface DemoAccountRelationship {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

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

const fullyConsistent = Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });

const companiesOf = (rpc: SpiceDbRpc, principalId: string) =>
  rpc
    .readRelationships(
      ReadRelationshipsRequest.create({
        consistency: fullyConsistent,
        relationshipFilter: RelationshipFilter.create({
          optionalRelation: 'member',
          optionalSubjectFilter: SubjectFilter.create({ optionalSubjectId: principalId, subjectType: 'principal' }),
          resourceType: 'legal_entity',
        }),
      }),
    )
    .pipe(
      Effect.map((responses) =>
        responses.flatMap(({ relationship }) =>
          relationship?.resource === undefined
            ? []
            : demoAccountObjectIdParts(relationship.resource.objectId).slice(1, 2),
        ),
      ),
      Effect.mapError(unavailable),
    );

export interface DemoAccountGrants {
  /** Legal entities the principal is a member of (decoded from its `legal_entity#member` grants). */
  readonly companiesOf: (principalId: string) => Effect.Effect<readonly string[], IdentityPersistenceUnavailableError>;
}

/** Opens one SpiceDB client for the scope of a request (local development SpiceDB from `SPICEDB_*`). */
export const openDemoAccountGrants = Effect.acquireRelease(
  loadSpiceDbConfig().pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((configuration) =>
      Effect.try({ catch: unavailable, try: () => openSpiceDbRpc(configuration, 10_000) }),
    ),
  ),
  (rpc) => Effect.sync(() => rpc.close()),
).pipe(Effect.map((rpc): DemoAccountGrants => ({ companiesOf: (principalId) => companiesOf(rpc, principalId) })));
