import { DateTime, Match, Option, Result } from 'effect';

import { delegationCellIssue } from '../lifecycle/delegation.ts';
import type { DelegatedCellRequest } from '../lifecycle/delegation.ts';
import type {
  AmountCeiling,
  Cell,
  CellSelector,
  DelegatedLimits,
  Holder,
  RecordSelector,
  RoleRevision,
} from '../model.ts';
import type { RoleId } from '../ids.ts';
import type {
  AccessProjectionIntent,
  AccessPrincipalKind,
  CatalogEntryProjectionIntent,
  LegalEntityProjectionIntent,
  ProjectedConnectionCeiling,
  ProjectionMemberIntent,
  ProjectionPrincipalIntent,
  ScopeProjectionIntent,
  TenantProjectionIntent,
} from './intent.ts';
import {
  assignmentObjectId,
  capabilityObjectId,
  capabilitySlot,
  capabilitySlotRelation,
  delegationObjectId,
  grantObjectId,
  installationObjectId,
  isProjectableObjectId,
  legalEntityObjectId,
  objectTypeOf,
  roleBindingObjectId,
  scopeObjectId,
  tenantObjectId,
} from './object-id.ts';
import type {
  AccessProjectionUnitKind,
  AccessCaveat,
  AccessRelationship,
  AccessRelationshipSubject,
} from './relationship.ts';
import {
  ACCESS_CAVEAT_CONTEXT_MAX_BYTES,
  caveatContextBytes,
  duplicateTupleIdentities,
  PROJECTION_SUBJECT_TYPES,
  relationshipKey,
  sortRelationships,
  uniqueRelationships,
} from './relationship.ts';
import { AccessProjectionError, projectionUnitLabel } from './projection-error.ts';

/** One atomic write unit: a tenant, one legal entity, or one scope and everything it owns. */
export interface ProjectionUnit {
  readonly key: string;
  readonly kind: AccessProjectionUnitKind;
  readonly objectId: string;
  readonly relationships: readonly AccessRelationship[];
}

/** One scope the reconcile reads and may write, named the way the fence store names it. */
export interface ProjectionFenceScope {
  readonly scopeId: string;
  readonly tenantId: string;
}

export interface ProjectionPlan {
  /** Intent the graph must never carry, kept so the decision lane reads it fresh (D22). */
  readonly connectionCeilings: readonly ProjectedConnectionCeiling[];
  /** The scopes this plan writes; the reconcile must hold every one of their fences first (D15). */
  readonly fences: readonly ProjectionFenceScope[];
  /** Canonical text of the whole intended projection: what a plan fingerprint is computed over. */
  readonly lines: readonly string[];
  readonly units: readonly ProjectionUnit[];
}

const SECONDS_PER_MILLISECOND = 1000;
/** Whole seconds, the resolution SpiceDB stores: a re-plan then reads back equal, not drifted. */
const epochSeconds = (date: Date): number =>
  Math.max(1, Math.floor(DateTime.toEpochMillis(DateTime.fromDateUnsafe(date)) / SECONDS_PER_MILLISECOND));

const objectSubject = (objectType: string, objectId: string): AccessRelationshipSubject => ({ objectId, objectType });
const principalSubject = (principalId: string): AccessRelationshipSubject =>
  objectSubject(PROJECTION_SUBJECT_TYPES.human, principalId);
const agentSubject = (agentId: string): AccessRelationshipSubject =>
  objectSubject(PROJECTION_SUBJECT_TYPES.agent, agentId);
const usersetSubject = (objectType: string, objectId: string, relation: string): AccessRelationshipSubject => ({
  objectId,
  objectType,
  relation,
});

const holderSubject = (holder: Holder): AccessRelationshipSubject =>
  Match.value(holder).pipe(
    Match.tag('Principal', ({ principalId }) => principalSubject(principalId)),
    Match.tag('Agent', ({ agentId }) => agentSubject(agentId)),
    Match.exhaustive,
  );

/** Explicit target sets are a caveat on the `all` slot, so both selectors read the same keys. */
const recordKeysOf = (selector: CellSelector): readonly string[] | undefined =>
  Option.getOrUndefined(
    Match.value(selector).pipe(
      Match.tag('targets', (targets) => Option.some<readonly string[]>(targets.recordKeys)),
      Match.orElse((): Option.Option<readonly string[]> => Option.none()),
    ),
  );

/** The named record selector of a cell; `undefined` for an explicit target set, which has no name. */
const recordSelectorOf = (selector: CellSelector): Option.Option<RecordSelector> =>
  Match.value(selector).pipe(
    Match.tag('all', () => Option.some<RecordSelector>('all')),
    Match.tag('assigned', () => Option.some<RecordSelector>('assigned')),
    Match.tag('entrusted', () => Option.some<RecordSelector>('entrusted')),
    Match.tag('team', () => Option.some<RecordSelector>('team')),
    Match.tag('targets', () => Option.none<RecordSelector>()),
    Match.exhaustive,
  );

