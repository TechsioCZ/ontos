import { Match, Option, Result, Schema } from 'effect';

import type { Cell } from '../model.ts';

/**
 * SpiceDB object identity for the v2 engine schema (`src/permissions/schema.ts`).
 *
 * The graph is a projection, so every object ID is derived from intent: it is lossless (the
 * components are encoded, never hashed or truncated) and it names its owning scope, which is what
 * makes verification complete — a tuple read back from SpiceDB says both what it is and which
 * intent record it belongs to, without a side table. Verification therefore uses real IDs only
 * (D32). A derived ID that would exceed SpiceDB's 1024-character ceiling is a planning error that
 * fails the change, never a silently shortened key (D11).
 */
export const ACCESS_OBJECT_ID_MAX_LENGTH = 1024;

export const ACCESS_OBJECT_KINDS = [
  'assignment',
  'capability',
  'delegation',
  'grant',
  'installation',
  'legal_entity',
  'record',
  'role_binding',
  'scope',
  'tenant',
] as const;
export const AccessObjectKindSchema = Schema.Literals(ACCESS_OBJECT_KINDS);
export type AccessObjectKind = typeof AccessObjectKindSchema.Type;

/** SpiceDB object types of the v2 engine schema. Tags stay prefix-free so decoding is exact. */
const OBJECT_TYPE_BY_KIND = {
  assignment: 'access_assignment',
  capability: 'access_capability',
  delegation: 'access_delegation',
  grant: 'access_grant',
  installation: 'access_installation',
  legal_entity: 'access_legal_entity',
  record: 'access_record',
  role_binding: 'access_role_binding',
  scope: 'access_scope',
  tenant: 'access_tenant',
} as const satisfies Readonly<Record<AccessObjectKind, string>>;
const TAG_BY_KIND = {
  assignment: 'as_',
  capability: 'cp_',
  delegation: 'dg_',
  grant: 'gr_',
  installation: 'in_',
  legal_entity: 'le_',
  record: 'rc_',
  role_binding: 'rb_',
  scope: 'sc_',
  tenant: 'tn_',
} as const satisfies Readonly<Record<AccessObjectKind, string>>;

export const objectTypeOf = (kind: AccessObjectKind): string => OBJECT_TYPE_BY_KIND[kind];

export const CAPABILITY_SLOTS = ['all', 'assigned', 'entrusted', 'team'] as const;
export const CapabilitySlotSchema = Schema.Literals(CAPABILITY_SLOTS);
export type CapabilitySlot = typeof CapabilitySlotSchema.Type;

/**
 * Explicit target sets ride the `all` slot: the engine has four record-scope slots and the target
 * list is a caveat on the grant binding, so `all` and `targets` share one slot. Two cells of one
 * capability and mode may therefore never occupy `all` and `targets` together — the union in the
 * schema would silently widen the narrower one.
 */
export const capabilitySlot = (cell: Cell): CapabilitySlot =>
  Match.value(cell.selector).pipe(
    Match.tag('targets', (): CapabilitySlot => 'all'),
    Match.tag('all', (): CapabilitySlot => 'all'),
    Match.tag('assigned', (): CapabilitySlot => 'assigned'),
    Match.tag('entrusted', (): CapabilitySlot => 'entrusted'),
    Match.tag('team', (): CapabilitySlot => 'team'),
    Match.exhaustive,
  );

const ObjectIdParts = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeObjectIdParts = Schema.encodeResult(ObjectIdParts);
const decodeObjectIdParts = Schema.decodeResult(ObjectIdParts);

const deriveObjectId = (kind: AccessObjectKind, parts: readonly string[]): string => {
  const encoded = Result.getOrThrow(encodeObjectIdParts([...parts]));
  return `${TAG_BY_KIND[kind]}${Buffer.from(encoded, 'utf-8').toString('base64url')}`;
};

export const tenantObjectId = (tenantId: string): string => deriveObjectId('tenant', [tenantId]);

const KIND_BY_OBJECT_TYPE: ReadonlyMap<string, AccessObjectKind> = new Map(
  ACCESS_OBJECT_KINDS.map((kind) => [OBJECT_TYPE_BY_KIND[kind], kind]),
);

/**
 * The ID prefix every object of one type and tenant shares. The tenant is the first part of every
 * derived ID, and base64url only fixes complete 3-byte groups, so the prefix covers the encoded
 * `["<tenantId>"` up to its last whole group. It narrows an engine read to (at least) the tenant; the
 * decoded IDs still decide which tuples belong to it. `None` for a type the compiler does not own.
 */
