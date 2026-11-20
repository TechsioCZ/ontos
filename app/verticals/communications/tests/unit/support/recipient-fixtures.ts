import { Effect, Layer, Redacted, Schema } from 'effect';

import type { MessageIntentIdentity } from '../../../src/domain/catalog/decision.ts';
import { AudienceSlotKeySchema, CommunicationResourceIdSchema } from '../../../src/domain/catalog/vocabulary.ts';
import { RecipientAuthorityUnavailable } from '../../../src/domain/recipient/current-gate-errors.ts';
import { RecipientCurrentGate, RecipientGateVerdict } from '../../../src/domain/recipient/current-gate.ts';
import type { RecipientGateQuery, RecipientGateVerdictCase } from '../../../src/domain/recipient/current-gate.ts';
import {
  OriginalRecipientBindingSchema,
  RecipientScopeSchema,
} from '../../../src/domain/recipient/original-binding.ts';
import type { OriginalRecipientBinding, RecipientScope } from '../../../src/domain/recipient/original-binding.ts';
import type { GateUnusableReason, UnavailableAuthority } from '../../../src/domain/recipient/recipient-assessment.ts';
import type { RecipientEvaluationInput } from '../../../src/domain/recipient/assess-recipients.ts';
import { handoffPinOf } from '../../../src/domain/recipient/recheck-before-handoff.ts';
import type { HandoffCandidate, HandoffState } from '../../../src/domain/recipient/recheck-before-handoff.ts';
import {
  FIXTURE_CONTACT_OWNER,
  FIXTURE_CONTACT_RESOURCE_TYPE,
  FIXTURE_OCCURRENCE_ID,
  FIXTURE_TENANT_ID,
  fixtureRequest,
} from './catalog-fixtures.ts';
import type { fixtureType } from './catalog-fixtures.ts';

/**
 * TEST-ONLY fixtures for the recipient decision. Every address, contact, profile and owner is fictional. The gate
 * below is a labelled test double: it proves how the domain REACTS to an owner answer, never that a real owner
 * publishes such an answer, and no test using it is delivery or production evidence.
 */

/** TEST-ONLY gate deadline. The production deadline is the owner composition's decision; the domain has no default. */
export const TEST_GATE_CHECK_TIMEOUT = '5 seconds';

export const ORIGINAL_ADDRESS = 'puvodni@example.test';
export const NEW_ADDRESS = 'nova@example.test';
export const FIXTURE_EVENT_TIME = '2026-11-18T09:30:00.000Z';

const decodeBinding = Schema.decodeUnknownSync(OriginalRecipientBindingSchema, { onExcessProperty: 'error' });
const decodeScope = Schema.decodeUnknownSync(RecipientScopeSchema);
const decodeResourceId = Schema.decodeSync(CommunicationResourceIdSchema);

const ref = (resourceType: string, resourceId: string, moduleId = 'fixture.party') => ({
  moduleId,
  resourceId,
  resourceType,
});

export const profileRef = (profileId: string) => ref('fixture.profile', profileId, 'fixture.customer-context');

const refOrNull = (profileId: string | undefined) => (profileId === undefined ? null : profileRef(profileId));

export const fixtureScope = (
  overrides: {
    readonly counterpartyId?: string;
    readonly legalEntityId?: string;
    readonly profileId?: string;
    readonly tenantId?: string;
  } = {},
): RecipientScope =>
  decodeScope(
    // A dimension that is not given is left out entirely, never present with an empty value.
    Object.fromEntries(
      Object.entries({
        counterpartyRef: refOrNull(overrides.counterpartyId),
        legalEntityId: overrides.legalEntityId ?? null,
        profileRef: refOrNull(overrides.profileId),
        tenantId: overrides.tenantId ?? FIXTURE_TENANT_ID,
      }).filter(([, value]) => value !== null),
    ),
  );

type Evidence =
  | { readonly kind: 'AUTHORITATIVE_REFERENCE' }
  | { readonly contactRevision: number; readonly kind: 'VERSIONED_SNAPSHOT' }
  | { readonly kind: 'HISTORICAL_SNAPSHOT'; readonly snapshotRef: ReturnType<typeof ref> };

