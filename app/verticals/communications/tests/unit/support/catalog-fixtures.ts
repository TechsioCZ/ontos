import { Result, Schema } from 'effect';

import {
  CommunicationDecisionRequestSchema,
  RecipientFactSchema,
  SourceOccurrenceFactsSchema,
} from '../../../src/domain/catalog/decision-request.ts';
import { decideCommunication } from '../../../src/domain/catalog/decision.ts';
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

export const FIXTURE_OCCURRENCE_ID = 'fixture-occurrence-1';
export const FIXTURE_TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';

export const FIXTURE_CONTACT_OWNER = 'fixture.party';
export const FIXTURE_CONTACT_RESOURCE_TYPE = 'fixture.contact-point';

/** TEST-ONLY declaration of where a slot's original contact comes from at event time. */
export const fixtureContactSource = (
  evidenceKinds: readonly string[] = ['HISTORICAL_SNAPSHOT', 'VERSIONED_SNAPSHOT', 'AUTHORITATIVE_REFERENCE'],
) => ({
  contactOwner: FIXTURE_CONTACT_OWNER,
  contactResourceType: FIXTURE_CONTACT_RESOURCE_TYPE,
  evidenceKinds,
});

/** One audience slot of a fixture type with the fixture contact source. */
export const fixtureSlot = (
  slotKey: string,
  recipientRole: string,
  cardinality: 'EACH_MATCHING' | 'EXACTLY_ONE',
  source: ReturnType<typeof fixtureContactSource> = fixtureContactSource(),
) => ({ cardinality, recipientRole, slotKey, source });

const decodeType = Schema.decodeUnknownSync(TransactionalMessageTypeSchema);
const decodeRequest = Schema.decodeSync(CommunicationDecisionRequestSchema);
const decodeFact = Schema.decodeSync(RecipientFactSchema);
const decodeSource = Schema.decodeSync(SourceOccurrenceFactsSchema);

interface TypeOverrides {
  readonly audience?: unknown;
  readonly currentness?: { readonly requireLatestSourceRevision: boolean };
  readonly documents?: unknown;
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
  slots: [fixtureSlot('primary', FIXTURE_ORIGINAL_ROLE, 'EXACTLY_ONE')],
};

/** An ACTIVE, onboarded, optional type with one original-recipient slot; override any facet per scenario. */
export const fixtureType = (overrides: TypeOverrides = {}): TransactionalMessageType =>
  decodeType({
    audience: { mode: 'INDIVIDUAL' },
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
        fixtureSlot('primary', FIXTURE_ORIGINAL_ROLE, 'EXACTLY_ONE'),
        fixtureSlot('secondary', FIXTURE_SECONDARY_ROLE, 'EXACTLY_ONE'),
      ],
    },
    ...overrides,
  });
export const requiredTwoSlotType = requiredTwoSlotTypeWith();

/** TEST-ONLY approved N-recipient policy: one candidate per distinct approver the recipient algorithm supplies. */
export const nRecipientPolicyType = fixtureTypeNamed('approvers', {
  result: {
    kind: 'MESSAGE_INTENTS',
    slots: [fixtureSlot('approvers', FIXTURE_APPROVER_ROLE, 'EACH_MATCHING')],
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
    readonly tenantId?: string;
  } = {},
) =>
  decodeRequest({
    occurrence: {
      occurrenceId: overrides.occurrenceId ?? FIXTURE_OCCURRENCE_ID,
      revision: overrides.revision ?? 1,
    },
    purpose: overrides.purpose ?? 'fixture.single',
    source: { moduleKey: overrides.moduleKey ?? FIXTURE_SOURCE_MODULE },
    tenantId: overrides.tenantId ?? FIXTURE_TENANT_ID,
  });

interface RecipientOverrides {
  readonly moduleId?: string;
  readonly occurrenceId?: string;
  readonly privacy?: 'ALLOWED' | 'INDETERMINATE' | 'NOT_ALLOWED';
  readonly resourceType?: string;
  readonly tenantId?: string;
}

const PRIVACY_BY_STOP = {
  PRIVACY_INDETERMINATE: 'INDETERMINATE',
  PRIVACY_NOT_ALLOWED: 'NOT_ALLOWED',
} as const;
const privacyFor = (stop: CandidateStopReason | undefined) =>
  stop === 'PRIVACY_INDETERMINATE' || stop === 'PRIVACY_NOT_ALLOWED' ? PRIVACY_BY_STOP[stop] : 'ALLOWED';

/**
 * A recipient fact for the fixture request. `stop` maps onto the required Privacy evidence (or the recipient stop);
 * without one the fixture reports an explicit Privacy ALLOWED, the only evidence that can yield eligibility.
 */
export const recipient = (
  role: string,
  contactId: string,
  stop?: CandidateStopReason,
  overrides: RecipientOverrides = {},
): RecipientFact =>
  decodeFact({
    occurrenceId: overrides.occurrenceId ?? FIXTURE_OCCURRENCE_ID,
    privacy: overrides.privacy ?? privacyFor(stop),
    recipientStop: stop === 'RECIPIENT_NOT_ELIGIBLE' || stop === 'RECIPIENT_BASIS_MISSING' ? stop : undefined,
    ref: {
      moduleId: overrides.moduleId ?? 'fixture.party',
      resourceId: contactId,
      resourceType: overrides.resourceType ?? 'fixture.contact-point',
    },
    role,
    tenantId: overrides.tenantId ?? FIXTURE_TENANT_ID,
  });

export const fixtureContext = (
  recipients: readonly RecipientFact[],
  source: {
    readonly latestRevision?: number;
    readonly occurrenceId?: string;
    readonly state?: string;
    readonly tenantId?: string;
  } = {},
): CommunicationDecisionContext => ({
  recipients,
  source: decodeSource({
    latestRevision: source.latestRevision ?? 1,
    occurrenceId: source.occurrenceId ?? FIXTURE_OCCURRENCE_ID,
    state: source.state ?? FIXTURE_OPEN_STATE,
    tenantId: source.tenantId ?? FIXTURE_TENANT_ID,
  }),
});

/** Evaluate facts that belong to the request; a mismatch here is a test-authoring defect and surfaces as a throw. */
export const decideOrThrow = (...args: Parameters<typeof decideCommunication>) =>
  Result.getOrThrow(decideCommunication(...args));