export const tenantObjectIdPrefix = (objectType: string, tenantId: string): Option.Option<string> =>
  Option.map(Option.fromUndefinedOr(KIND_BY_OBJECT_TYPE.get(objectType)), (kind) => {
    const head = Buffer.from(Result.getOrThrow(encodeObjectIdParts([tenantId])).slice(0, -1), 'utf-8');
    return `${TAG_BY_KIND[kind]}${head.subarray(0, head.length - (head.length % 3)).toString('base64url')}`;
  });
export const legalEntityObjectId = (tenantId: string, legalEntityId: string): string =>
  deriveObjectId('legal_entity', [tenantId, legalEntityId]);
export const scopeObjectId = (tenantId: string, scopeId: string): string =>
  deriveObjectId('scope', [tenantId, scopeId]);
export const installationObjectId = (tenantId: string, scopeId: string, moduleKey: string): string =>
  deriveObjectId('installation', [tenantId, scopeId, moduleKey]);
export const assignmentObjectId = (tenantId: string, scopeId: string, incarnationId: string): string =>
  deriveObjectId('assignment', [tenantId, scopeId, incarnationId]);
/**
 * One binding per role and scope. Holders attach to it, so a role edit re-points grant cells and
 * never rewrites a holder tuple (M1). The planner enforces the invariant that makes this sound:
 * every live assignment of a role in a scope pins the same immutable revision.
 */
export const roleBindingObjectId = (tenantId: string, scopeId: string, roleId: string): string =>
  deriveObjectId('role_binding', [tenantId, scopeId, roleId]);
export const delegationObjectId = (tenantId: string, scopeId: string, delegationId: string): string =>
  deriveObjectId('delegation', [tenantId, scopeId, delegationId]);
export const capabilityObjectId = (tenantId: string, scopeId: string, capabilityKey: string): string =>
  deriveObjectId('capability', [tenantId, scopeId, capabilityKey]);
/**
 * One complete cell per role x scope x slot, shared by every assignment of the role. The revision
 * is deliberately absent: an equal-or-broader cell keeps its grant identity, so mandates keep their
 * witnesses across role edits (D1) and a cell change rewrites only that slot.
 */
export const grantObjectId = (tenantId: string, scopeId: string, roleId: string, cell: Cell): string =>
  deriveObjectId('grant', [tenantId, scopeId, roleId, cell.capabilityKey, cell.mode, capabilitySlot(cell)]);
/**
 * One business record, named by its owning module's immutable record key (O9) inside the exact
 * tenant, scope and module. The raw key is never the object ID: `RecordKey` is any string of 1–500
 * characters, so two tenants, scopes or modules would otherwise project different records onto one
 * SpiceDB object and a target check would prove the wrong record. The record projection and the
 * decision engine both derive the ID here, so a target check can only ever name the record inside
 * the scope the decision was resolved in (guarantee 3, D29, D32).
 */
export const recordObjectId = (tenantId: string, scopeId: string, moduleKey: string, recordKey: string): string =>
  deriveObjectId('record', [tenantId, scopeId, moduleKey, recordKey]);

export const capabilitySlotRelation = (cell: Cell): string => `${cell.mode}_${capabilitySlot(cell)}_grant`;

export interface DecodedObjectId {
  readonly kind: AccessObjectKind;
  readonly parts: readonly string[];
}

/** Lossless inverse of the derivation; `None` for an ID the compiler does not own. */
export const decodeObjectId = (objectId: string): Option.Option<DecodedObjectId> => {
  for (const kind of ACCESS_OBJECT_KINDS) {
    const tag = TAG_BY_KIND[kind];
    if (!objectId.startsWith(tag)) {
      continue;
    }
    const decoded = decodeObjectIdParts(Buffer.from(objectId.slice(tag.length), 'base64url').toString('utf-8'));
    return Result.isSuccess(decoded) ? Option.some({ kind, parts: decoded.success }) : Option.none();
  }
  return Option.none();
};

/** SpiceDB rejects longer IDs; the planner reports that as a failed change instead. */
export const isProjectableObjectId = (objectId: string): boolean =>
  objectId.length > 0 && objectId.length <= ACCESS_OBJECT_ID_MAX_LENGTH;
