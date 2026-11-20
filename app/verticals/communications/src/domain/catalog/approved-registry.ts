import { Result, Schema } from 'effect';

import { TransactionalMessageTypeSchema } from './message-type.ts';
import type { TransactionalMessageType } from './message-type.ts';

const decodeType = Schema.decodeUnknownResult(TransactionalMessageTypeSchema, { onExcessProperty: 'error' });

/**
 * Source owner of the three Portal Auth message types: Commerce Portal Auth is the sole owner of issuance, token / OTP /
 * link, expiry, binding and recovery, and the only module that may issue a request for them (#1406, AUTH-COM-01).
 */
const PORTAL_AUTH_OWNER = 'commerce.customer-context';
/** The one source state in which an Auth issuance may still lead to a message; every other state stops it (expired, consumed, revoked). */
const PORTAL_AUTH_ISSUANCE_CURRENT = 'commerce.customer-context.portal-auth.issuance-current';
/** Each other state Auth reports means its own closed stop reason in the history (#1406); the names equal Auth's `PORTAL_AUTH_ISSUANCE_STATE`. */
const PORTAL_AUTH_INELIGIBLE_STATES = [
  { reason: 'SOURCE_CONSUMED', state: 'commerce.customer-context.portal-auth.issuance-consumed' },
  { reason: 'SOURCE_EXPIRED', state: 'commerce.customer-context.portal-auth.issuance-expired' },
  { reason: 'SOURCE_NOT_RESUMABLE', state: 'commerce.customer-context.portal-auth.issuance-not-resumable' },
  { reason: 'SOURCE_REVOKED', state: 'commerce.customer-context.portal-auth.issuance-revoked' },
  { reason: 'SOURCE_SUPERSEDED', state: 'commerce.customer-context.portal-auth.issuance-superseded' },
] as const;
/** Where the ORIGINAL recipient contact comes from: the endpoint Auth bound to the issuance, evidenced by its issuance-time snapshot. */
const PORTAL_AUTH_CONTACT = {
  contactOwner: PORTAL_AUTH_OWNER,
  contactResourceType: 'commerce.customer-context.portal-auth-endpoint',
  evidenceKinds: ['HISTORICAL_SNAPSHOT'],
} as const;

/**
 * One Portal Auth security message type. The three share every rule that is a security fact of Auth and differ only by
 * what they mean:
 * - REQUIRED: the account owner cannot proceed without it, so a stop is a failure to report and never a quiet skip;
 * - recovery `NONE` and resend `NOT_ALLOWED` (both absent = the defaults): only Auth itself may issue a NEW issuance or an
 *   Explicit Resend, and the Auth owner has approved neither, so no automatic second attempt and no resend exists;
 * - no documents: a security message never carries one.
 * The Privacy purpose reference is a PROPOSED name; its Privacy-owned values are an open input gate (see #1406 report).
 */
const portalAuthType = (flow: string, meaning: string): TransactionalMessageType =>
  // an approved type that does not satisfy its own schema is a defect of this build: it fails at module load, never silently
  Result.getOrThrow(
    decodeType({
      audience: { mode: 'INDIVIDUAL' },
      currentness: { requireLatestSourceRevision: true },
      eligibleSourceStates: [PORTAL_AUTH_ISSUANCE_CURRENT],
      ineligibleSourceStates: PORTAL_AUTH_INELIGIBLE_STATES.map((declared) => ({ ...declared })),
      meaning,
      onboarding: 'ACTIVE',
      privacyPurposeRefs: [`commerce.customer-context.portal-auth.${flow}`],
      purpose: `commerce.customer-context.portal-auth.${flow}`,
      requiredness: 'REQUIRED',
      result: {
        kind: 'MESSAGE_INTENTS',
        slots: [
          {
            cardinality: 'EXACTLY_ONE',
            recipientRole: 'account-holder',
            slotKey: 'account-holder',
            source: { ...PORTAL_AUTH_CONTACT, evidenceKinds: [...PORTAL_AUTH_CONTACT.evidenceKinds] },
          },
        ],
      },
      revision: 1,
      sourceOwner: PORTAL_AUTH_OWNER,
      status: 'ACTIVE',
      typeId: `commerce.customer-context.portal-auth.${flow}-message`,
    }),
  );

/**
 * The explicit approved set of Transactional Message Types. A type enters only through an approved owner activation
 * together with its source onboarding contract; nothing is discovered and nothing is a default.
 *
 * Today the approved set is the three Commerce Portal Auth e-mails (#1406): the verification link, the password reset
 * link and the second-factor one-time code. Their text lives in approved Template Revisions, never here, and the secret
 * (link, code) is owner-rendered by Auth and never part of any request, intent, history or preview.
 *
 * An invalid list is never replaced by an empty registry, which would silently drop every other approved type
 * (BR-05/AC-04): the production decision layer fails to build with MessageTypeRegistryInvalid, and a unit test builds
 * this exact list so CI fails too. Test fixtures live in the unit tests, never here.
 */
export const approvedMessageTypes: readonly TransactionalMessageType[] = [
  portalAuthType(
    'verify-email',
    'Asks the account holder to confirm the e-mail address of a newly created Portal account.',
  ),
  portalAuthType('reset-password', 'Gives the account holder the one-time link to choose a new Portal password.'),
  portalAuthType('otp', 'Gives the account holder the one-time code of the second sign-in step.'),
];
