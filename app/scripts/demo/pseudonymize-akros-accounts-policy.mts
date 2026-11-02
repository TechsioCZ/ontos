import { createHash } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import { Array as Arr, Effect, Option, Order, Schema } from 'effect';

import type { CompanyAgentDirectoryResultSchema } from '../../packages/core-runtime/src/auth/company-agent-directory-read.ts';
import { AgentProfileSchema } from '../../packages/core-runtime/src/modules/actions/configure-agent.action.ts';
import {
  fromScopedRoleObjectId,
  toScopedRoleObjectId,
} from '../../packages/core-runtime/src/permissions/scoped-role.ts';

import { demoId, demoTenantId } from './fixture-ids.mts';

export class AccountPseudonymError extends Schema.TaggedError<AccountPseudonymError>()('AccountPseudonymError', {
  reason: Schema.String,
}) {}
export const accountPseudonymFailure = (reason: string) => new AccountPseudonymError({ reason });
export const accountPlanFingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

const uuid = Schema.String.check(Schema.isUUID());
const PrincipalId = Schema.toEncoded(uuid.pipe(Schema.brand('PseudonymPrincipalId')));
const LegalEntityId = Schema.toEncoded(uuid.pipe(Schema.brand('PseudonymLegalEntityId')));
const TenantId = Schema.toEncoded(uuid.pipe(Schema.brand('PseudonymTenantId')));
const AuthBindingId = Schema.toEncoded(uuid.pipe(Schema.brand('PseudonymAuthBindingId')));
const EmployeeId = Schema.toEncoded(uuid.pipe(Schema.brand('PseudonymEmployeeId')));
/** Workforce rows may be unlinked; `null` is the Workforce wire encoding of "no account". */
const OptionalPrincipalId = Schema.OptionFromNullOr(PrincipalId);

export const PseudonymEmployeeSchema = Schema.Struct({
  email: Schema.String,
  fullName: Schema.String,
  id: EmployeeId,
  newPrincipalId: OptionalPrincipalId,
  oldEmail: Schema.String,
  oldFullName: Schema.String,
  oldPrincipalId: OptionalPrincipalId,
});
export type PseudonymEmployee = typeof PseudonymEmployeeSchema.Type;
export const PseudonymRoleSchema = Schema.Struct({
  legalEntityId: Schema.optionalKey(LegalEntityId),
  roleKey: Schema.toEncoded(Schema.String.pipe(Schema.brand('PseudonymRoleKey'))),
  tenantId: TenantId,
});
export type PseudonymRole = typeof PseudonymRoleSchema.Type;
export const PseudonymAccountSchema = Schema.Struct({
  displayName: Schema.String,
  email: Schema.String,
  memberships: Schema.Array(
    Schema.Struct({
      affiliation: Schema.Literals(['employee', 'external']),
      legalEntityId: LegalEntityId,
      revision: Schema.Int,
      status: Schema.Literal('active'),
    }),
  ),
  newAuthBindingId: AuthBindingId,
  newPrincipalId: PrincipalId,
  oldDisplayName: Schema.String,
  oldEmail: Schema.String,
  oldPrincipalId: PrincipalId,
  relationships: Schema.Array(Schema.String),
  roles: Schema.Array(PseudonymRoleSchema),
});
export type PseudonymAccount = typeof PseudonymAccountSchema.Type;
/** A company agent owned or operated by a migrated login; its audited profile is kept except the owner. */
export const PseudonymAgentSchema = Schema.Struct({
  agentPrincipalId: PrincipalId,
  description: AgentProfileSchema.fields.description,
  displayName: Schema.String,
  legalEntityId: LegalEntityId,
  modules: AgentProfileSchema.fields.modules,
  newOwnerPrincipalId: OptionalPrincipalId,
  oldOperatorPrincipalIds: Schema.Array(PrincipalId),
  oldOwnerPrincipalId: OptionalPrincipalId,
  operatorRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  writePolicy: AgentProfileSchema.fields.writePolicy,
});
export type PseudonymAgent = typeof PseudonymAgentSchema.Type;
export const PseudonymAccountPlanSchema = Schema.Struct({
  accounts: Schema.Array(PseudonymAccountSchema),
  agents: Schema.Array(PseudonymAgentSchema),
  employees: Schema.Array(PseudonymEmployeeSchema),
  operatorPrincipalId: PrincipalId,
  schemaVersion: Schema.Literal(2),
  tenantId: Schema.Literal(demoTenantId),
});
export type PseudonymAccountPlan = typeof PseudonymAccountPlanSchema.Type;
export const sameAccounts = Schema.toEquivalence(Schema.Array(PseudonymAccountSchema));

