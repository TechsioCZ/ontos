import {
  CommunicationRequestScopeSchema,
  CommunicationResourceRefSchema,
} from '@app/communications-contracts/communication-request';
import { Schema } from 'effect';

import { HistorySlotKeySchema } from '../../../shared/communication-history.ts';
import {
  CommunicationDecisionIdSchema,
  CommunicationRequestIdSchema,
  MessageIntentIdSchema,
} from '../../../shared/communication-intake.ts';
import { sourceOutcomeFeedOf } from '../../../src/domain/history/source-outcome.ts';
import { historyOfIntent } from '../../../src/domain/history/timeline.ts';
import type { IntentTimelineFacts } from '../../../src/domain/history/timeline.ts';
import type { IntentHistoryRecord, RequestHistoryRecord } from '../../../src/services/message-history.service.ts';
import { TemplatePinSchema } from '../../../shared/template-revision.ts';
import { INTENT_ID, factsOf, minute } from './history-fixtures.ts';

/**
 * TEST-ONLY records of the safe history, built from the fictional facts of `history-fixtures`. Every reference, mask, role and
 * module below is invented (`fixture.*`); none of it is a production type, address or message text.
 */

export const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
export const DECISION_ID = '55555555-5555-4555-8555-555555555555';
export const TENANT_ID = '11111111-1111-4111-8111-111111111111';

/** The absence the record types spell as `T | undefined`: a typed none, never a literal assignment. */
const absent = <Value>(value?: Value): Value | undefined => value;

export const recipientRef = Schema.decodeUnknownSync(CommunicationResourceRefSchema)({
  moduleId: 'fixture.party',
  resourceId: 'customer-1',
  resourceType: 'fixture.party',
});
export const tenantScope = Schema.decodeUnknownSync(CommunicationRequestScopeSchema)({ tenantId: TENANT_ID });

/** The default mask of a fictional recipient: it hides part of the endpoint. */
export const SAFE_MASK = 'p***@example.test';

const FIXTURE_MESSAGE_TYPE = 'fixture.single-message';
export const TEMPLATE_REVISION_ID = '77777777-7777-4777-8777-777777777777';
export const TEMPLATE_TYPE_ID = '88888888-8888-4888-8888-888888888888';
const templatePin = Schema.decodeUnknownSync(TemplatePinSchema)({
  channel: 'email',
  decisionTime: '2026-11-19T12:00:00.000Z',
  language: 'cs',
  messageType: FIXTURE_MESSAGE_TYPE,
  revisionId: TEMPLATE_REVISION_ID,
  revisionNumber: 3,
  scope: { kind: 'tenant' },
  templateTypeId: TEMPLATE_TYPE_ID,
});

interface IntentOptions {
  readonly decisionReason?: string;
  readonly documents?: IntentHistoryRecord['documents'];
  readonly endpointMask?: string;
  readonly facts?: IntentTimelineFacts;
  readonly links?: IntentHistoryRecord['links'];
  readonly withoutMask?: boolean;
  readonly withTemplate?: boolean;
}

export const intentRecord = (options: IntentOptions = {}): IntentHistoryRecord => {
  const facts = options.facts ?? factsOf({});
  const withTemplate = options.withTemplate ?? true;
  return {
    decidedAt: minute(0),
    decisionReason: options.decisionReason,
    documents: options.documents ?? [],
    facts,
    history: historyOfIntent(facts),
    intentId: MessageIntentIdSchema.make(INTENT_ID),
    language: withTemplate ? { language: 'cs', mode: 'B', policy: absent() } : absent(),
    links: options.links ?? { resendOf: absent(), resentAs: [], retries: [] },
    recipient: {
      channel: 'email',
      endpointMask: options.withoutMask === true ? absent() : (options.endpointMask ?? SAFE_MASK),
      ref: recipientRef,
      role: 'original-recipient',
    },
    slotKey: HistorySlotKeySchema.make('original'),
    template: withTemplate
      ? {
          contentDigest: absent(),
          messageType: FIXTURE_MESSAGE_TYPE,
          pin: templatePin,
          revisionId: TEMPLATE_REVISION_ID,
          revisionNumber: 3,
          source: 'TENANT_REVISION',
          templateTypeId: TEMPLATE_TYPE_ID,
        }
      : absent(),
    type: { typeId: FIXTURE_MESSAGE_TYPE, typeRevision: 1 },
  };
};

/** The Explicit Resend and Technical Retry links of one fictional message; none by default. */
export const linksFixture = (links: Partial<IntentHistoryRecord['links']> = {}): IntentHistoryRecord['links'] => ({
  resendOf: links.resendOf ?? absent(),
  resentAs: links.resentAs ?? [],
  retries: links.retries ?? [],
});

interface DecisionOptions {
  readonly noMessageReason?: string;
  readonly unresolvedSlots?: RequestHistoryRecord['feed']['unresolvedSlots'];
}

export const requestRecord = (
  intents: readonly IntentHistoryRecord[],
  scope?: RequestHistoryRecord['request']['scope'],
  decision: DecisionOptions = {},
): RequestHistoryRecord => {
  const decisionId = CommunicationDecisionIdSchema.make(DECISION_ID);
  const requestId = CommunicationRequestIdSchema.make(REQUEST_ID);
  return {
    decidedAt: minute(0),
    decisionId,
    feed: sourceOutcomeFeedOf({
      decision: {
        decisionId,
        noMessageReason: decision.noMessageReason,
        outcome: decision.noMessageReason === undefined ? 'MESSAGE_INTENTS' : 'NO_MESSAGE',
        requiredness: 'REQUIRED',
        unresolvedSlots: decision.unresolvedSlots ?? [],
      },
      intents: intents.map((entry) => ({
        intentId: entry.intentId,
        reason: entry.decisionReason,
        recipientRef: entry.recipient.ref,
        slotKey: entry.slotKey,
        summary: entry.history.summary,
      })),
      requestId,
    }),
    intents,
    noMessageReason: decision.noMessageReason,
    request: {
      occurrenceId: 'fixture-occurrence-1',
      occurrenceRevision: 1,
      purpose: 'fixture.purpose',
      requestId,
      scope: scope ?? tenantScope,
      sourceModule: 'fixture.source',
    },
    tenantMode: absent(),
  };
};
