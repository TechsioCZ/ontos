import { ApplyCustomerGroupMembershipSourcePayloadSchema } from '@app/commerce-customer-context/api/apply-customer-group-membership-source-action';
import { CreateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/create-customer-group-action';
import { UpdateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/update-customer-group-action';
import { Schema } from 'effect';

/** A synchronous group plan and a membership job hold at most sixteen items: one per group or per customer. */
const SYMMY_CUSTOMER_GROUP_BATCH_MAX_ITEMS = 16;

/**
 * What every Symmy group write states about itself. The caller never supplies these values: they are named once and
 * owned by the Symmy integration, as the customer and address constants are.
 */
export const SYMMY_CUSTOMER_GROUP_REASON = 'Qualified Symmy source explicitly defines this customer group';
export const SYMMY_GROUP_MEMBERSHIP_REASON =
  'Qualified Symmy source explicitly assigns this customer profile to the selected customer group';
export const SYMMY_CUSTOMER_GROUP_SOURCE_REVISION_STEM = 'symmy-customer-group-revision';

const create = CreateCustomerGroupPayloadSchema.fields;
const update = UpdateCustomerGroupPayloadSchema.fields;
const definitionSource = create.source.schema.fields;
const [membershipAssignment] = ApplyCustomerGroupMembershipSourcePayloadSchema.members;

const distinctBy =
  <Row>(key: (row: Row) => string, message: string) =>
  (rows: readonly Row[]): true | string =>
    new Set(rows.map(key)).size === rows.length || message;

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
  Schema.makeFilter(distinctBy(({ code }: SymmyCustomerGroupRow) => code, 'Each customer group code appears once')),
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
    distinctBy(({ code }: SymmyCustomerGroupDefinitionFact) => code, 'Each customer group code has one fact'),
  ),
);
export type SymmyCustomerGroupDefinitionFacts = typeof SymmyCustomerGroupDefinitionFactsSchema.Type;

/**
 * The lower-case form of a profile UUID. The owner orders membership receipts per profile, so two spellings of one
 * profile must be one lineage before any order is chosen for either.
 */
export const canonicalSymmyProfileId = (resourceId: string): string => resourceId.toLowerCase();

/**
 * One customer profile of the selected group, exactly as the Commerce owner names it in a membership. The group is
 * never named here: the route enrollment the path code selects binds it. The owner stores a profile as a UUID, so any
 * other reference is refused before admission instead of reaching the owner.
 */
export const SymmyGroupCustomerRowSchema = Schema.Struct({ profile: membershipAssignment.fields.profile }).check(
  Schema.makeFilter(({ profile }) =>
    Schema.is(Schema.String.check(Schema.isUUID()))(profile.profileRef.resourceId)
      ? undefined
      : 'A customer profile reference is a UUID',
  ),
);
export type SymmyGroupCustomerRow = typeof SymmyGroupCustomerRowSchema.Type;

export const SymmyGroupCustomerRowsSchema = Schema.NonEmptyArray(SymmyGroupCustomerRowSchema).check(
  Schema.isMaxLength(SYMMY_CUSTOMER_GROUP_BATCH_MAX_ITEMS),
  Schema.makeFilter(
    distinctBy(
      ({ profile }: SymmyGroupCustomerRow) => canonicalSymmyProfileId(profile.profileRef.resourceId),
      'Each customer profile appears once',
    ),
  ),
);
export type SymmyGroupCustomerRows = typeof SymmyGroupCustomerRowsSchema.Type;

type SymmyGroupCustomerProfile = SymmyGroupCustomerRow['profile'];
const canonicalProfile = (profile: SymmyGroupCustomerProfile): SymmyGroupCustomerProfile => {
  const resourceId = canonicalSymmyProfileId(profile.profileRef.resourceId);
  return profile.profileKind === 'RETAIL'
    ? { profileKind: 'RETAIL', profileRef: { ...profile.profileRef, resourceId } }
    : { profileKind: 'COUNTERPARTY', profileRef: { ...profile.profileRef, resourceId } };
};

/** The rows with every profile in canonical form: one lineage, one owner key and one caller intent per profile. */
export const canonicalSymmyGroupCustomers = (rows: SymmyGroupCustomerRows): SymmyGroupCustomerRows => [
  { profile: canonicalProfile(rows[0].profile) },
  ...rows.slice(1).map(({ profile }) => ({ profile: canonicalProfile(profile) })),
];

/**
 * The text whose digest names the source record of one membership: the selected group's source record and the
 * canonical profile. The same profile of the same group is always the same record, whichever request asserts it.
 */
export const symmyGroupMembershipRecordSeed = (groupRecordId: string, profileId: string): string =>
  ['group-membership', groupRecordId, canonicalSymmyProfileId(profileId)]
    .map((part) => `${part.length}:${part}`)
    .join('');
