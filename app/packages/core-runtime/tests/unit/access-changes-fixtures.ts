import { DateTime, Result, Schema } from 'effect';

import { AccessScopeIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import type { AccessScopeId, PrincipalId, TenantId } from '../../src/access/ids.ts';
import { expect } from 'effect-rstest';

import type { AdoptionTarget } from '../../src/access/changes/targets.ts';
import { AdoptionTargetSchema } from '../../src/access/changes/targets.ts';
import type { AdoptionSelection } from '../../src/access/changes/adoption.ts';
import { AdoptionSelectionSchema } from '../../src/access/changes/adoption.ts';
import { AccessConfigureBasisSchema } from '../../src/access/changes/authority.ts';
import type { AccessConfigureBasis } from '../../src/access/changes/authority.ts';
import type { RoleWithRevision } from '../../src/access/changes/role-edits.ts';
import type {
  AccessChangeDecision,
  AccessChangeItem,
  AccessScopeRecord,
  Assignment,
  CatalogSnapshot,
  CatalogSnapshotEntry,
  Cell,
  Delegation,
  Holder,
  Role,
  RoleRevision,
} from '../../src/access/model.ts';
import {
  ACCESS_MODEL_PARSE_OPTIONS,
  AccessChangeDecisionSchema,
  AccessChangeItemSchema,
  AccessScopeRecordSchema,
  AssignmentSchema,
  CatalogSnapshotEntrySchema,
  CatalogSnapshotSchema,
  CellSchema,
  DelegationSchema,
  HolderSchema,
  RoleRevisionSchema,
  RoleSchema,
} from '../../src/access/model.ts';
import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { AccessDeclarationSchema } from '../../src/authorization/access-declaration.ts';

/** Fixtures for the Access-changes unit tests: every value is decoded by the model's own schemas. */
const padded = (index: number): string => String(index).padStart(12, '0');

export const fixedId = (index: number): string => `00000000-0000-4000-8000-${padded(index)}`;
/** A fixed instant with no ambient clock: the same `Date` the model schema decodes everywhere. */
export const instant = (hour: number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, 3, hour)));
export const CATALOG_DIGEST = 'a'.repeat(64);

export const TENANT = fixedId(1);
export const SCOPE = fixedId(2);
export const CATALOG = fixedId(3);
export const PERSON = fixedId(4);
export const OTHER_PERSON = fixedId(5);
export const MANAGER = fixedId(6);
export const AGENT = fixedId(7);
export const LEGAL_ENTITY = fixedId(8);
export const OTHER_LEGAL_ENTITY = fixedId(9);
export const ROLE = fixedId(20);
export const OTHER_ROLE = fixedId(21);
export const BATCH = fixedId(30);

export const decodeWith = <Input, Type>(name: string, schema: Schema.Decoder<Type>, input: Input): Type => {
  const decoded = Schema.decodeUnknownResult(schema, ACCESS_MODEL_PARSE_OPTIONS)(input);
  if (Result.isFailure(decoded)) {
    throw new Error(`${name} fixture is invalid: ${decoded.failure.message}`);
  }
  return decoded.success;
};

/** Branded identities for the plan types that carry them. */
export const brandPrincipalId = (value: string): PrincipalId => decodeWith('principal id', PrincipalIdSchema, value);

export const brandScopeId = (value: string): AccessScopeId => decodeWith('scope id', AccessScopeIdSchema, value);

export const tenantIdValue = (value: string): TenantId => decodeWith('tenant id', TenantIdSchema, value);

/** A refusal of the Access-changes area as the assertions see it. */
export interface AccessChangesFailure {
  readonly code: string;
  readonly reason: string;
}

export const succeeded = <Value>(result: Result.Result<Value, AccessChangesFailure>): Value => {
  if (Result.isFailure(result)) {
    expect.unreachable(`unexpected failure ${result.failure.code}: ${result.failure.reason}`);
  }
  return result.success;
};