const legalEntityIdOf = (intent: ScopeProjectionIntent): string | undefined =>
  Option.getOrUndefined(
    Match.value(intent.scope.scope).pipe(
      Match.tag('LegalEntity', ({ legalEntityId }) => Option.some<string>(legalEntityId)),
      Match.orElse((): Option.Option<string> => Option.none()),
    ),
  );

const principalIdOf = (holder: Holder): string | undefined =>
  Option.getOrUndefined(
    Match.value(holder).pipe(
      Match.tag('Principal', ({ principalId }) => Option.some<string>(principalId)),
      Match.orElse((): Option.Option<string> => Option.none()),
    ),
  );

interface RelationshipExtras {
  readonly caveat?: AccessCaveat;
  readonly expiresAtEpochSeconds?: number;
}

const relate = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subject: AccessRelationshipSubject,
  extras: RelationshipExtras = {},
): AccessRelationship => ({ relation, resourceId, resourceType, subject, ...extras });

const expirationExtras = (validUntil: Date | undefined): RelationshipExtras =>
  validUntil === undefined ? {} : { expiresAtEpochSeconds: epochSeconds(validUntil) };

/**
 * The cell caveat. Amount and target limits travel on the grant binding, so one grant cell serves
 * every amount the ceiling allows, and both limits together use `bounded_target_set`.
 */
export const cellCaveat = (cell: Cell): AccessCaveat | undefined => {
  const recordKeys = recordKeysOf(cell.selector);
  const ceiling = cell.amountCeiling;
  if (recordKeys !== undefined && ceiling !== undefined) {
    return {
      context: { limit_currency: ceiling.currency, limit_minor: ceiling.limitMinor, resource_keys: [...recordKeys] },
      name: 'bounded_target_set',
    };
  }
  if (recordKeys !== undefined) {
    return { context: { resource_keys: [...recordKeys] }, name: 'target_set' };
  }
  if (ceiling !== undefined) {
    return { context: { limit_currency: ceiling.currency, limit_minor: ceiling.limitMinor }, name: 'amount_ceiling' };
  }
  return undefined;
};

/** The pinned catalog entries of one tenant, keyed by capability key. */
type CatalogEntries = ReadonlyMap<string, CatalogEntryProjectionIntent>;

/** The owning module of a capability, as the pinned catalog entry declares it (O27). */
const owningModuleOf = (entries: CatalogEntries, capabilityKey: string): string | undefined =>
  entries.get(capabilityKey)?.moduleKey;

const unit = (
  kind: AccessProjectionUnitKind,
  objectId: string,
  relationships: readonly AccessRelationship[],
  fail: Failure,
): ProjectionUnit => {
  for (const identity of duplicateTupleIdentities(relationships)) {
    fail('access_projection_duplicate_tuple', `The plan states ${identity} twice, which one tuple cannot carry`);
  }
  return {
    key: `${kind}:${objectId}`,
    kind,
    objectId,
    relationships: sortRelationships(uniqueRelationships(relationships)),
  };
};

const memberRelationships = (
  resourceType: string,
  resourceId: string,
  relation: string,
  members: readonly ProjectionMemberIntent[],
): readonly AccessRelationship[] =>
  members.map((member) =>
    relate(resourceType, resourceId, relation, holderSubject(member.holder), expirationExtras(member.expiresAt)),
  );

/**
 * v2 relations accept a verified human and an agent only (O46). A workload keeps its legacy
 * classification, so an intent that names one here is refused instead of projected.
 */
const validatePrincipalKinds = (
  relationships: readonly AccessRelationship[],
  principals: readonly ProjectionPrincipalIntent[],
  fail: Failure,
): void => {
  const kinds = new Map<string, AccessPrincipalKind>(
    principals.map((principal): [string, AccessPrincipalKind] => [principal.principalId, principal.kind]),
  );
  const expectedKinds = new Map<string, AccessPrincipalKind>([
    [PROJECTION_SUBJECT_TYPES.human, 'human'],
    [PROJECTION_SUBJECT_TYPES.agent, 'agent'],
  ]);
  for (const relationship of relationships) {
    const { objectId, objectType } = relationship.subject;
    const expected = expectedKinds.get(objectType);
    const declared = kinds.get(objectId);
    if (expected === undefined) {
      continue;
    }
    if (declared === undefined) {
      fail('access_projection_principal_kind_refused', `${objectId} is referenced without a declared principal kind`);
    } else if (declared !== expected) {
      fail(
        'access_projection_principal_kind_refused',
        `${objectId} is a ${declared} principal, and v2 relations carry humans and agents only`,
      );
    }
  }
};

/**
 * Every derived object ID must fit SpiceDB's ID ceiling in every unit, not only in a scope: a tenant
 * or legal entity ID that is too long fails the plan the same way (D11).
 */
