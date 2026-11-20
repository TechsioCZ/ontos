import { CreateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/create-customer-group-action';
import { UpdateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/update-customer-group-action';
import { Schema } from 'effect';

/** A synchronous group plan holds at most sixteen items: one per group. */
const SYMMY_CUSTOMER_GROUP_BATCH_MAX_ITEMS = 16;

/**
 * What every Symmy group write states about itself. The caller never supplies these values: they are named once and
 * owned by the Symmy integration, as the customer and address constants are.
 */
export const SYMMY_CUSTOMER_GROUP_REASON = 'Qualified Symmy source explicitly defines this customer group';
export const SYMMY_CUSTOMER_GROUP_SOURCE_REVISION_STEM = 'symmy-customer-group-revision';

const create = CreateCustomerGroupPayloadSchema.fields;
const update = UpdateCustomerGroupPayloadSchema.fields;
const definitionSource = create.source.schema.fields;

/**
 * One source-managed customer group as the owner admission receives it. `code` is the stable Symmy group code: the
 * source record and the source code the Commerce owner binds to one group. Every other field is the owner's own
 * create field and is stated by the source; the business code is never derived from the code, and the meaning is
 * never derived from a name.
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