export const failureOf = <Value>(result: Result.Result<Value, AccessChangesFailure>): AccessChangesFailure => {
  expect(Result.isFailure(result)).toBe(true);
  return Result.isFailure(result) ? result.failure : { code: 'none', reason: 'expected a failure' };
};

export interface EntryInput {
  readonly amountInput?: string;
  readonly fieldClass?: string;
  readonly group?: string;
  readonly key: string;
  readonly kind?: string;
  readonly level?: string;
  readonly lineage?: { readonly renamedFrom?: readonly string[]; readonly splitFrom?: string };
  readonly modes?: readonly string[];
  readonly moduleKey?: string;
  readonly risk?: string;
  readonly selectors?: readonly string[];
}

export const entry = (input: EntryInput): CatalogSnapshotEntry => {
  const base = {
    key: input.key,
    kind: input.kind ?? 'action',
    modes: input.modes ?? ['run'],
    moduleKey: input.moduleKey ?? 'test',
    placement: { group: input.group ?? 'parties', level: input.level ?? 'basic' },
    risk: input.risk ?? 'routine',
    selectors: input.selectors ?? [],
  };
  const withFieldClass = input.fieldClass === undefined ? base : { ...base, fieldClass: input.fieldClass };
  const withAmountInput =
    input.amountInput === undefined ? withFieldClass : { ...withFieldClass, amountInput: input.amountInput };
  const value = input.lineage === undefined ? withAmountInput : { ...withAmountInput, lineage: input.lineage };
  return decodeWith('catalog entry', CatalogSnapshotEntrySchema, value);
};

export const snapshot = (entries: readonly CatalogSnapshotEntry[], index = 1): CatalogSnapshot =>
  decodeWith('catalog snapshot', CatalogSnapshotSchema, {
    digest: CATALOG_DIGEST,
    entries,
    id: fixedId(900 + index),
    publishedAt: instant(1),
  });

export const cell = (capabilityKey: string, mode = 'run', selector = 'all'): Cell =>
  decodeWith('cell', CellSchema, { capabilityKey, mode, selector: { _tag: selector } });

export const role = (
  input: {
    readonly id?: string;
    readonly legalEntityId?: string;
    readonly name?: string;
    readonly tenantId?: string;
  } = {},
): Role => {
  const base = {
    createdAt: instant(0),
    createdBy: PERSON,
    id: input.id ?? ROLE,
    name: input.name ?? 'Účetní',
    tenantId: input.tenantId ?? TENANT,
  };
  const value = input.legalEntityId === undefined ? base : { ...base, legalEntityId: input.legalEntityId };
  return decodeWith('role', RoleSchema, value);
};

export const roleRevision = (input: {
  readonly cells?: readonly Cell[];
  readonly createdAt?: Date;
  readonly id?: string;
  readonly revision?: number;
  readonly roleId?: string;
}): RoleRevision =>
  decodeWith('role revision', RoleRevisionSchema, {
    catalogSnapshotId: CATALOG,
    cells: input.cells ?? [],
    createdAt: input.createdAt ?? instant(0),
    createdBy: PERSON,
    id: input.id ?? fixedId(40),
    provenance: 'manual',
    revision: input.revision ?? 1,
    roleId: input.roleId ?? ROLE,
    tenantId: TENANT,
  });

/** A role with the revision that currently expresses its intent. */
export const roleState = (input: {
  readonly cells?: readonly Cell[];
  readonly legalEntityId?: string;
  readonly revision?: number;
  readonly revisionId?: string;
  readonly roleId?: string;
  readonly tenantId?: string;
}): RoleWithRevision => {
  const roleInput = {
    id: input.roleId ?? ROLE,
    tenantId: input.tenantId ?? TENANT,
  };
  const value = role(
    input.legalEntityId === undefined ? roleInput : { ...roleInput, legalEntityId: input.legalEntityId },
  );
  return {
    revision: roleRevision({
      cells: input.cells ?? [],
      id: input.revisionId ?? fixedId(40),
      revision: input.revision ?? 1,
      roleId: value.id,
    }),
    role: value,
  };
};