/** Never infer an AKROS playground identity or migrate the overarching demo administrator. */
export const isPseudonymSource = (email: string, displayName: string) =>
  email !== 'obchod@demo.ontos' &&
  !email.endsWith('@akros.playground') &&
  (email.toLowerCase().endsWith('@akros.demo') || /akros/iu.test(displayName));

/** Seed keys of the fixed personas; every other synthetic address keeps a stable per-address key. */
const pseudonymKeys = new Map([
  ['eshop', 'sroubarna-eshop'],
  ['expedice', 'sroubarna-expedice'],
  ['warmup', 'warmup-sroubarna'],
]);

export const pseudonymAccountIdentity = (email: string, displayName: string) => {
  const local = email.slice(0, email.indexOf('@')).toLowerCase();
  const key = pseudonymKeys.get(local) ?? `sroubarna-account:${email.toLowerCase()}`;
  return {
    displayName:
      local === 'warmup' ? 'Stage warm-up (read only) · sroubarna' : displayName.replaceAll(/akros/giu, 'ŠroubShop'),
    email: `${local}@sroubarna.demo`,
    newAuthBindingId: demoId('core.auth-binding', key),
    newPrincipalId: demoId('core.principal', key),
  };
};

export const pseudonymRoleId = (id: string) => {
  const role = fromScopedRoleObjectId(id);
  return Option.isSome(role) && role.value.tenantId === demoTenantId && /akros/iu.test(role.value.roleKey)
    ? toScopedRoleObjectId({ ...role.value, roleKey: role.value.roleKey.replaceAll(/akros/giu, 'sroubarna') })
    : id;
};

/** Principal self/tenant structure is identity, so its resource ID follows the new identity; roles follow renames. */
const remappedResource = (resource: v1.ObjectReference, oldId: string, newId: string): v1.ObjectReference => {
  if (resource.objectType === 'principal' && resource.objectId === oldId) {
    return { ...resource, objectId: newId };
  }
  if (resource.objectType === 'scoped_role') {
    return { ...resource, objectId: pseudonymRoleId(resource.objectId) };
  }
  return resource;
};

/** Copy every exact subject grant, including scoped-role membership and resource-level grants.
 * Conditional or expiring policy must be reviewed separately, never silently made unconditional.
 */
export const remapAccountRelationships = Effect.fn('PseudonymAccount.remapRelationships')(function* remapRelationships(
  rows: readonly v1.Relationship[],
  oldId: string,
  newId: string,
) {
  const result: v1.Relationship[] = [];
  for (const row of rows) {
    if (
      row.resource === undefined ||
      row.subject?.object?.objectType !== 'principal' ||
      row.subject.object.objectId !== oldId ||
      row.subject.optionalRelation !== '' ||
      row.optionalCaveat !== undefined ||
      row.optionalExpiresAt !== undefined
    ) {
      return yield* accountPseudonymFailure('Source grants are incomplete, conditional or expiring; review required');
    }
    result.push(
      v1.Relationship.create({
        ...row,
        resource: remappedResource(row.resource, oldId, newId),
        subject: { ...row.subject, object: { ...row.subject.object, objectId: newId } },
      }),
    );
  }
  return result;
});

/** Every scoped-role assignment (tenant and company scope) of one principal, deduplicated, demo tenant only. */
export const scopedRoleAssignments = Effect.fn('PseudonymAccount.scopedRoleAssignments')(function* roleAssignments(
  rows: readonly v1.Relationship[],
) {
  const roles = new Map<string, PseudonymRole>();
  for (const edge of rows) {
    if (edge.resource?.objectType === 'scoped_role' && edge.relation === 'member') {
      const role = fromScopedRoleObjectId(edge.resource.objectId);
      if (Option.isNone(role) || role.value.tenantId !== demoTenantId) {
        return yield* accountPseudonymFailure('Account has a malformed or foreign-tenant role assignment');
      }
      roles.set(edge.resource.objectId, role.value);
    }
  }
  return Arr.sort(
    [...roles.entries()],
    Order.mapInput(Order.String, ([id]: readonly [string, PseudonymRole]) => id),
  ).map(([, role]) => role);
});

/** Agent operator edges belong to the governed operator command and its projection; they are never copied. */
export const isAgentOperatorEdge = (edge: v1.Relationship, principalId: string) =>
  edge.resource?.objectType === 'principal' && edge.relation === 'operator' && edge.resource.objectId !== principalId;