export interface BindingOverrides {
  readonly contactOwner?: string;
  readonly contactResourceType?: string;
  readonly eventTime?: string;
  readonly evidence?: Evidence;
  readonly scope?: RecipientScope;
}

const originalContactOf = (contactId: string, overrides: BindingOverrides) => ({
  contactRef: ref(
    overrides.contactResourceType ?? FIXTURE_CONTACT_RESOURCE_TYPE,
    contactId,
    overrides.contactOwner ?? FIXTURE_CONTACT_OWNER,
  ),
  evidence: overrides.evidence ?? { contactRevision: 1, kind: 'VERSIONED_SNAPSHOT' },
});

/**
 * The original recipient binding a source sent; by default a versioned snapshot in the fixture request's scope.
 * A `null` contact id is a source that cannot evidence the original contact.
 */
export const binding = (
  role: string,
  recipientId: string,
  contactId: string | null = `contact-${recipientId}`,
  overrides: BindingOverrides = {},
): OriginalRecipientBinding => {
  const encoded = {
    recipientRef: ref('fixture.recipient', recipientId),
    role,
    scope: overrides.scope ?? fixtureScope(),
    validAt: overrides.eventTime ?? FIXTURE_EVENT_TIME,
  };
  return decodeBinding(
    contactId === null ? encoded : { ...encoded, originalContact: originalContactOf(contactId, overrides) },
  );
};

export const evaluationInput = (
  type: ReturnType<typeof fixtureType>,
  bindings: readonly OriginalRecipientBinding[],
  overrides: Partial<Pick<RecipientEvaluationInput, 'scope'>> & { readonly occurrenceId?: string } = {},
): RecipientEvaluationInput => ({
  bindings,
  request: fixtureRequest({ occurrenceId: overrides.occurrenceId ?? FIXTURE_OCCURRENCE_ID, purpose: type.purpose }),
  scope: overrides.scope ?? fixtureScope(),
  type,
});

type OwnerReply = Effect.Effect<RecipientGateVerdictCase, RecipientAuthorityUnavailable>;

/** What a fictional owner answers, given the query it was asked. */
export type OwnerAnswer = (query: RecipientGateQuery) => OwnerReply;

const SAFE_MASK = 'p***@example.test';

/** What a faithful owner echoes of the original evidence: its revision or its snapshot reference. */
const evidenceEcho = (evidence: RecipientGateQuery['contact']['evidence']) => {
  if (evidence.kind === 'VERSIONED_SNAPSHOT') {
    return { contactRevision: evidence.contactRevision };
  }
  return evidence.kind === 'HISTORICAL_SNAPSHOT' ? { snapshotRef: evidence.snapshotRef } : {};
};

const protectedEndpoint = (
  query: RecipientGateQuery,
  address: string,
  contactRef = query.contact.contactRef,
  mask = SAFE_MASK,
) => {
  const { evidence } = query.contact;
  const endpoint = {
    channel: 'email',
    contactRef,
    mask,
    value: Redacted.make(address),
  };
  return RecipientGateVerdict.Usable({ endpoint: { ...endpoint, ...evidenceEcho(evidence) } });
};

export const usable =
  (address = ORIGINAL_ADDRESS): OwnerAnswer =>
  (query) =>
    Effect.succeed(protectedEndpoint(query, address));

/** An owner whose mask is the given text, which a test makes unsafe on purpose. */
export const usableWithMask =
  (address: string, mask: string): OwnerAnswer =>
  (query) =>
    Effect.succeed(protectedEndpoint(query, address, query.contact.contactRef, mask));

/** An owner that answers for another contact than the one it was asked about. */
export const usableForOtherContact =
  (address: string, otherContactId: string): OwnerAnswer =>
  (query) =>
    Effect.succeed(
      protectedEndpoint(query, address, { ...query.contact.contactRef, resourceId: decodeResourceId(otherContactId) }),
    );