/** The same role identity as `ROLE`, branded by the model for previews and decisions. */
export const ROLE_ID = role({ id: ROLE }).id;

export const principalHolder = (principalId = PERSON): Holder =>
  decodeWith('principal holder', HolderSchema, { _tag: 'Principal', principalId });

export const agentHolder = (agentId = AGENT): Holder =>
  decodeWith('agent holder', HolderSchema, { _tag: 'Agent', agentId });

export const assignment = (
  input: {
    readonly holder?: Holder;
    readonly incarnationId?: string;
    readonly roleId?: string;
    readonly scopeId?: string;
    readonly status?: string;
    readonly validFrom?: Date;
    readonly validUntil?: Date;
  } = {},
): Assignment => {
  const base = {
    assignedAt: instant(0),
    assignedBy: PERSON,
    holder: input.holder ?? principalHolder(),
    incarnationId: input.incarnationId ?? fixedId(50),
    roleId: input.roleId ?? ROLE,
    roleRevisionId: fixedId(40),
    scopeId: input.scopeId ?? SCOPE,
    status: input.status ?? 'active',
    tenantId: TENANT,
    validFrom: input.validFrom ?? instant(0),
  };
  const value = input.validUntil === undefined ? base : { ...base, validUntil: input.validUntil };
  return decodeWith('assignment', AssignmentSchema, value);
};

export const delegation = (
  input: {
    readonly amountCeiling?: { readonly currency: string; readonly limitMinor: number };
    readonly capabilityKeys?: readonly string[];
    readonly id?: string;
    readonly managerId?: string;
    readonly people?: readonly string[];
    readonly roleIds?: readonly string[];
    readonly scopeId?: string;
    readonly status?: string;
    readonly validUntil?: Date;
  } = {},
): Delegation => {
  const base = {
    capabilityKeys: input.capabilityKeys ?? ['test.party.note'],
    grantedBy: PERSON,
    id: input.id ?? fixedId(60),
    managerId: input.managerId ?? MANAGER,
    people: input.people ?? [OTHER_PERSON],
    roleIds: input.roleIds ?? [ROLE],
    scopeId: input.scopeId ?? SCOPE,
    status: input.status ?? 'active',
    tenantId: TENANT,
    validFrom: instant(0),
    validUntil: input.validUntil ?? instant(23),
  };
  const value = input.amountCeiling === undefined ? base : { ...base, amountCeiling: input.amountCeiling };
  return decodeWith('delegation', DelegationSchema, value);
};

export const ownerBasis = (): AccessConfigureBasis =>
  decodeWith('owner basis', AccessConfigureBasisSchema, { _tag: 'Owner' });

export const scopeAdminBasis = (input: {
  readonly legalEntityIds?: readonly string[];
  readonly tenantContext?: boolean;
}): AccessConfigureBasis =>
  decodeWith('scope admin basis', AccessConfigureBasisSchema, {
    _tag: 'ScopeAdmin',
    legalEntityIds: input.legalEntityIds ?? [],
    tenantContext: input.tenantContext ?? false,
  });

/** The scope a delegation manages. A tenant-context scope is the default, matching the tenant-wide roles. */
export const tenantScopeRecord = (id = SCOPE): AccessScopeRecord =>
  decodeWith('scope record', AccessScopeRecordSchema, {
    id,
    scope: { _tag: 'TenantContext', tenantId: TENANT },
  });

export const legalEntityScopeRecord = (input: { readonly id?: string; readonly legalEntityId?: string } = {}) =>
  decodeWith('scope record', AccessScopeRecordSchema, {
    id: input.id ?? SCOPE,
    scope: { _tag: 'LegalEntity', legalEntityId: input.legalEntityId ?? LEGAL_ENTITY, tenantId: TENANT },
  });