const sortedIds = (ids: readonly string[]) => Arr.sort([...new Set(ids)], Order.String);
const migratedPrincipal = (accounts: readonly PseudonymAccount[], principalId: string) =>
  accounts.find(({ oldPrincipalId }) => oldPrincipalId === principalId)?.newPrincipalId ?? principalId;

type DirectoryAgent = (typeof CompanyAgentDirectoryResultSchema.Type)['agents'][number];

/** A company agent whose owner or operator is a migrated login moves to the new login; other agents stay untouched. */
export const pseudonymAgent = (
  agent: DirectoryAgent,
  legalEntityId: string,
  accounts: readonly PseudonymAccount[],
): Option.Option<PseudonymAgent> => {
  const old = new Set(accounts.map(({ oldPrincipalId }) => oldPrincipalId));
  const pending = agent.operatorCommand?.desiredOperatorPrincipalIds ?? [];
  const owner = Option.fromNullishOr(agent.ownerPrincipalId);
  const involved =
    (Option.isSome(owner) && old.has(owner.value)) ||
    [...agent.operatorPrincipalIds, ...pending].some((principalId) => old.has(principalId));
  if (!involved) {
    return Option.none();
  }
  return Option.some({
    agentPrincipalId: agent.principalId,
    description: agent.description,
    displayName: agent.displayName,
    legalEntityId,
    modules: agent.modules,
    newOwnerPrincipalId: owner.pipe(Option.map((principalId) => migratedPrincipal(accounts, principalId))),
    oldOperatorPrincipalIds: sortedIds(agent.operatorPrincipalIds),
    oldOwnerPrincipalId: owner,
    operatorRevision: agent.operatorCommand?.revision ?? 0,
    writePolicy: agent.writePolicy,
  });
};

/** Phase A adds the new login next to the old one, so the agent stays usable while both logins exist. */
export const agentOperatorsAfterCreate = (agent: PseudonymAgent, accounts: readonly PseudonymAccount[]) =>
  sortedIds([
    ...agent.oldOperatorPrincipalIds,
    ...agent.oldOperatorPrincipalIds.map((principalId) => migratedPrincipal(accounts, principalId)),
  ]);

/** Phase B leaves only the new logins (and every unrelated operator). */
export const agentOperatorsAfterRetire = (agent: PseudonymAgent, accounts: readonly PseudonymAccount[]) =>
  sortedIds(agent.oldOperatorPrincipalIds.map((principalId) => migratedPrincipal(accounts, principalId)));

const validAgent = (agent: PseudonymAgent, accounts: readonly PseudonymAccount[]) => {
  const old = new Set(accounts.map(({ oldPrincipalId }) => oldPrincipalId));
  return (
    Option.match(agent.newOwnerPrincipalId, { onNone: () => true, onSome: (principalId) => !old.has(principalId) }) &&
    agentOperatorsAfterRetire(agent, accounts).every((principalId) => !old.has(principalId)) &&
    (Option.exists(agent.oldOwnerPrincipalId, (principalId) => old.has(principalId)) ||
      agent.oldOperatorPrincipalIds.some((principalId) => old.has(principalId)))
  );
};

const validAccount = (row: PseudonymAccount) => {
  const identity = pseudonymAccountIdentity(row.oldEmail, row.oldDisplayName);
  return (
    isPseudonymSource(row.oldEmail, row.oldDisplayName) &&
    row.email.endsWith('@sroubarna.demo') &&
    !/akros/iu.test(row.displayName) &&
    row.newPrincipalId === identity.newPrincipalId &&
    row.newAuthBindingId === identity.newAuthBindingId &&
    row.email === identity.email &&
    row.displayName === identity.displayName &&
    row.newPrincipalId !== row.oldPrincipalId &&
    row.roles.every((role) => role.tenantId === demoTenantId) &&
    row.memberships.length > 0
  );
};

/** Collisions are a stop, never a merge between two people. */
export const validatePseudonymAccountPlan = (plan: PseudonymAccountPlan) => {
  const emails = plan.accounts.map(({ email }) => email);
  const ids = plan.accounts.map(({ newPrincipalId }) => newPrincipalId);
  return (
    plan.accounts.length > 0 &&
    new Set(emails).size === emails.length &&
    new Set(ids).size === ids.length &&
    new Set(plan.employees.map(({ id }) => id)).size === plan.employees.length &&
    new Set(plan.agents.map(({ agentPrincipalId }) => agentPrincipalId)).size === plan.agents.length &&
    plan.agents.every((agent) => validAgent(agent, plan.accounts)) &&
    plan.employees.every((row) => !/akros/iu.test(row.fullName) && !/@akros\.demo$/iu.test(row.email)) &&
    plan.accounts.every(validAccount)
  );
};
