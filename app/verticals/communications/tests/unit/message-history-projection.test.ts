import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  MESSAGE_HISTORY_MAX_PAGE_SIZE,
  MessageHistoryDetailResultSchema,
  TimelineEntryKindSchema,
  TimelineObservationKindSchema,
  TimelineTechnicalEvidenceSchema,
  MessageHistoryItemSchema,
  MessageHistoryListRequestFieldsSchema,
  TEMPLATE_PREVIEW_MARKER,
  TEMPLATE_PREVIEW_NOTICE,
} from '../../shared/message-history-read.ts';
import { HistoryEntryKindSchema } from '../../src/domain/history/timeline.ts';
import { ObservationKindSchema, TechnicalEvidenceSchema } from '../../src/domain/history/vocabulary.ts';
import { projectMessageHistoryItem, projectTimeline } from '../../src/history/message-history-projection.ts';
import { intentRecord, requestRecord } from './support/access-fixtures.ts';
import { attempt, conflict, factsOf, observation, stop } from './support/history-fixtures.ts';

const strict = { onExcessProperty: 'error' } as const;
const decodeItem = Schema.decodeUnknownSync(Schema.toEncoded(MessageHistoryItemSchema), strict);
const encodeItem = Schema.encodeSync(MessageHistoryItemSchema);
const withMask = { includeEndpointMask: true };
const withoutMask = { includeEndpointMask: false };
const project = (options = withMask, intent = intentRecord()) =>
  projectMessageHistoryItem(requestRecord([intent]), intent, options);

/** The words and shapes a safe history must never carry, whatever the store holds. */
const FORBIDDEN = [
  /@(?!example\.test)/u,
  /https?:\/\//iu,
  /<[a-z/]/iu,
  /token|password|secret|otp|reset/iu,
  /\bbody\b|\bsubject\b/iu,
];

