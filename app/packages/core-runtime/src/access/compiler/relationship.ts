import { Option, Schema } from 'effect';

import { decodeObjectId, objectTypeOf, scopeObjectId } from './object-id.ts';

/**
 * The SpiceDB relationship set of the v2 engine schema, in intent terms.
 *
 * **Identity** is what the engine uses to tell one tuple from another: resource, relation and
 * subject. A write replaces the tuple it identifies, so the caveat and the expiration are *content*
 * of one tuple, not part of its identity. Sending a `TOUCH` of the new content and a `DELETE` of the
 * old content in one request is refused outright (`a relationship can only be specified in an update
 * once per overall WriteRelationships request`), which is why a ceiling narrowed from 10 000 to 5 000
 * must be a single `TOUCH`.
 *
 * **Content** is the caveat and the expiration. Verification compares it, because a tuple with the
 * right identity and the wrong content is drift, and a diff rewrites it instead of deleting and
 * recreating it.
 */
export const ACCESS_CAVEAT_NAMES = ['amount_ceiling', 'bounded_target_set', 'target_set'] as const;
export const AccessCaveatNameSchema = Schema.Literals(ACCESS_CAVEAT_NAMES);
export type AccessCaveatName = typeof AccessCaveatNameSchema.Type;

export type CaveatContextValue = number | string | readonly string[];
/** Only the limit and target parameters are stored; a request supplies the amount and target. */
export type AccessCaveatContext = Readonly<Record<string, CaveatContextValue>>;

export interface AccessCaveat {
  readonly context: AccessCaveatContext;
  readonly name: AccessCaveatName;
}

export interface AccessRelationshipSubject {
  readonly objectId: string;
  readonly objectType: string;
  /** Set for usersets such as `access_assignment:<id>#holder`. */
  readonly relation?: string;
}

export interface AccessRelationship {
  readonly caveat?: AccessCaveat;
  /** Whole seconds, the resolution SpiceDB stores, so a read-back tuple compares equal. */
  readonly expiresAtEpochSeconds?: number;
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly subject: AccessRelationshipSubject;
  /**
   * Set only on a tuple read back from the engine whose caveat or expiration Core cannot decode. Its
   * identity is known, its content is not, so it never equals an intended tuple: verification reports
   * it as drift and the diff deletes it instead of leaving it invisible (D13).
   */
  readonly undecodable?: true;
}

const VALUE_SEPARATOR = '\u0000';
const ENTRY_SEPARATOR = '\u0001';

const caveatValueKey = (value: CaveatContextValue): string => (Array.isArray(value) ? value.join(',') : String(value));

/** Stable caveat text so two contexts that differ only in key order are the same tuple. */
export const caveatContextKey = (context: AccessCaveatContext): string =>
  Object.entries(context)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${VALUE_SEPARATOR}${caveatValueKey(value)}`)
    .join(ENTRY_SEPARATOR);

/**
 * SpiceDB caps the context a relationship may store; a target set that outgrows it cannot be written
 * at all, so the planner refuses it instead of sending a write the engine rejects.
 */
export const ACCESS_CAVEAT_CONTEXT_MAX_BYTES = 25_000;
const caveatContextEncoder = new TextEncoder();

/**
 * Bytes of the stored caveat context, measured over the canonical text the compiler already keeps so
 * the same context always measures the same. A target set that outgrows the engine's limit is
 * refused at plan time, before a write the engine would reject.
 */
export const caveatContextBytes = (context: AccessCaveatContext): number =>
  caveatContextEncoder.encode(caveatContextKey(context)).byteLength;

/**
 * v2 subject types: a verified human (`access_human`) and an agent, never a workload (O46). A
 * service, integration or system principal is refused by the planner instead of projected.
 */
export const PROJECTION_SUBJECT_TYPES = { agent: 'agent', human: 'access_human' } as const;

const subjectKey = (subject: AccessRelationshipSubject): string => {
  const object = `${subject.objectType}:${subject.objectId}`;
  return subject.relation === undefined ? object : `${object}#${subject.relation}`;
};

const caveatKey = (caveat: AccessCaveat | undefined): string =>
  caveat === undefined ? '' : `${caveat.name}${VALUE_SEPARATOR}${caveatContextKey(caveat.context)}`;

/** Identity of a tuple: what the engine replaces on a write and removes on a delete. */
export const relationshipIdentity = (relationship: AccessRelationship): string =>
  [relationship.resourceType, relationship.resourceId, relationship.relation, subjectKey(relationship.subject)].join(
    '/',
  );

const expirationKey = (relationship: AccessRelationship): string =>
  relationship.expiresAtEpochSeconds === undefined ? '' : `@${relationship.expiresAtEpochSeconds}`;

/**
 * Full canonical text of one tuple: its identity plus the content a touch overwrites. Two tuples with
 * one identity and different content are one tuple in two states, never two tuples.
 */
export const relationshipKey = (relationship: AccessRelationship): string =>
  `${relationshipIdentity(relationship)}${caveatKey(relationship.caveat)}${expirationKey(relationship)}${
    relationship.undecodable === true ? '!' : ''
  }`;

