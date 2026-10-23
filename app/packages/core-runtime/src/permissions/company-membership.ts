import { v1 } from '@authzed/authzed-node';
import { Schema } from 'effect';

import { PrincipalRefSchema } from './principal-ref.ts';

const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CompanyMembershipLegalEntityId'),
  Schema.decodeTo(Schema.String),
);

/** A person's affiliation belongs to one company, never to their login or authorization role. */
export const CompanyAffiliationSchema = Schema.Literals(['employee', 'external']);
export type CompanyAffiliation = typeof CompanyAffiliationSchema.Type;

export const CompanyMembershipStatusSchema = Schema.Literals(['invited', 'active', 'disabled', 'departed']);
export type CompanyMembershipStatus = typeof CompanyMembershipStatusSchema.Type;

export const CompanyMembershipSchema = Schema.Struct({
  affiliation: Schema.OptionFromNullOr(CompanyAffiliationSchema),
  legalEntityId: LegalEntityIdSchema,
  principalRef: PrincipalRefSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  status: CompanyMembershipStatusSchema,
});
export type CompanyMembership = typeof CompanyMembershipSchema.Type;

/** Agents have no human affiliation. Technical workloads are not people-directory actors. */
export const isCompanyAffiliationValid = (kind: string, affiliation: CompanyAffiliation | null): boolean =>
  kind === 'human' ? affiliation !== null : kind === 'agent' && affiliation === null;

export type CompanyActorKind = CompanyAffiliation | 'agent';

export const companyActorKind = (
  kind: 'human' | 'agent',
  affiliation: CompanyAffiliation | null,
): CompanyActorKind | undefined => {
  if (kind === 'agent') {
    return affiliation === null ? 'agent' : undefined;
  }
  return affiliation ?? undefined;
};

/** Current, owner-verified SQL rows project access only; affiliation never creates a role or grant. */
export const buildCompanyMembershipUpdates = (input: {
  readonly affiliation: CompanyAffiliation | null;
  readonly companyActive: boolean;
  readonly kind: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly principalStatus: string;
  readonly status: CompanyMembershipStatus;
  readonly tenantActive: boolean;
}): readonly v1.RelationshipUpdate[] => [
  v1.RelationshipUpdate.create({
    operation:
      input.status === 'active' &&
      input.principalStatus === 'active' &&
      input.tenantActive &&
      input.companyActive &&
      isCompanyAffiliationValid(input.kind, input.affiliation)
        ? v1.RelationshipUpdate_Operation.TOUCH
        : v1.RelationshipUpdate_Operation.DELETE,
    relationship: {
      relation: 'member',
      resource: { objectId: input.legalEntityId, objectType: 'legal_entity' },
      subject: { object: { objectId: input.principalId, objectType: 'principal' } },
    },
  }),
];