const validateProjectableIds = (planned: ProjectionUnit, fail: Failure): void => {
  for (const relationship of planned.relationships) {
    if (!isProjectableObjectId(relationship.resourceId) || !isProjectableObjectId(relationship.subject.objectId)) {
      fail(
        'access_projection_identifier_too_long',
        `A projected ${relationship.resourceType} object ID exceeds the SpiceDB ID ceiling`,
      );
    }
  }
};

const planTenantUnit = (tenantObject: string, tenant: TenantProjectionIntent, fail: Failure): ProjectionUnit => {
  const tenantType = objectTypeOf('tenant');
  return unit(
    'tenant',
    tenantObject,
    [
      ...memberRelationships(tenantType, tenantObject, 'member', tenant.members),
      ...tenant.owners.map((ownerId) => relate(tenantType, tenantObject, 'owner', principalSubject(ownerId))),
      ...tenant.suspended.map((holder) => relate(tenantType, tenantObject, 'suspended', holderSubject(holder))),
    ],
    fail,
  );
};

const planLegalEntityUnit = (
  tenantObject: string,
  entityObject: string,
  entity: LegalEntityProjectionIntent,
  fail: Failure,
): ProjectionUnit => {
  const entityType = objectTypeOf('legal_entity');
  return unit(
    'legal_entity',
    entityObject,
    [
      relate(entityType, entityObject, 'tenant', objectSubject(objectTypeOf('tenant'), tenantObject)),
      ...memberRelationships(entityType, entityObject, 'member', entity.members),
      ...entity.accessAdmins.map((principalId) =>
        relate(entityType, entityObject, 'access_admin', principalSubject(principalId)),
      ),
      ...entity.suspended.map((holder) => relate(entityType, entityObject, 'suspended', holderSubject(holder))),
    ],
    fail,
  );
};

type Failure = (code: AccessProjectionError['code'], reason: string) => void;

const validateScopeIdentity = (
  tenantId: string,
  intent: ScopeProjectionIntent,
  legalEntityObjects: ReadonlyMap<string, string>,
  fail: Failure,
): string | undefined => {
  if (intent.scope.scope.tenantId !== tenantId) {
    fail('access_projection_scope_mismatch', 'The scope names another tenant than the intent block that carries it');
  }
  const legalEntityId = legalEntityIdOf(intent);
  const legalEntityObject = legalEntityId === undefined ? undefined : legalEntityObjects.get(legalEntityId);
  if (legalEntityId !== undefined && legalEntityObject === undefined) {
    fail('access_projection_scope_mismatch', 'The scope names a legal entity the intent does not project');
  }
  return legalEntityObject;
};

const validateScopeMembership = (
  tenantId: string,
  scopeId: string,
  intent: ScopeProjectionIntent,
  fail: Failure,
): void => {
  for (const revision of intent.roleRevisions) {
    if (revision.tenantId !== tenantId) {
      fail('access_projection_scope_mismatch', 'A role revision belongs to another tenant than the scope');
    }
  }
  const revisionIds = intent.roleRevisions.map((revision): string => revision.id);
  if (new Set(revisionIds).size !== revisionIds.length) {
    fail('access_projection_duplicate_intent', 'The scope projects the same role revision twice');
  }
  for (const assignment of intent.assignments) {
    if (assignment.tenantId !== tenantId || assignment.scopeId !== scopeId) {
      fail('access_projection_scope_mismatch', 'An assignment belongs to another tenant or scope than this one');
    }
  }
  for (const delegation of intent.delegations) {
    if (delegation.tenantId !== tenantId || delegation.scopeId !== scopeId) {
      fail('access_projection_scope_mismatch', 'A delegation belongs to another tenant or scope than this one');
    }
  }
  for (const connection of intent.connections) {
    if (connection.tenantId !== tenantId || connection.scopeId !== scopeId) {
      fail('access_projection_scope_mismatch', 'An agent connection belongs to another tenant or scope');
    }
  }
};

/**
 * Every cell a revision grants is checked against its pinned catalog entry (guarantee 2, O1, O27): a
 * removed, unknown or unpublished capability is never projected, a mode the declaration does not
 * have is never granted, a selector the declaration does not support is never widened into one it
 * does, and a money limit only rides a capability that declares an amount input.
 */
