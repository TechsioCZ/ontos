import { PartyRefSchema } from '@app/party-registry/resources/party';
import type { PartyRef } from '@app/party-registry/resources/party';
import { Schema } from 'effect';

import { SellingLegalEntityRefSchema } from '../../../shared/domain/profile-contracts.ts';
import { EnrollmentDigestSchema, enrollmentDigest } from '../../../shared/enrollment-contracts.ts';
import { RetailPortalPrincipalRefSchema } from '../../../shared/resources/retail-portal-profile-binding.ts';
import {
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../orchestration/prepared-owner-authority.ts';
import type { JourneyDefinition, JourneyTransitionSpec } from './journey-contracts.ts';

/**
 * Retail self-enrollment vocabulary.
 *
 * The journey composes four owner transitions, each dispatched through the generic owner
 * transition driver so that it has its own durable claim, its own stable transition key and its
 * own request digest.  Nothing in this module performs an owner effect: it declares the plan and
 * derives the stable identities an equivalent retry must reproduce exactly.
 *
 * The journey deliberately carries no Guest history claim, no email-based continuity and no
 * inferred ownership.  The Party Registry candidate submission is the only source of a Retail
 * Party identity, and an ambiguous candidate halts into reconciliation instead of choosing one.
 */

/** Owner module that owns Party identity: candidate submission, matching and Party creation. */
export const PARTY_REGISTRY_OWNER_MODULE_KEY = 'party.registry';
/** One owner transition covers the whole candidate submission (match, then create on NO_MATCH). */
export const PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY = 'party.candidate.submit';
/** Owner module that owns the Commerce Retail Customer Profile and its Retail Portal binding. */
export const COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY = 'commerce.customer-context';
/** Transition keys are the exact generated Action keys these transitions invoke. */
export const ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY = 'commerce.customer-context.ensure-retail-customer-profile';
/**
 * The Retail Portal Profile Binding Action durably stages the reviewed Retail Portal
 * Self-Service Permission baseline in the same transaction as the binding and publishes the
 * authorization-mutation message the grants owner consumes.  This vertical has no separate retail
 * grant Action — `grant-counterparty-commerce-access` is the Counterparty path — so the binding
 * transition is the retail grant path and the journey records its authorization state rather than
 * inventing a fifth transition that nothing owns.
 */
export const BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY = 'commerce.customer-context.bind-retail-portal-profile';

/** Owner outcome codes this journey interprets.  They are owner data, never caller input. */
export const PARTY_CANDIDATE_MATCHED_OUTCOME_CODE = 'party_candidate_matched';
export const PARTY_CANDIDATE_CREATED_OUTCOME_CODE = 'party_candidate_created';
/** An ambiguous Party candidate is a typed non-terminal halt, never a failed enrollment. */
export const PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE = 'party_candidate_ambiguous';
export const RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE = 'retail_customer_profile_ensured';
export const RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE = 'retail_portal_profile_bound';
/** The binding committed but did not stage the complete reviewed baseline. */
export const RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE = 'retail_portal_grants_incomplete';
/** Failure code recorded with every halt that waits on a decision rather than on a retry. */
export const OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE = 'owner_reconciliation_required';

const RETAIL_SELF_ENROLLMENT_REQUIRED_TRANSITIONS: readonly JourneyTransitionSpec[] = [
  {
    ownerModuleKey: PORTAL_AUTH_OWNER_MODULE_KEY,
    required: true,
    transitionKey: PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  },
  {
    ownerModuleKey: PARTY_REGISTRY_OWNER_MODULE_KEY,
    required: true,
    transitionKey: PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  },
  {
    ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
    required: true,
    transitionKey: ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  },
  {
    ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
    required: true,
    transitionKey: BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  },
];

/**
 * Every transition of Retail self-enrollment gates completion.  A Retail Portal Profile Binding
 * without the Customer Profile, or a Principal Auth Binding without the portal binding, is an
 * incomplete journey and must never project as COMPLETE.
 */
export const retailSelfEnrollmentJourneyDefinition: JourneyDefinition = {
  kind: 'RETAIL_SELF_ENROLLMENT',
  optionalTransitions: [],
  requiredTransitions: RETAIL_SELF_ENROLLMENT_REQUIRED_TRANSITIONS,
};

/** The ordered dispatch plan.  Each step consumes the previous step's durable owner outcome. */
export const retailSelfEnrollmentStepPlan = (): readonly JourneyTransitionSpec[] =>
  retailSelfEnrollmentJourneyDefinition.requiredTransitions;

/**
 * Stable business intent of one Retail self-enrollment transition.  It carries no credential, no
 * provider payload and no timestamp, so an equivalent retry produces an identical digest and the
 * durable owner operation is replayed instead of repeated.
 */
const RetailSelfEnrollmentStepIntentSchema = Schema.Union([
  Schema.Struct({
    sellingLegalEntityRef: SellingLegalEntityRefSchema,
    step: Schema.Literal('PORTAL_ACCOUNT'),
  }),
  Schema.Struct({
    /** Digest of the submitted Party candidate; the candidate itself never leaves its owner. */
    partyCandidateDigest: EnrollmentDigestSchema,
    sellingLegalEntityRef: SellingLegalEntityRefSchema,
    step: Schema.Literal('PARTY_CANDIDATE'),
  }),
  Schema.Struct({
    partyRef: PartyRefSchema,
    sellingLegalEntityRef: SellingLegalEntityRefSchema,
    step: Schema.Literal('RETAIL_CUSTOMER_PROFILE'),
  }),
  Schema.Struct({
    partyRef: PartyRefSchema,
    principalRef: RetailPortalPrincipalRefSchema,
    sellingLegalEntityRef: SellingLegalEntityRefSchema,
    step: Schema.Literal('RETAIL_PORTAL_BINDING'),
  }),
]).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type RetailSelfEnrollmentStepIntent = typeof RetailSelfEnrollmentStepIntentSchema.Type;

export interface RetailSelfEnrollmentDigestInput {
  readonly intent: RetailSelfEnrollmentStepIntent;
  readonly ownerModuleKey: string;
  readonly portalEnrollmentAttemptId: string;
  readonly transitionKey: string;
}

/**
 * Length-prefixed canonical encoding of an ordered list of primitives.  Object key order never
 * reaches the hash and no separator can be forged from a member's own content, so the digest is
 * byte-stable across runtimes and schema revisions.
 */
const canonical = (parts: readonly string[]): string =>
  parts.map((part) => `${String(part.length)}:${part}`).join('\u001F');

const digestParts = (input: RetailSelfEnrollmentDigestInput): readonly string[] => {
  const { intent } = input;
  const head = [
    'RETAIL_SELF_ENROLLMENT',
    input.portalEnrollmentAttemptId,
    input.ownerModuleKey,
    input.transitionKey,
    intent.step,
    intent.sellingLegalEntityRef.moduleId,
    intent.sellingLegalEntityRef.resourceType,
    intent.sellingLegalEntityRef.resourceId,
    intent.sellingLegalEntityRef.tenantId,
  ];
  if (intent.step === 'PORTAL_ACCOUNT') {
    return head;
  }
  if (intent.step === 'PARTY_CANDIDATE') {
    return [...head, intent.partyCandidateDigest];
  }
  const withParty = [
    ...head,
    intent.partyRef.moduleId,
    intent.partyRef.resourceType,
    intent.partyRef.resourceId,
    intent.partyRef.tenantId,
  ];
  return intent.step === 'RETAIL_CUSTOMER_PROFILE'
    ? withParty
    : [
        ...withParty,
        intent.principalRef.moduleId,
        intent.principalRef.resourceType,
        intent.principalRef.resourceId,
        intent.principalRef.tenantId,
      ];
};

/**
 * Deterministic lowercase SHA-256 digest of the canonical intent.  The same Attempt, transition
 * and subject always produce the same digest, so a retry reuses the exact durable owner operation
 * instead of creating a second Party, profile, binding or Permission grant.
 */
export const retailSelfEnrollmentRequestDigest = (input: RetailSelfEnrollmentDigestInput): string =>
  enrollmentDigest(canonical(digestParts(input)));

/**
 * Digest of the canonical facts of a Party candidate, so the candidate payload itself never has
 * to travel inside a Commerce digest input.
 */
export const retailPartyCandidateDigest = (candidateFacts: readonly string[]): string =>
  enrollmentDigest(canonical(candidateFacts));

const UUID_VARIANT_NIBBLES = ['8', '9', 'a', 'b'] as const;

/**
 * A deterministic, non-secret RFC 9562 version-8 evidence reference derived from the owner's own
 * exact result identifiers.  Reconciling the same owner operation twice therefore names the same
 * evidence instead of minting a fresh reference on every recovery, and the reference carries no
 * credential and no provider payload.
 */
export const retailSelfEnrollmentEvidenceReference = (parts: readonly string[]): string => {
  const raw = enrollmentDigest(canonical(parts)).slice(0, 32);
  const variantIndex = Number.parseInt(raw.slice(16, 17), 16) % UUID_VARIANT_NIBBLES.length;
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    `8${raw.slice(13, 16)}`,
    `${UUID_VARIANT_NIBBLES[variantIndex] ?? '8'}${raw.slice(17, 20)}`,
    raw.slice(20, 32),
  ].join('-');
};

/** Build the exact Party reference the owner result names, without trusting a caller-supplied one. */
export const retailPartyRefFor = (tenantId: string, partyResourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId: partyResourceId,
  resourceType: 'party.registry.party',
  tenantId,
});
