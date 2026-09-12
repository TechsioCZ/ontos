/* oxlint-disable effect-native/no-nullable-schema-field effect-native/no-unbranded-identifier-schema -- This adapter preserves the existing PostgreSQL profile wire shape while the parent owner adapter validates exact Tenant and profile identity before policy evaluation; expires: 2027-03-31. */
import { Context, Effect, Layer, Schema } from 'effect';

import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';

const ProfileStateSchema = Schema.Literals(['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
const ProfileKindSchema = Schema.Literals(['RETAIL', 'COUNTERPARTY']);
const RetailReactivationProfileSubjectSchema = Schema.Struct({
  attributionKind: Schema.String,
  kind: Schema.Literal('RETAIL'),
  partyResourceId: Schema.String,
  partyResourceRevision: Schema.NullOr(Schema.String),
});
const CounterpartyReactivationProfileSubjectSchema = Schema.Struct({
  counterpartyResourceId: Schema.String,
  counterpartyResourceRevision: Schema.NullOr(Schema.String),
  customerRoleResourceId: Schema.NullOr(Schema.String),
  customerRoleResourceRevision: Schema.NullOr(Schema.String),
  kind: Schema.Literal('COUNTERPARTY'),
});
const ReactivationProfileSubjectSchema = Schema.Union([
  RetailReactivationProfileSubjectSchema,
  CounterpartyReactivationProfileSubjectSchema,
]);

export const ReactivationProfileFactsSchema = Schema.Struct({
  profileId: Schema.String,
  profileKind: ProfileKindSchema,
  revision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  state: ProfileStateSchema,
  subject: ReactivationProfileSubjectSchema,
});

export type ReactivationProfileFacts = typeof ReactivationProfileFactsSchema.Type;

export type ReconfirmationEvaluator = (
  facts: ReactivationProfileFacts,
) => Effect.Effect<boolean, ProfilePersistenceDependencyFailure>;

export interface ProfileReconfirmationPolicyService {
  readonly evaluate: ReconfirmationEvaluator;
}

export class ProfileReconfirmationPolicy extends Context.Service<
  ProfileReconfirmationPolicy,
  ProfileReconfirmationPolicyService
>()('@app/commerce-customer-context/integrations/profile-reconfirmation-policy/ProfileReconfirmationPolicy') {}

const reconfirmationUnavailable: ReconfirmationEvaluator = () =>
  Effect.fail(
    new ProfilePersistenceDependencyFailure({
      reason: 'No verified Customer Profile reconfirmation policy is configured for reactivation',
    }),
  );

/** Explicit fail-closed policy used when a deployment has not supplied an owner policy. */
export const profileReconfirmationPolicyUnavailable: ProfileReconfirmationPolicyService = Object.freeze({
  evaluate: reconfirmationUnavailable,
});

export const profileReconfirmationPolicyUnavailableLive = Layer.succeed(
  ProfileReconfirmationPolicy,
  profileReconfirmationPolicyUnavailable,
);