const validateCellDeclaration = (cell: Cell, entries: CatalogEntries, fail: Failure): void => {
  const entry = entries.get(cell.capabilityKey);
  if (entry === undefined) {
    fail('access_projection_unknown_capability', `${cell.capabilityKey} is not a catalog entry of the pinned snapshot`);
    return;
  }
  if (!entry.modes.includes(cell.mode)) {
    fail('access_projection_cell_outside_declaration', `${cell.capabilityKey} does not declare the ${cell.mode} mode`);
  }
  const recordSelector = Option.getOrUndefined(recordSelectorOf(cell.selector));
  if (recordSelector === undefined && entry.selectors.length === 0) {
    fail(
      'access_projection_cell_outside_declaration',
      `${cell.capabilityKey} is not record-scoped, so it carries no explicit target set`,
    );
  } else if (recordSelector !== undefined && recordSelector !== 'all' && !entry.selectors.includes(recordSelector)) {
    fail(
      'access_projection_cell_outside_declaration',
      `${cell.capabilityKey} does not declare the ${recordSelector} selector`,
    );
  }
  if (cell.amountCeiling !== undefined && entry.amountInput === undefined) {
    fail(
      'access_projection_limit_without_amount_input',
      `${cell.capabilityKey} declares no amount input, so a money limit cannot apply to it`,
    );
  }
  const caveat = cellCaveat(cell);
  if (caveat !== undefined && caveatContextBytes(caveat.context) > ACCESS_CAVEAT_CONTEXT_MAX_BYTES) {
    fail(
      'access_projection_caveat_context_too_large',
      `The stored caveat context of ${cell.capabilityKey} exceeds the engine's relationship context limit`,
    );
  }
};

/**
 * Resolves the one revision each role pins here. Two live assignments on different revisions of one
 * role would union their cells into a wider grant than either holder was given, so it is refused
 * rather than projected.
 */
const resolvePinnedRevisions = (
  intent: ScopeProjectionIntent,
  activeAssignments: ScopeProjectionIntent['assignments'],
  entries: CatalogEntries,
  fail: Failure,
): ReadonlyMap<string, RoleRevision> => {
  const revisionById = new Map<string, RoleRevision>(
    intent.roleRevisions.map((revision): [string, RoleRevision] => [revision.id, revision]),
  );
  const pinned = new Map<string, Set<string>>();
  for (const assignment of activeAssignments) {
    const revision = revisionById.get(assignment.roleRevisionId);
    if (revision === undefined) {
      fail('access_projection_unknown_role_revision', 'A live assignment pins a revision intent does not provide');
    } else if (revision.roleId === assignment.roleId) {
      const pinnedRevisions = pinned.get(assignment.roleId) ?? new Set<string>();
      pinnedRevisions.add(revision.id);
      pinned.set(assignment.roleId, pinnedRevisions);
    } else {
      fail('access_projection_unknown_role_revision', 'A live assignment pins a revision of another role');
    }
  }
  const revisionByRole = new Map<string, RoleRevision>();
  for (const [roleId, revisionIds] of pinned) {
    const [revisionId] = [...revisionIds];
    const revision = revisionId === undefined ? undefined : revisionById.get(revisionId);
    if (revisionIds.size > 1) {
      fail(
        'access_projection_ambiguous_role_revision',
        'The live assignments of one role pin different revisions, so its shared cells would widen',
      );
    } else if (revision !== undefined) {
      revisionByRole.set(roleId, revision);
      const slots = revision.cells.map((cell) => `${cell.capabilityKey} ${cell.mode} ${capabilitySlot(cell)}`);
      if (new Set(slots).size !== slots.length) {
        fail(
          'access_projection_duplicate_cell_slot',
          'A role revision fills one capability slot twice, which the engine would read as a union',
        );
      }
      for (const cell of revision.cells) {
        validateCellDeclaration(cell, entries, fail);
      }
    }
  }
  return revisionByRole;
};

/**
 * Delegation containment (D10, guarantee 7): a delegated assignment stays inside the envelope it was
 * created from, every time it is projected, and not only on the day it was written.
 *
 * The rule is the lifecycle one: every cell of the pinned revision is checked with
 * `delegationCellIssue`, which knows that a money cell without a ceiling is unlimited authority. On
 * top of that the frozen `DelegatedLimits` bound the projection: they name the exact capability keys
 * the delegate was given and the ceiling frozen from the delegation, so a later role edit that adds a
 * capability or raises an amount is refused here instead of being inherited by a delegated holder
 * through the shared binding (O51(1)).
 *
 * A growing role edit is **refused**, never clipped: the graph must equal intent (D13), so silently
 * dropping a cell would make the reconcile fail verification instead of reporting the real cause.
 */
/** A money cell is inside a frozen ceiling only when it names one that fits it. */
const cellOutsideFrozenCeiling = (
  cell: Cell,
  frozenCeiling: AmountCeiling,
  entry: CatalogEntryProjectionIntent | undefined,
): boolean => {
  const ceiling = cell.amountCeiling;
  if (ceiling === undefined) {
    return entry?.amountInput !== undefined;
  }
  return ceiling.currency !== frozenCeiling.currency || ceiling.limitMinor > frozenCeiling.limitMinor;
};

/**
 * The cell-side bounds: every cell of the revision the assignment pins is inside the frozen limits
 * and inside the live envelope. A cell the frozen limits do not name, a raised amount or — with a
 * capped envelope — a money cell without a ceiling is refused, so a role edit after the delegation
 * can never grow what the delegate holds.
 */