/**
 * Identities the plan states more than once. One SpiceDB tuple carries one content, so a plan that
 * fills one identity twice could never be written: it is a planning error, never a silent union.
 */
export const duplicateTupleIdentities = (relationships: readonly AccessRelationship[]): readonly string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const relationship of relationships) {
    const identity = relationshipIdentity(relationship);
    if (seen.has(identity)) {
      duplicates.add(identity);
    }
    seen.add(identity);
  }
  return [...duplicates];
};

export const compareRelationships = (left: AccessRelationship, right: AccessRelationship): number =>
  relationshipKey(left).localeCompare(relationshipKey(right));

export const sortRelationships = (relationships: readonly AccessRelationship[]): readonly AccessRelationship[] =>
  relationships.toSorted(compareRelationships);

/** Keeps the last content of each identity; a duplicate identity is refused by the planner. */
export const uniqueRelationships = (relationships: readonly AccessRelationship[]): readonly AccessRelationship[] => [
  ...new Map(relationships.map((relationship) => [relationshipIdentity(relationship), relationship])).values(),
];

export const ACCESS_PROJECTION_UNIT_KINDS = ['tenant', 'legal_entity', 'scope'] as const;
export const AccessProjectionUnitKindSchema = Schema.Literals(ACCESS_PROJECTION_UNIT_KINDS);
export type AccessProjectionUnitKind = typeof AccessProjectionUnitKindSchema.Type;

/**
 * A unit is named by its kind and root object ID. Every derived ID carries its tenant, so two
 * tenants never share a unit and a reconcile cannot reach another tenant's graph by accident.
 */
export interface ProjectionUnitKey {
  readonly kind: AccessProjectionUnitKind;
  readonly objectId: string;
}

export const projectionUnitKeyText = (unit: ProjectionUnitKey): string => `${unit.kind}:${unit.objectId}`;

/**
 * The unit that owns a tuple, derived from the resource object ID alone: a tenant or a legal entity
 * is its own unit, and everything else belongs to the scope its ID names.
 */
export const unitOfRelationship = (relationship: AccessRelationship): Option.Option<ProjectionUnitKey> =>
  Option.flatMap(decodeObjectId(relationship.resourceId), (decoded) => {
    if (decoded.kind === 'tenant' || decoded.kind === 'legal_entity') {
      return Option.some({ kind: decoded.kind, objectId: relationship.resourceId });
    }
    const [tenantId, scopeId] = decoded.parts;
    return tenantId === undefined || scopeId === undefined
      ? Option.none()
      : Option.some({ kind: 'scope', objectId: scopeObjectId(tenantId, scopeId) });
  });

export interface ManagedRelation {
  readonly relation: string;
  readonly type: string;
}

const capabilityGrantRelations = (): readonly ManagedRelation[] =>
  (['run', 'propose', 'approve'] as const).flatMap((mode) =>
    (['all', 'assigned', 'entrusted', 'team'] as const).map((slot) => ({
      relation: `${mode}_${slot}_grant`,
      type: objectTypeOf('capability'),
    })),
  );

/**
 * The relations the compiler owns. It deletes a tuple only inside this surface and only on an
 * object of a unit named by the reconcile, so records, teams and mandates stay with their own lanes
 * and an unknown row is reported by verification, never silently removed.
 */
export const MANAGED_RELATIONS: readonly ManagedRelation[] = [
  { relation: 'owner', type: objectTypeOf('tenant') },
  { relation: 'suspended', type: objectTypeOf('tenant') },
  { relation: 'member', type: objectTypeOf('tenant') },
  { relation: 'access_admin', type: objectTypeOf('legal_entity') },
  { relation: 'suspended', type: objectTypeOf('legal_entity') },
  { relation: 'tenant', type: objectTypeOf('legal_entity') },
  { relation: 'member', type: objectTypeOf('legal_entity') },
  { relation: 'legal_entity', type: objectTypeOf('scope') },
  { relation: 'tenant_context', type: objectTypeOf('scope') },
  { relation: 'tenant', type: objectTypeOf('scope') },
  { relation: 'enabled_scope', type: objectTypeOf('installation') },
  { relation: 'agent_holder', type: objectTypeOf('assignment') },
  { relation: 'holder', type: objectTypeOf('assignment') },
  { relation: 'scope', type: objectTypeOf('assignment') },
  { relation: 'agent_member', type: objectTypeOf('role_binding') },
  { relation: 'member', type: objectTypeOf('role_binding') },
  { relation: 'scope', type: objectTypeOf('role_binding') },
  { relation: 'manager', type: objectTypeOf('delegation') },
  { relation: 'scope', type: objectTypeOf('delegation') },
  { relation: 'delegated_manager', type: objectTypeOf('capability') },
  { relation: 'installation', type: objectTypeOf('capability') },
  { relation: 'scope', type: objectTypeOf('capability') },
  ...capabilityGrantRelations(),
  { relation: 'binding', type: objectTypeOf('grant') },
  { relation: 'capability', type: objectTypeOf('grant') },
];

export const isManagedRelation = (relationship: Pick<AccessRelationship, 'relation' | 'resourceType'>): boolean =>
  MANAGED_RELATIONS.some(
    (managed) => managed.type === relationship.resourceType && managed.relation === relationship.relation,
  );
