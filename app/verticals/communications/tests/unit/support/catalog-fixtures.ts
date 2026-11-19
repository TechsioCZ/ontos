import { Result, Schema } from 'effect';

import {
  CommunicationDecisionRequestSchema,
  RecipientFactSchema,
  SourceOccurrenceFactsSchema,
} from '../../../src/domain/catalog/decision-request.ts';
import type { CommunicationDecisionContext, RecipientFact } from '../../../src/domain/catalog/decision-request.ts';
import { TransactionalMessageTypeSchema } from '../../../src/domain/catalog/message-type.ts';
import type { TransactionalMessageType } from '../../../src/domain/catalog/message-type.ts';
import { buildMessageTypeRegistry } from '../../../src/domain/catalog/registry.ts';
import type { CandidateStopReason } from '../../../src/domain/catalog/vocabulary.ts';

/**
 * TEST-ONLY fixtures. Every type, purpose, source module, state and recipient below is fictional (`fixture.*`).
 * None of it is a production type, a real purpose or real copy, and none of it is registered anywhere outside tests.
 */

export const FIXTURE_SOURCE_MODULE = 'fixture.source';
export const FIXTURE_OPEN_STATE = 'fixture.state.open';
export const FIXTURE_CLOSED_STATE = 'fixture.state.closed';
export const FIXTURE_ORIGINAL_ROLE = 'original-recipient';
export const FIXTURE_SECONDARY_ROLE = 'fixture-secondary';
export const FIXTURE_APPROVER_ROLE = 'fixture-approver';

const tenantId = '11111111-1111-4111-8111-111111111111';

const decodeType = Schema.decodeUnknownSync(TransactionalMessageTypeSchema);
const decodeRequest = Schema.decodeSync(CommunicationDecisionRequestSchema);
const decodeFact = Schema.decodeSync(RecipientFactSchema);
const decodeSource = Schema.decodeSync(SourceOccurrenceFactsSchema);

interface TypeOverrides {
  readonly currentness?: { readonly requireLatestSourceRevision: boolean };
  readonly eligibleSourceStates?: readonly string[];
  readonly onboarding?: 'ACTIVE' | 'NOT_ACTIVATED';
  readonly privacyPurposeRefs?: readonly string[];
  readonly purpose?: string;
  readonly requiredness?: 'OPTIONAL' | 'REQUIRED';
  readonly result?: unknown;
  readonly revision?: number;
  readonly sourceOwner?: string;
  readonly status?: 'ACTIVE' | 'DEACTIVATED' | 'STALE';
  readonly typeId?: string;
}

const oneOriginalRecipient = {
  kind: 'MESSAGE_INTENTS',
  slots: [{ cardinality: 'EXACTLY_ONE', recipientRole: FIXTURE_ORIGINAL_ROLE, slotKey: 'primary' }],
};

/** An ACTIVE, onboarded, optional type with one original-recipient slot; override any facet per scenario. */
export const fixtureType = (overrides: TypeOverrides = {}): TransactionalMessageType =>
  decodeType({
    currentness: { requireLatestSourceRevision: true },
    eligibleSourceStates: [FIXTURE_OPEN_STATE],
    meaning: 'Fictional test type used only by unit tests.',
    onboarding: 'ACTIVE',
    privacyPurposeRefs: ['fixture.privacy.purpose'],
    purpose: 'fixture.single',
    requiredness: 'OPTIONAL',
    result: oneOriginalRecipient,
    revision: 1,
    sourceOwner: FIXTURE_SOURCE_MODULE,
    status: 'ACTIVE',
    typeId: 'fixture.single-message',
    ...overrides,
  });

/** Distinct purpose and type id derived from one suffix, so many types can coexist in one registry. */
export const fixtureTypeNamed = (name: string, overrides: TypeOverrides = {}) =>
  fixtureType({ purpose: `fixture.${name}`, typeId: `fixture.${name}-message`, ...overrides });

/** Approved zero-message rule for its context. */
export const noMessageType = fixtureTypeNamed('quiet', {
  result: { kind: 'NO_MESSAGE', ruleKey: 'fixture.rule.quiet' },
});

/** Required type with two independent single-recipient slots. */
export const requiredTwoSlotTypeWith = (overrides: TypeOverrides = {}) =>
  fixtureTypeNamed('paired', {
    requiredness: 'REQUIRED',
    result: {
      kind: 'MESSAGE_INTENTS',
      slots: [
        { cardinality: 'EXACTLY_ONE', recipientRole: FIXTURE_ORIGINAL_ROLE, slotKey: 'primary' },
        { cardinality: 'EXACTLY_ONE', recipientRole: FIXTURE_SECONDARY_ROLE, slotKey: 'secondary' },
      ],
    },
    ...overrides,
  });
export const requiredTwoSlotType = requiredTwoSlotTypeWith();

/** TEST-ONLY approved N-recipient policy: one candidate per distinct approver the recipient algorithm supplies. */
export const nRecipientPolicyType = fixtureTypeNamed('approvers', {
  result: {
    kind: 'MESSAGE_INTENTS',
    slots: [{ cardinality: 'EACH_MATCHING', recipientRole: FIXTURE_APPROVER_ROLE, slotKey: 'approvers' }],
  },
});

/** Fixture registries are written valid; an invalid one is a test-authoring defect and surfaces as a thrown error. */
export const fixtureRegistry = (...types: readonly TransactionalMessageType[]) =>
  Result.getOrThrow(buildMessageTypeRegistry(types));

export const fixtureRequest = (
  overrides: {
    readonly moduleKey?: string;
    readonly occurrenceId?: string;
    readonly purpose?: string;
    readonly revision?: number;
  } = {},
) =>
  decodeRequest({
    occurrence: { occurrenceId: overrides.occurrenceId ?? 'fixture-occurrence-1', revision: overrides.revision ?? 1 },
    purpose: overrides.purpose ?? 'fixture.single',
    source: { moduleKey: overrides.moduleKey ?? FIXTURE_SOURCE_MODULE },
    tenantId,
  });

export const recipient = (role: string, contactId: string, stop?: CandidateStopReason): RecipientFact =>
  decodeFact({
    ref: { moduleId: 'fixture.party', resourceId: contactId, resourceType: 'fixture.contact-point' },
    role,
    stop,
  });

export const fixtureContext = (
  recipients: readonly RecipientFact[],
  source: { readonly latestRevision?: number; readonly state?: string } = {},
): CommunicationDecisionContext => ({
  recipients,
  source: decodeSource({ latestRevision: source.latestRevision ?? 1, state: source.state ?? FIXTURE_OPEN_STATE }),
});