const validateDelegatedCells = (
  roleId: RoleId,
  revisionByRole: ReadonlyMap<string, RoleRevision>,
  entries: CatalogEntries,
  delegation: ScopeProjectionIntent['delegations'][number],
  limits: NonNullable<ScopeProjectionIntent['assignments'][number]['delegated']>,
  fail: Failure,
): void => {
  const frozenKeys = new Set<string>(limits.capabilityKeys);
  const frozenCeiling = limits.amountCeiling;
  for (const cell of revisionByRole.get(roleId)?.cells ?? []) {
    const entry = entries.get(cell.capabilityKey);
    if (!frozenKeys.has(cell.capabilityKey)) {
      fail(
        'access_projection_delegation_containment',
        `The role now grants ${cell.capabilityKey}, which the frozen delegated limits do not name`,
      );
      continue;
    }
    if (frozenCeiling !== undefined && cellOutsideFrozenCeiling(cell, frozenCeiling, entry)) {
      fail(
        'access_projection_delegation_containment',
        `The role now grants ${cell.capabilityKey} beyond the frozen delegated amount limit`,
      );
    }
    const request =
      entry === undefined ? undefined : ({ cell, delegation, entry, roleId } satisfies DelegatedCellRequest);
    const issue = request === undefined ? undefined : delegationCellIssue(request);
    if (issue !== undefined) {
      fail('access_projection_delegation_containment', issue.reason);
    }
  }
};

/** The delegation-side bounds of a delegated assignment: holder, role, period and envelope keys. */
const validateDelegationEnvelope = (
  assignment: ScopeProjectionIntent['assignments'][number],
  delegation: ScopeProjectionIntent['delegations'][number],
  limits: DelegatedLimits,
  fail: Failure,
): boolean => {
  let contained = true;
  const refuse = (reason: string): void => {
    contained = false;
    fail('access_projection_delegation_containment', reason);
  };
  const principalId = principalIdOf(assignment.holder);
  if (principalId === undefined || !new Set<string>(delegation.people).has(principalId)) {
    refuse('A delegated assignment names a holder outside the delegation');
  }
  if (!delegation.roleIds.includes(assignment.roleId)) {
    refuse('A delegated assignment names a role outside the envelope');
  }
  if (assignment.validUntil === undefined || assignment.validUntil > delegation.validUntil) {
    refuse('A delegated assignment outlives its delegation');
  } else if (assignment.validUntil > limits.until) {
    refuse('A delegated assignment outlives the limits frozen from its delegation');
  }
  const envelopeKeys = new Set<string>(delegation.capabilityKeys);
  if (limits.capabilityKeys.some((capabilityKey) => !envelopeKeys.has(capabilityKey))) {
    refuse('Delegated limits name a capability outside the envelope');
  }
  return contained;
};

const validateDelegatedAssignment = (
  assignment: ScopeProjectionIntent['assignments'][number],
  liveDelegations: ReadonlyMap<string, ScopeProjectionIntent['delegations'][number]>,
  revisionByRole: ReadonlyMap<string, RoleRevision>,
  entries: CatalogEntries,
  fail: Failure,
): void => {
  const limits = assignment.delegated;
  if (limits === undefined) {
    return;
  }
  const delegation = liveDelegations.get(limits.delegationId);
  if (delegation === undefined) {
    fail('access_projection_delegation_containment', 'A delegated assignment names a delegation that is not live');
    return;
  }
  if (!validateDelegationEnvelope(assignment, delegation, limits, fail)) {
    return;
  }
  validateDelegatedCells(assignment.roleId, revisionByRole, entries, delegation, limits, fail);
};

const scopeRelationships = (
  scopeObject: string,
  tenantObject: string,
  legalEntityObject: string | undefined,
): readonly AccessRelationship[] => {
  const scopeType = objectTypeOf('scope');
  const tenantSubject = objectSubject(objectTypeOf('tenant'), tenantObject);
  return [
    relate(scopeType, scopeObject, 'tenant', tenantSubject),
    legalEntityObject === undefined
      ? relate(scopeType, scopeObject, 'tenant_context', tenantSubject)
      : relate(scopeType, scopeObject, 'legal_entity', objectSubject(objectTypeOf('legal_entity'), legalEntityObject)),
  ];
};

const delegationRelationships = (
  tenantId: string,
  scopeId: string,
  scopeObject: string,
  liveDelegations: ScopeProjectionIntent['delegations'],
): readonly AccessRelationship[] => {
  const delegationType = objectTypeOf('delegation');
  const scopeSubject = objectSubject(objectTypeOf('scope'), scopeObject);
  return liveDelegations.flatMap((delegation) => {
    const delegationObject = delegationObjectId(tenantId, scopeId, delegation.id);
    return [
      relate(delegationType, delegationObject, 'scope', scopeSubject),
      relate(delegationType, delegationObject, 'manager', principalSubject(delegation.managerId), {
        expiresAtEpochSeconds: epochSeconds(delegation.validUntil),
      }),
    ];
  });
};

