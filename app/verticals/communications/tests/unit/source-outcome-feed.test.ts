import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationResourceRefSchema } from '@app/communications-contracts/communication-request';
import { CommunicationOutcomeFeedSchema, HistorySlotKeySchema } from '../../shared/communication-history.ts';
import {
  CommunicationDecisionIdSchema,
  CommunicationRequestIdSchema,
  MessageIntentIdSchema,
} from '../../shared/communication-intake.ts';
import { sourceOutcomeFeedOf } from '../../src/domain/history/source-outcome.ts';
import type { RequestOutcomeFacts } from '../../src/domain/history/source-outcome.ts';
import { summarizeIntent } from '../../src/domain/history/timeline.ts';
import { attempt, factsOf, observation } from './support/history-fixtures.ts';

/**
 * [#1402 H-13 AC-07] The result the SOURCE workflow receives: a required message failure is information, never a commit or a
 * rollback, and it carries references and closed codes only.
 */
const REQUEST_ID = CommunicationRequestIdSchema.make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
const DECISION_ID = CommunicationDecisionIdSchema.make('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');
const PRIMARY = HistorySlotKeySchema.make('primary');
const decodeRef = Schema.decodeUnknownSync(CommunicationResourceRefSchema);

const intentOf = (
  id: number,
  parts: Parameters<typeof factsOf>[0],
  reason?: string,
): RequestOutcomeFacts['intents'][number] => ({
  intentId: MessageIntentIdSchema.make(`cccccccc-cccc-4ccc-8ccc-ccccccccccc${String(id)}`),
  reason,
  recipientRef: decodeRef({
    moduleId: 'fixture.party',
    resourceId: `recipient-${String(id)}`,
    resourceType: 'fixture.recipient',
  }),
  slotKey: PRIMARY,
  summary: summarizeIntent(factsOf(parts)),
});

interface DecisionOverrides {
  readonly noMessageReason?: string;
  readonly outcome?: 'MESSAGE_INTENTS' | 'NO_MESSAGE';
  readonly unresolvedSlots?: RequestOutcomeFacts['decision']['unresolvedSlots'];
}

const feedFor = (
  requiredness: 'OPTIONAL' | 'REQUIRED' | undefined,
  intents: RequestOutcomeFacts['intents'],
  decision: DecisionOverrides = {},
) =>
  sourceOutcomeFeedOf({
    decision: {
      decisionId: DECISION_ID,
      noMessageReason: decision.noMessageReason,
      outcome: decision.outcome ?? 'MESSAGE_INTENTS',
      requiredness,
      unresolvedSlots: decision.unresolvedSlots ?? [],
    },
    intents,
    requestId: REQUEST_ID,
  });

describe('Source outcome feed of a request', () => {
  it('reports a required message that was suppressed as FAILED, as a result and never as a business effect', () => {
    const feed = feedFor('REQUIRED', [
      intentOf(1, { intentStatus: 'SUPPRESSED', reason: 'PRIVACY_NOT_ALLOWED' }, 'PRIVACY_NOT_ALLOWED'),
    ]);
    expect(feed).toMatchObject({
      messages: [{ attention: 'FAILURE', reason: 'PRIVACY_NOT_ALLOWED', status: 'SUPPRESSED' }],
      partial: false,
      requiredOutcome: 'FAILED',
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
  });

  it('reports a proven provider failure after acceptance as FAILED and a timeout as UNKNOWN, never as a failure', () => {
    expect(
      feedFor('REQUIRED', [
        intentOf(1, {
          attempts: [attempt('ACCEPTED')],
          observations: [observation('DELIVERY_FAILED', { failureClass: 'BOUNCED_PERMANENT', observed: 9 })],
        }),
      ]).requiredOutcome,
    ).toBe('FAILED');
    const unknown = feedFor('REQUIRED', [intentOf(1, { attempts: [attempt('INDETERMINATE')] })]);
    expect(unknown.requiredOutcome).toBe('UNKNOWN');
    expect(unknown.messages[0]?.attention).toBe('UNKNOWN');
  });

  it('reports a partial failure as such, so the source never reads it as all-or-nothing', () => {
    const feed = feedFor('REQUIRED', [
      intentOf(1, { attempts: [attempt('ACCEPTED')] }),
      intentOf(2, { intentStatus: 'SUPPRESSED', reason: 'RECIPIENT_NOT_ELIGIBLE' }, 'RECIPIENT_NOT_ELIGIBLE'),
    ]);
    expect(feed).toMatchObject({ partial: true, requiredOutcome: 'FAILED' });
  });

  it('says NO_FAILURE for accepted or delivered messages, which is explicitly not a delivery claim', () => {
    const feed = feedFor('REQUIRED', [intentOf(1, { attempts: [attempt('ACCEPTED')] })]);
    expect(feed).toMatchObject({ requiredOutcome: 'NO_FAILURE' });
    expect(feed.messages[0]?.status).toBe('PROVIDER_ACCEPTED');
  });

  it('says IN_PROGRESS while a prepared intent has no attempt', () => {
    expect(feedFor('REQUIRED', [intentOf(1, {})]).requiredOutcome).toBe('IN_PROGRESS');
  });

  it('treats an unresolved required slot as a failure and a catalog no-message of a required type as FAILED', () => {
    expect(
      feedFor('REQUIRED', [intentOf(1, { attempts: [attempt('ACCEPTED')] })], {
        unresolvedSlots: [{ reason: 'RECIPIENT_AMBIGUOUS', slotKey: HistorySlotKeySchema.make('approver') }],
      }),
    ).toMatchObject({ partial: true, requiredOutcome: 'FAILED', unresolvedSlots: [{ reason: 'RECIPIENT_AMBIGUOUS' }] });
    expect(feedFor('REQUIRED', [], { noMessageReason: 'NO_RULE_MATCHED', outcome: 'NO_MESSAGE' })).toMatchObject({
      noMessageReason: 'NO_RULE_MATCHED',
      requiredOutcome: 'FAILED',
    });
  });

  it('does not report a source-owned stale request as a Communications failure, nor an optional type as owed', () => {
    expect(
      feedFor('REQUIRED', [], { noMessageReason: 'SOURCE_REVISION_NOT_CURRENT', outcome: 'NO_MESSAGE' })
        .requiredOutcome,
    ).toBe('SOURCE_STALE');
    expect(feedFor('OPTIONAL', [intentOf(1, { intentStatus: 'SUPPRESSED', reason: 'X' })]).requiredOutcome).toBe(
      'NOT_REQUIRED',
    );
    expect(feedFor(undefined, []).requiredOutcome).toBe('REQUIREDNESS_UNKNOWN');
  });

  it('is a closed, secret-free contract: it decodes, and any extra field (a token, an address, a link) is refused', () => {
    const feed = feedFor('REQUIRED', [intentOf(1, { attempts: [attempt('ACCEPTED')] })]);
    const encoded = Schema.encodeSync(CommunicationOutcomeFeedSchema)(feed);
    expect(Schema.decodeUnknownSync(CommunicationOutcomeFeedSchema)(encoded)).toEqual(feed);
    const decodeStrict = Schema.decodeUnknownSync(CommunicationOutcomeFeedSchema, { onExcessProperty: 'error' });
    expect(() => decodeStrict({ ...encoded, resetUrl: 'https://example.test/reset?token=abc' })).toThrow();
    expect(() =>
      decodeStrict({ ...encoded, messages: [{ ...encoded.messages[0], address: 'someone@example.test' }] }),
    ).toThrow();
  });
});
