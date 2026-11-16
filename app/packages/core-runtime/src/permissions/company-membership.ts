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