export const delegatedBasis = (
  basis: Delegation,
  scope: AccessScopeRecord = tenantScopeRecord(),
): AccessConfigureBasis =>
  decodeWith('delegated basis', AccessConfigureBasisSchema, { _tag: 'DelegatedManager', delegation: basis, scope });

export const adoptionTarget = (input: {
  readonly amountCeiling?: { readonly currency: string; readonly limitMinor: number };
  readonly modes?: readonly string[];
  readonly roleId?: string;
  readonly selector?: string;
}): AdoptionTarget => {
  const base = {
    modes: input.modes ?? ['run'],
    roleId: input.roleId ?? ROLE,
    selector: input.selector ?? 'all',
  };
  const value = input.amountCeiling === undefined ? base : { ...base, amountCeiling: input.amountCeiling };
  return decodeWith('adoption target', AdoptionTargetSchema, value);
};

export const selection = (itemId: string, targets: readonly AdoptionTarget[]): AdoptionSelection =>
  decodeWith('adoption selection', AdoptionSelectionSchema, { itemId, targets });

export const changeItem = (input: {
  readonly capabilityKey: string;
  readonly id?: string;
  readonly kind?: string;
  readonly lineageFrom?: readonly string[];
  readonly risk?: string;
  readonly status?: string;
  readonly suggestedRoleIds?: readonly string[];
}): AccessChangeItem =>
  decodeWith('change item', AccessChangeItemSchema, {
    capabilityKey: input.capabilityKey,
    catalogSnapshotId: CATALOG,
    createdAt: instant(2),
    id: input.id ?? fixedId(70),
    kind: input.kind ?? 'new',
    lineageFrom: input.lineageFrom ?? [],
    risk: input.risk ?? 'routine',
    status: input.status ?? 'pending',
    suggestedRoleIds: input.suggestedRoleIds ?? [ROLE],
    tenantId: TENANT,
  });

export const decision = (input: {
  readonly batchId?: string;
  readonly decision?: string;
  readonly id?: string;
  readonly itemId: string;
  readonly roleRevisionIds?: readonly string[];
  readonly undoesDecisionId?: string;
}): AccessChangeDecision => {
  const base = {
    batchId: input.batchId ?? BATCH,
    decidedAt: instant(3),
    decidedBy: PERSON,
    decision: input.decision ?? 'adopt',
    id: input.id ?? fixedId(80),
    itemId: input.itemId,
    roleRevisionIds: input.roleRevisionIds ?? [],
    tenantId: TENANT,
  };
  const value = input.undoesDecisionId === undefined ? base : { ...base, undoesDecisionId: input.undoesDecisionId };
  return decodeWith('change decision', AccessChangeDecisionSchema, value);
};

export interface DeclarationInput {
  readonly amountInput?: string;
  readonly fieldClass?: string;
  readonly group?: string;
  readonly key: string;
  readonly kind?: string;
  readonly level?: string;
  readonly lineage?: { readonly renamedFrom?: readonly string[]; readonly splitFrom?: string };
  readonly modes?: readonly string[];
  readonly risk?: string;
  readonly selectors?: readonly string[];
}

export const declaration = (input: DeclarationInput): AccessDeclarationInput => {
  const base = {
    key: input.key,
    kind: input.kind ?? 'action',
    modes: input.modes ?? ['run'],
    placement: { group: input.group ?? 'parties', level: input.level ?? 'basic' },
    risk: input.risk ?? 'routine',
    selectors: input.selectors ?? [],
  };
  const withFieldClass = input.fieldClass === undefined ? base : { ...base, fieldClass: input.fieldClass };
  const withAmountInput =
    input.amountInput === undefined ? withFieldClass : { ...withFieldClass, amountInput: input.amountInput };
  const value = input.lineage === undefined ? withAmountInput : { ...withAmountInput, lineage: input.lineage };
  return decodeWith('declaration', AccessDeclarationSchema, value);
};
