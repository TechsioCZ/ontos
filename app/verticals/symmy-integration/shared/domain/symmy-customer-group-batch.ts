import { ApplyCustomerGroupMembershipSourcePayloadSchema } from '@app/commerce-customer-context/api/apply-customer-group-membership-source-action';
import { CreateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/create-customer-group-action';
import { UpdateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/update-customer-group-action';
import { Schema } from 'effect';

import { SymmyCustomerRowSchema } from './symmy-customer-batch.ts';

/** A synchronous group plan and a membership job hold at most sixteen items: one per group or per customer. */
const SYMMY_CUSTOMER_GROUP_BATCH_MAX_ITEMS = 16;

/**
 * What every Symmy group write states about itself. The caller never supplies these values: they are named once and
 * owned by the Symmy integration, as the customer and address constants are.
 */
export const SYMMY_CUSTOMER_GROUP_REASON = 'Qualified Symmy source explicitly defines this customer group';
export const SYMMY_CUSTOMER_GROUP_SOURCE_REVISION_STEM = 'symmy-customer-group-revision';
export const SYMMY_GROUP_MEMBERSHIP_REASON =
  'Qualified Symmy source explicitly assigns this customer to the selected customer group';

const create = CreateCustomerGroupPayloadSchema.fields;
const update = UpdateCustomerGroupPayloadSchema.fields;
const definitionSource = create.source.schema.fields;

/**
 * One source-managed customer group as the owner admission receives it. `code` is the stable Symmy group code: the
 * source record and the source code the Commerce owner binds to one group. Every other field is the owner's own
 * create field and is stated by the source; the business code is never derived from the code, and the meaning is
 * never derived from a name.
 *
 * Symmy states no revision or time for a group, so the order in which OntOS admits requests is the order: each
 * admission asserts its code after the last assertion the owner holds, under a revision derived from its
 * Idempotency-Key. A delayed older request admitted later wins. Two requests for one code that overlap are planned
 * against the same owner state: the first to execute is accepted, the other is refused by the owner's revision and order
 * fence in its own result and stays refused under that key, so the source states the group again under a new key.
 *
 * A synchronous admission stores the plan it admitted, not the outcomes of its effects, and an exact retry of a key
 * reads no current definition again. An effect the owner committed is answered from the owner's receipt: indeterminate while
 * that read is unavailable, never a wrong result. The pinned original command is executed again only while the route may
 * still execute new effects and Core either recorded no invocation for an effect that was never acknowledged, or still
 * holds its invocation as received or running; an invocation in any other state is not executed again and answers
 * indeterminate. A key whose admission retention purged is refused.
 */
export const SymmyCustomerGroupRowSchema = Schema.Struct({
  businessCode: create.businessCode,
  code: definitionSource.recordId,
  description: create.description,
  meaningKey: create.meaningKey,
  membershipCriteria: create.membershipCriteria,
  name: create.name,
  purpose: create.purpose,
});
export type SymmyCustomerGroupRow = typeof SymmyCustomerGroupRowSchema.Type;

export const SymmyCustomerGroupRowsSchema = Schema.NonEmptyArray(SymmyCustomerGroupRowSchema).check(
  Schema.isMaxLength(SYMMY_CUSTOMER_GROUP_BATCH_MAX_ITEMS),
  Schema.makeFilter(
    (rows: readonly SymmyCustomerGroupRow[]) =>
      new Set(rows.map(({ code }) => code)).size === rows.length || 'Each customer group code appears once',
  ),
);
export type SymmyCustomerGroupRows = typeof SymmyCustomerGroupRowsSchema.Type;

/**
 * What the Commerce owner holds for a group code of the route's own source, read when the request arrived: the
 * group the code is bound to, its revision, business code and meaning, and the order of the binding's last source
 * assertion. A code the source never bound has no fact. A fact is the fence the plan is built against, never intent.
 */
export const SymmyCustomerGroupDefinitionFactSchema = Schema.Struct({
  businessCode: create.businessCode,
  code: definitionSource.recordId,
  groupRef: update.groupRef,
  meaningKey: create.meaningKey,
  revision: update.expectedRevision,
  sourceOrder: definitionSource.order,
});
export type SymmyCustomerGroupDefinitionFact = typeof SymmyCustomerGroupDefinitionFactSchema.Type;

export const SymmyCustomerGroupDefinitionFactsSchema = Schema.Array(SymmyCustomerGroupDefinitionFactSchema).check(
  Schema.isMaxLength(SYMMY_CUSTOMER_GROUP_BATCH_MAX_ITEMS),
  Schema.makeFilter(
    (facts: readonly SymmyCustomerGroupDefinitionFact[]) =>
      new Set(facts.map(({ code }) => code)).size === facts.length || 'Each customer group code has one fact',
  ),
);
export type SymmyCustomerGroupDefinitionFacts = typeof SymmyCustomerGroupDefinitionFactsSchema.Type;

/**
 * One customer of the group the path code selects, named by the source's own customer id: the `customerId` the same
 * source sent in `POST /customers/batch`. Symmy resolves it to the customer profile it created for that source record,
 * so the sender never reads an OntOS reference back. The group is never named here: the route enrollment binds it.
 */
export const SymmyGroupCustomerRowSchema = Schema.Struct({
  customerId: SymmyCustomerRowSchema.members[0].fields.customerId,
});
export type SymmyGroupCustomerRow = typeof SymmyGroupCustomerRowSchema.Type;

/** One to sixteen customers, each once. Assignment only: no removal, no replacement set. */
export const SymmyGroupCustomerRowsSchema = Schema.NonEmptyArray(SymmyGroupCustomerRowSchema).check(
  Schema.isMaxLength(SYMMY_CUSTOMER_GROUP_BATCH_MAX_ITEMS),
  Schema.makeFilter(
    (rows: readonly SymmyGroupCustomerRow[]) =>
      new Set(rows.map(({ customerId }) => customerId)).size === rows.length || 'Each customer appears once',
  ),
);
export type SymmyGroupCustomerRows = typeof SymmyGroupCustomerRowsSchema.Type;

/** A customer profile exactly as the Commerce owner names it in a membership. */
export const SymmyGroupMembershipProfileSchema =
  ApplyCustomerGroupMembershipSourcePayloadSchema.members[0].fields.profile;
export type SymmyGroupMembershipProfile = typeof SymmyGroupMembershipProfileSchema.Type;

/**
 * The text whose digest names the source record of one membership: the selected group's source record and the
 * customer's source record. The same customer of the same group is always the same record, whichever request asserts it.
 */
export const symmyGroupMembershipRecordSeed = (groupRecordId: string, customerRecordId: string): string =>
  ['group-membership', groupRecordId, customerRecordId].map((part) => `${part.length}:${part}`).join('');

/**
 * The text whose digest names the occurrence of one customer of a `POST /customer-groups/{code}/customers/batch`
 * request: the admitted route, the group it selects, the request's Idempotency-Key and the plan item. The owner keys a
 * membership assertion by profile and manager, which two group routes can share, so one key and position sent to two
 * routes names two assertions. A conformance suite seeds Privacy for this exact occurrence before it submits.
 */
export const symmyGroupMembershipOccurrenceSeed = ({
  groupId,
  idempotencyKey,
  itemKey,
  routeId,
}: {
  readonly groupId: string;
  readonly idempotencyKey: string;
  readonly itemKey: string;
  readonly routeId: string;
}): string =>
  ['group-membership-occurrence', routeId, groupId, idempotencyKey, itemKey]
    .map((part) => `${part.length}:${part}`)
    .join('');