/**
 * Holders attach to one role binding and grant cells are shared by everyone holding the role, so a
 * holder change writes one tuple and a cell change writes one cell: never one tuple per holder and
 * cell (M1).
 */
const assignmentRelationships = (
  tenantId: string,
  scopeId: string,
  scopeObject: string,
  activeAssignments: ScopeProjectionIntent['assignments'],
  revisionById: ReadonlyMap<string, RoleRevision>,
): readonly AccessRelationship[] => {
  const assignmentType = objectTypeOf('assignment');
  const bindingType = objectTypeOf('role_binding');
  const scopeSubject = objectSubject(objectTypeOf('scope'), scopeObject);
  const bindings = new Set<string>();
  const relationships: AccessRelationship[] = [];
  for (const assignment of activeAssignments) {
    const revision = revisionById.get(assignment.roleRevisionId);
    if (revision === undefined || revision.roleId !== assignment.roleId) {
      continue;
    }
    const assignmentObject = assignmentObjectId(tenantId, scopeId, assignment.incarnationId);
    const bindingObject = roleBindingObjectId(tenantId, scopeId, assignment.roleId);
    const expiration = expirationExtras(assignment.validUntil);
    relationships.push(relate(assignmentType, assignmentObject, 'scope', scopeSubject));
    const principalId = principalIdOf(assignment.holder);
    if (principalId === undefined) {
      relationships.push(
        relate(assignmentType, assignmentObject, 'agent_holder', holderSubject(assignment.holder), expiration),
        relate(
          bindingType,
          bindingObject,
          'agent_member',
          usersetSubject(assignmentType, assignmentObject, 'agent_holder'),
        ),
      );
    } else {
      relationships.push(
        relate(assignmentType, assignmentObject, 'holder', principalSubject(principalId), expiration),
        relate(bindingType, bindingObject, 'member', usersetSubject(assignmentType, assignmentObject, 'holder')),
      );
    }
    if (!bindings.has(bindingObject)) {
      bindings.add(bindingObject);
      relationships.push(relate(bindingType, bindingObject, 'scope', scopeSubject));
    }
  }
  return relationships;
};

const grantRelationships = (
  tenantId: string,
  scopeId: string,
  revisionByRole: ReadonlyMap<string, RoleRevision>,
): readonly AccessRelationship[] => {
  const grantType = objectTypeOf('grant');
  const capabilityType = objectTypeOf('capability');
  const bindingType = objectTypeOf('role_binding');
  return [...revisionByRole].flatMap(([roleId, revision]) => {
    const bindingObject = roleBindingObjectId(tenantId, scopeId, roleId);
    return revision.cells.flatMap((cell) => {
      const capabilityObject = capabilityObjectId(tenantId, scopeId, cell.capabilityKey);
      const grantObject = grantObjectId(tenantId, scopeId, roleId, cell);
      const caveat = cellCaveat(cell);
      return [
        relate(grantType, grantObject, 'capability', objectSubject(capabilityType, capabilityObject)),
        relate(
          grantType,
          grantObject,
          'binding',
          objectSubject(bindingType, bindingObject),
          caveat === undefined ? {} : { caveat },
        ),
        relate(capabilityType, capabilityObject, capabilitySlotRelation(cell), objectSubject(grantType, grantObject)),
      ];
    });
  });
};

/**
 * Capability objects outlive an uninstall: only the installation link goes away, so configuration
 * survives, a reinstall restores it, and nothing revoked comes back (guarantee 8).
 */
const capabilityRelationships = (
  tenantId: string,
  scopeId: string,
  scopeObject: string,
  installedModules: ReadonlySet<string>,
  entries: CatalogEntries,
  liveDelegations: ScopeProjectionIntent['delegations'],
  revisionByRole: ReadonlyMap<string, RoleRevision>,
): readonly AccessRelationship[] => {
  const capabilityType = objectTypeOf('capability');
  const scopeSubject = objectSubject(objectTypeOf('scope'), scopeObject);
  const capabilityKeys = new Set<string>(
    [...revisionByRole.values()].flatMap((revision) => revision.cells.map((cell) => cell.capabilityKey)),
  );
  const relationships: AccessRelationship[] = [];
  for (const capabilityKey of capabilityKeys) {
    const capabilityObject = capabilityObjectId(tenantId, scopeId, capabilityKey);
    relationships.push(relate(capabilityType, capabilityObject, 'scope', scopeSubject));
    const moduleKey = owningModuleOf(entries, capabilityKey);
    if (moduleKey !== undefined && installedModules.has(moduleKey)) {
      relationships.push(
        relate(
          capabilityType,
          capabilityObject,
          'installation',
          objectSubject(objectTypeOf('installation'), installationObjectId(tenantId, scopeId, moduleKey)),
        ),
      );
    }
    for (const delegation of liveDelegations) {
      if (new Set<string>(delegation.capabilityKeys).has(capabilityKey)) {
        relationships.push(
          relate(
            capabilityType,
            capabilityObject,
            'delegated_manager',
            objectSubject(objectTypeOf('delegation'), delegationObjectId(tenantId, scopeId, delegation.id)),
          ),
        );
      }
    }
  }
  return relationships;
};