describe('The history projection is a typed allow-list of safe metadata (#1409, ACC-01, ACC-05)', () => {
  it.effect('[S01 AC-01] shows the real state of the message in the published vocabulary, field by field', () =>
    Effect.gen(function* realState() {
      const delivered = intentRecord({
        facts: factsOf({
          attempts: [attempt('ACCEPTED')],
          observations: [observation('DELIVERY_PROVEN', { observed: 5 })],
        }),
      });
      const item = yield* project(withMask, delivered);
      expect(item.headline).toMatchObject({
        attention: 'NO_FAILURE',
        deliveryProven: true,
        providerAccepted: true,
        status: 'DELIVERED',
      });
      expect(item).toMatchObject({
        recipient: { channel: 'email', endpointMask: 'p***@example.test', role: 'original-recipient' },
        source: { moduleId: 'fixture.source', occurrence: { revision: 1 }, purpose: 'fixture.purpose' },
        type: { typeId: 'fixture.single-message', typeRevision: 1 },
      });
      // everything is a reference, a closed code, a mask or a time: the encoded form is plain JSON of those and nothing else
      expect(() => decodeItem(encodeItem(item))).not.toThrow();
    }),
  );

  it.effect('[AC-04 S02] shows the template as a revision PREVIEW marker, never as the sent text', () =>
    Effect.gen(function* preview() {
      const item = yield* project();
      expect(item.template).toEqual({
        language: 'cs',
        messageType: 'fixture.single-message',
        mode: 'B',
        notice: TEMPLATE_PREVIEW_MARKER,
        revisionNumber: 3,
      });
      expect(TEMPLATE_PREVIEW_NOTICE).toBe('template preview, not the exact sent e-mail');
      // no text of any template is representable: the pin has no body, subject or placeholder value field
      expect(Object.keys(item.template ?? {}).toSorted()).toEqual([
        'language',
        'messageType',
        'mode',
        'notice',
        'revisionNumber',
      ]);
    }),
  );

  it.effect(
    '[S03 ACC-05] has no field for a reset body, a token or an address, and refuses one in every text field',
    () =>
      Effect.gen(function* noSecret() {
        const item = yield* project();
        for (const pattern of FORBIDDEN) {
          expect(JSON.stringify(item)).not.toMatch(pattern);
        }
        const encoded = encodeItem(item);
        for (const extra of ['body', 'subject', 'token', 'resetUrl', 'html', 'to', 'address', 'payload']) {
          expect(() => decodeItem({ ...encoded, [extra]: 'https://example.test/reset?token=secret' })).toThrow();
          expect(() =>
            decodeItem({ ...encoded, recipient: { ...encoded.recipient, [extra]: 'someone@example.test' } }),
          ).toThrow();
        }
        // a reason that is not a closed code (free text, a link, an address) is dropped, never shown
        const dirty = intentRecord({
          decisionReason: 'reset https://example.test/x?token=1',
          facts: factsOf({ intentStatus: 'SUPPRESSED', reason: 'someone@example.test' }),
        });
        const dirtyItem = yield* project(withMask, dirty);
        expect(dirtyItem.headline.reasonCodes).toEqual([]);
      }),
  );

  it.effect('shows the mask only when the field permission allows it and only when it still hides the endpoint', () =>
    Effect.gen(function* maskRules() {
      const denied = yield* project(withoutMask);
      expect(denied.recipient).not.toHaveProperty('endpointMask');
      expect(denied.recipient.ref).toBeDefined();
      for (const unsafe of ['someone@example.test', 'plain text', '']) {
        const item = yield* project(withMask, intentRecord({ endpointMask: unsafe }));
        expect(item.recipient).not.toHaveProperty('endpointMask');
      }
      const absent = yield* project(withMask, intentRecord({ withoutMask: true }));
      expect(absent.recipient).not.toHaveProperty('endpointMask');
    }),
  );

  it.effect(
    'carries the history vocabulary: HELD_UNPROVEN needs re-evaluation and a conflict needs reconciliation',
    () =>
      Effect.gen(function* vocabulary() {
        const held = yield* project(
          withMask,
          intentRecord({ facts: factsOf({ stops: [stop({ categories: ['PRIVACY_INDETERMINATE'], proven: false })] }) }),
        );
        expect(held.headline).toMatchObject({
          attention: 'NEEDS_REEVALUATION',
          reasonCodes: ['PRIVACY_INDETERMINATE'],
          status: 'HELD_UNPROVEN',
        });
        const conflicting = yield* project(
          withMask,
          intentRecord({
            facts: factsOf({
              attempts: [attempt('ACCEPTED')],
              conflicts: [conflict('DELIVERY_PROVEN', { observed: 6 })],
              observations: [observation('DELIVERY_PROVEN', { observed: 5 })],
            }),
          }),
        );
        expect(conflicting.headline).toMatchObject({ attention: 'NEEDS_RECONCILIATION', needsReconciliation: true });
        const suppressed = yield* project(
          withMask,
          intentRecord({
            decisionReason: 'PRIVACY_NOT_ALLOWED',
            facts: factsOf({ intentStatus: 'SUPPRESSED', reason: 'PRIVACY_NOT_ALLOWED' }),
            withTemplate: false,
          }),
        );
        expect(suppressed).toMatchObject({ headline: { attention: 'FAILURE', status: 'SUPPRESSED' } });
        // a message stopped before any template was pinned shows no template at all
        expect(suppressed).not.toHaveProperty('template');
      }),
  );

  it.effect(
    'lists the timeline as proven facts only: kinds, statuses, times and closed codes, no identities or payloads',
    () =>
      Effect.gen(function* timeline() {
        const intent = intentRecord({
          facts: factsOf({
            attempts: [attempt('ACCEPTED')],
            observations: [
              observation('ACCEPTANCE_PROVEN', { observed: 3 }),
              observation('DELIVERY_PROVEN', { observed: 4 }),
            ],
          }),
        });
        const entries = yield* projectTimeline(intent);
        expect(entries.map(({ kind }) => kind)).toContain('PROVIDER_OBSERVED');
        const allowedKeys = new Set([
          'attemptNumber',
          'kind',
          'observationKind',
          'occurredAt',
          'outOfOrder',
          'reasonCodes',
          'recordedAt',
          'status',
          'technical',
        ]);
        for (const entry of entries) {
          expect(Object.keys(entry).every((key) => allowedKeys.has(key))).toBe(true);
          expect(Object.keys(entry)).toEqual(
            expect.arrayContaining(['kind', 'occurredAt', 'outOfOrder', 'reasonCodes', 'recordedAt', 'status']),
          );
        }
        const detail = Schema.encodeSync(MessageHistoryDetailResultSchema)({
          message: yield* project(withMask, intent),
          timeline: entries,
        });
        expect(JSON.stringify(detail)).not.toMatch(/attemptId|observationId|providerRef|observationKey/u);
      }),
  );

  it('[AC-01] bounds every page with ONE named technical cap and refuses a larger limit instead of clamping it', () => {
    const decode = Schema.decodeUnknownSync(MessageHistoryListRequestFieldsSchema, strict);
    expect(decode({ limit: MESSAGE_HISTORY_MAX_PAGE_SIZE }).limit).toBe(MESSAGE_HISTORY_MAX_PAGE_SIZE);
    for (const limit of [0, -1, MESSAGE_HISTORY_MAX_PAGE_SIZE + 1, 1.5]) {
      expect(() => decode({ limit })).toThrow();
    }
    // the request chooses neither Tenant nor Legal Entity: only Core's trusted scope can
    for (const extra of ['tenantId', 'legalEntityId']) {
      expect(() => decode({ [extra]: '11111111-1111-4111-8111-111111111111' })).toThrow();
      expect(() => decode({ scope: { [extra]: '11111111-1111-4111-8111-111111111111' } })).toThrow();
    }
  });

  it('[AC-01] the published timeline vocabulary is exactly the history domain vocabulary: neither can move alone', () => {
    expect(TimelineEntryKindSchema.literals).toEqual(HistoryEntryKindSchema.literals);
    expect(TimelineObservationKindSchema.literals).toEqual(ObservationKindSchema.literals);
    expect(TimelineTechnicalEvidenceSchema.literals).toEqual(TechnicalEvidenceSchema.literals);
  });
});