/** An owner that answers for the original contact but echoes no revision and no snapshot reference at all. */
export const usableWithoutEvidenceEcho =
  (address: string): OwnerAnswer =>
  (query) =>
    Effect.succeed(
      RecipientGateVerdict.Usable({
        endpoint: {
          channel: 'email',
          contactRef: query.contact.contactRef,
          mask: SAFE_MASK,
          value: Redacted.make(address),
        },
      }),
    );

const otherEvidenceEcho = (evidence: RecipientGateQuery['contact']['evidence']) => {
  if (evidence.kind === 'VERSIONED_SNAPSHOT') {
    return { contactRevision: evidence.contactRevision + 1 };
  }
  return evidence.kind === 'HISTORICAL_SNAPSHOT'
    ? { snapshotRef: { ...evidence.snapshotRef, resourceId: decodeResourceId('another-snapshot') } }
    : {};
};

/** An owner that echoes another revision, or another snapshot reference, than the original evidence names. */
export const usableForOtherEvidence =
  (address: string): OwnerAnswer =>
  (query) => {
    const { evidence } = query.contact;
    const other = otherEvidenceEcho(evidence);
    return Effect.succeed(
      RecipientGateVerdict.Usable({
        endpoint: {
          channel: 'email',
          contactRef: query.contact.contactRef,
          mask: SAFE_MASK,
          value: Redacted.make(address),
          ...other,
        },
      }),
    );
  };

export const unusable =
  (reason: GateUnusableReason): OwnerAnswer =>
  () =>
    Effect.succeed(RecipientGateVerdict.Unusable({ reason }));

/** A defective owner adapter whose check throws instead of returning an Effect. */
export const throwing = (): OwnerAnswer => () => {
  throw new Error('fixture owner adapter threw');
};

/** A defective owner adapter that dies inside its Effect. */
export const dying = (): OwnerAnswer => () => Effect.die(new Error('fixture owner adapter died'));

/** An owner that never answers. */
export const hanging = (): OwnerAnswer => () => Effect.never;

export const unavailable =
  (authority: UnavailableAuthority = 'SOURCE_OWNER'): OwnerAnswer =>
  () =>
    Effect.fail(new RecipientAuthorityUnavailable({ authority }));

/**
 * TEST DOUBLE of the Current gate. It answers by ORIGINAL contact id, records every query it receives and, like the
 * real port, has no operation that could read or return a Current contact. A contact id it was not told about
 * fails closed as an unavailable owner.
 */
export const gateDouble = (answers: Readonly<Record<string, OwnerAnswer>>) => {
  const queries: RecipientGateQuery[] = [];
  const layer = Layer.succeed(RecipientCurrentGate, {
    check: (query): OwnerReply => {
      queries.push(query);
      return (answers[query.contact.contactRef.resourceId] ?? unavailable())(query);
    },
    checkTimeout: TEST_GATE_CHECK_TIMEOUT,
  });
  return { layer, queries };
};

export const slotKeyOf = Schema.decodeSync(AudienceSlotKeySchema);

export const intentIdentity = (
  input: RecipientEvaluationInput,
  recipientBinding: OriginalRecipientBinding,
  slotKey: string,
): MessageIntentIdentity => ({
  occurrenceId: input.request.occurrence.occurrenceId,
  recipient: recipientBinding.recipientRef,
  revision: input.request.occurrence.revision,
  slotKey: slotKeyOf(slotKey),
  sourceModule: input.request.source.moduleKey,
  tenantId: input.request.tenantId,
  typeId: input.type.typeId,
});

/** A handoff candidate exactly as the decision pinned it: its original binding, identity and type revision. */
export const handoffCandidate = (
  input: RecipientEvaluationInput,
  recipientBinding: OriginalRecipientBinding,
  slotKey: string,
  handoff: HandoffState = 'STOPPABLE',
): HandoffCandidate => ({
  binding: recipientBinding,
  handoff,
  identity: intentIdentity(input, recipientBinding, slotKey),
  pin: handoffPinOf(input.type, recipientBinding),
});