const installationRelationships = (
  tenantId: string,
  scopeId: string,
  scopeObject: string,
  installedModules: ReadonlySet<string>,
): readonly AccessRelationship[] =>
  [...installedModules].map((moduleKey) =>
    relate(
      objectTypeOf('installation'),
      installationObjectId(tenantId, scopeId, moduleKey),
      'enabled_scope',
      objectSubject(objectTypeOf('scope'), scopeObject),
    ),
  );

const connectionCeilingsOf = (
  tenantId: string,
  scopeId: string,
  connections: ScopeProjectionIntent['connections'],
): readonly ProjectedConnectionCeiling[] =>
  connections.flatMap((connection): readonly ProjectedConnectionCeiling[] =>
    connection.status === 'active'
      ? [
          {
            agentId: connection.agentId,
            connectionId: connection.id,
            principalId: connection.principalId,
            scopeId,
            tenantId,
            validUntil: connection.validUntil,
          },
        ]
      : [],
  );

/**
 * An agent may propose a sensitive or critical capability but never run it (O48a): the graph cannot
 * express that difference in one cell, so Core refuses to write the cell instead.
 */
const validateAgentRunCells = (
  activeAssignments: ScopeProjectionIntent['assignments'],
  revisionByRole: ReadonlyMap<string, RoleRevision>,
  entries: CatalogEntries,
  fail: Failure,
): void => {
  const agentHeldRoles = new Set<string>(
    activeAssignments
      .filter((assignment) => principalIdOf(assignment.holder) === undefined)
      .map((assignment) => assignment.roleId),
  );
  for (const roleId of agentHeldRoles) {
    for (const cell of revisionByRole.get(roleId)?.cells ?? []) {
      if (cell.mode !== 'run') {
        continue;
      }
      const risk = entries.get(cell.capabilityKey)?.risk;
      if (risk === undefined) {
        fail(
          'access_projection_agent_sensitive_run',
          `${cell.capabilityKey} declares no risk, so an agent run cell cannot be shown to be routine`,
        );
      } else if (risk !== 'routine') {
        fail(
          'access_projection_agent_sensitive_run',
          `${cell.capabilityKey} is ${risk}, and an agent may only propose it`,
        );
      }
    }
  }
};

interface PlannedScope {
  readonly connections: readonly ProjectedConnectionCeiling[];
  readonly relationshipUnits: readonly ProjectionUnit[];
}

const planScopeUnit = (
  tenantId: string,
  tenantObject: string,
  intent: ScopeProjectionIntent,
  legalEntityObjects: ReadonlyMap<string, string>,
  entries: CatalogEntries,
  violations: AccessProjectionError[],
): PlannedScope => {
  const scopeId = intent.scope.id;
  const scopeObject = scopeObjectId(tenantId, scopeId);
  const fail: Failure = (code, reason) => {
    violations.push(new AccessProjectionError({ code, reason, unit: projectionUnitLabel(`scope:${scopeObject}`) }));
  };

  const legalEntityObject = validateScopeIdentity(tenantId, intent, legalEntityObjects, fail);
  validateScopeMembership(tenantId, scopeId, intent, fail);
  const activeAssignments = intent.assignments.filter((assignment) => assignment.status === 'active');
  const revisionByRole = resolvePinnedRevisions(intent, activeAssignments, entries, fail);
  const revisionById = new Map<string, RoleRevision>(
    intent.roleRevisions.map((revision): [string, RoleRevision] => [revision.id, revision]),
  );
  const liveDelegations = intent.delegations.filter((delegation) => delegation.status === 'active');
  const liveDelegationsById = new Map<string, ScopeProjectionIntent['delegations'][number]>(
    liveDelegations.map((delegation): [string, ScopeProjectionIntent['delegations'][number]] => [
      delegation.id,
      delegation,
    ]),
  );
  for (const assignment of activeAssignments) {
    validateDelegatedAssignment(assignment, liveDelegationsById, revisionByRole, entries, fail);
  }
  const moduleKeys = new Set<string>();
  validateAgentRunCells(activeAssignments, revisionByRole, entries, fail);

  for (const installation of intent.installations) {
    if (moduleKeys.has(installation.moduleKey)) {
      fail('access_projection_duplicate_intent', `Module ${installation.moduleKey} is installed twice in one scope`);
    }
    moduleKeys.add(installation.moduleKey);
  }
  const relationships = [
    ...scopeRelationships(scopeObject, tenantObject, legalEntityObject),
    ...installationRelationships(tenantId, scopeId, scopeObject, moduleKeys),
    ...delegationRelationships(tenantId, scopeId, scopeObject, liveDelegations),
    ...assignmentRelationships(tenantId, scopeId, scopeObject, activeAssignments, revisionById),
    ...grantRelationships(tenantId, scopeId, revisionByRole),
    ...capabilityRelationships(tenantId, scopeId, scopeObject, moduleKeys, entries, liveDelegations, revisionByRole),
  ];
  return {
    connections: connectionCeilingsOf(tenantId, scopeId, intent.connections),
    relationshipUnits: [unit('scope', scopeObject, relationships, fail)],
  };
};

/**
 * Compiles intent into the exact relationship set, one plan per write unit. Every Core writer
 * invariant is checked here, before a scope fence is taken and before anything is written.
 *
 * The intent is complete for every tenant it names: the tenant unit is reconciled whole, so an intent
 * that omits a member, owner, legal entity or scope states that the graph must not have it. `coverage`
 * makes that a type requirement, and verification compares each unit against the whole intent (D13).
 */
export const planAccessProjection = (
  intent: AccessProjectionIntent,
): Result.Result<ProjectionPlan, readonly AccessProjectionError[]> => {
  const violations: AccessProjectionError[] = [];
  const units: ProjectionUnit[] = [];
  const connectionCeilings: ProjectedConnectionCeiling[] = [];
  const fences: ProjectionFenceScope[] = [];
  const seenTenants = new Set<string>();

  for (const tenant of intent.tenants) {
    const { tenantId } = tenant;
    const tenantObject = tenantObjectId(tenantId);
    if (seenTenants.has(tenantId)) {
      violations.push(
        new AccessProjectionError({
          code: 'access_projection_duplicate_intent',
          reason: 'The intent lists the same tenant twice',
          unit: `tenant:${tenantObject}`,
        }),
      );
      continue;
    }
    seenTenants.add(tenantId);
    const firstUnitIndex = units.length;
    const entries = new Map<string, CatalogEntryProjectionIntent>();
    for (const entry of tenant.catalogEntries) {
      if (entries.has(entry.key)) {
        violations.push(
          new AccessProjectionError({
            code: 'access_projection_duplicate_intent',
            reason: `The intent lists catalog entry ${entry.key} twice`,
            unit: `tenant:${tenantObject}`,
          }),
        );
        continue;
      }
      entries.set(entry.key, entry);
    }
    const failTenant: Failure = (code, reason) => {
      violations.push(new AccessProjectionError({ code, reason, unit: projectionUnitLabel(`tenant:${tenantObject}`) }));
    };
    units.push(planTenantUnit(tenantObject, tenant, failTenant));

    const legalEntityObjects = new Map<string, string>();
    const seenScopes = new Set<string>();
    for (const entity of tenant.legalEntities) {
      const entityObject = legalEntityObjectId(tenantId, entity.legalEntityId);
      if (legalEntityObjects.has(entity.legalEntityId)) {
        violations.push(
          new AccessProjectionError({
            code: 'access_projection_duplicate_intent',
            reason: 'The intent lists the same legal entity twice',
            unit: `legal_entity:${entityObject}`,
          }),
        );
        continue;
      }
      legalEntityObjects.set(entity.legalEntityId, entityObject);
      units.push(planLegalEntityUnit(tenantObject, entityObject, entity, failTenant));
    }

    for (const scopeIntent of tenant.scopes) {
      const scopeId = scopeIntent.scope.id;
      const scopeObject = scopeObjectId(tenantId, scopeId);
      if (seenScopes.has(scopeId)) {
        violations.push(
          new AccessProjectionError({
            code: 'access_projection_duplicate_intent',
            reason: 'The intent lists the same scope twice',
            unit: `scope:${scopeObject}`,
          }),
        );
        continue;
      }
      seenScopes.add(scopeId);
      fences.push({ scopeId, tenantId });
      const planned = planScopeUnit(tenantId, tenantObject, scopeIntent, legalEntityObjects, entries, violations);
      units.push(...planned.relationshipUnits);
      connectionCeilings.push(...planned.connections);
    }

    for (const plannedUnit of units.slice(firstUnitIndex)) {
      const failUnit: Failure = (code, reason) => {
        violations.push(new AccessProjectionError({ code, reason, unit: projectionUnitLabel(plannedUnit.key) }));
      };
      validatePrincipalKinds(plannedUnit.relationships, tenant.principals, failUnit);
      validateProjectableIds(plannedUnit, failUnit);
    }
  }

  return violations.length > 0
    ? Result.fail(violations)
    : Result.succeed({
        connectionCeilings,
        fences,
        lines: units.flatMap((planned) =>
          planned.relationships.map((relationship) => `${planned.key}|${relationshipKey(relationship)}`),
        ),
        units,
      });
};
