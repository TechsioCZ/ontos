import { CommunicationResourceRefSchema } from '@app/communications-contracts/communication-request';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  EndpointMaskSchema,
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
import { TemplateUseAuditSchema } from '../../shared/template-revision.ts';
import { MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import {
  TEMPLATE_REVISION_ID,
  TEMPLATE_TYPE_ID,
  intentRecord,
  linksFixture,
  requestRecord,
} from './support/access-fixtures.ts';
import {
  ATTEMPT_1,
  ATTEMPT_2,
  attempt,
  conflict,
  factsOf,
  minute,
  observation,
  stop,
} from './support/history-fixtures.ts';

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
        source: 'TENANT_REVISION',
      });
      expect(TEMPLATE_PREVIEW_NOTICE).toBe('template preview, not the exact sent e-mail');
      // no text of any template is representable: the pin has no body, subject or placeholder value field
      expect(Object.keys(item.template ?? {}).toSorted()).toEqual([
        'language',
        'messageType',
        'mode',
        'notice',
        'revisionNumber',
        'source',
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
      for (const unsafe of ['someone@example.test', 'plain text', '', '*john.smith@example.test', '**x@example.test']) {
        const item = yield* project(withMask, intentRecord({ endpointMask: unsafe }));
        expect(item.recipient).not.toHaveProperty('endpointMask');
      }
      const absent = yield* project(withMask, intentRecord({ withoutMask: true }));
      expect(absent.recipient).not.toHaveProperty('endpointMask');
    }),
  );

  it('[S01 mask shape] a mask is structurally a mask: a short visible prefix, at least three hiding characters, then only a domain', () => {
    const isMaskText = Schema.is(EndpointMaskSchema);
    for (const mask of [
      'p***@example.test',
      'p***@e***.test',
      'x***',
      '***',
      '\u2022\u2022\u2022@example.test',
      'ab***cd',
    ]) {
      expect(isMaskText(mask)).toBe(true);
    }
    for (const notMask of [
      '*john.smith@example.test',
      '**x@example.test',
      '***john.smith@example.test',
      'john.smith@example.test',
      'p**@example.test',
      'abcd***@example.test',
      'p***@example.test@other.test',
      'p***@exam ple.test',
      'plain text',
      '',
    ]) {
      expect(isMaskText(notMask)).toBe(false);
    }
  });

  it.effect(
    'carries the history vocabulary: HELD_UNPROVEN needs re-evaluation and a conflict needs reconciliation',
    () =>
      Effect.gen(function* vocabulary() {
        const held = yield* project(
          withMask,
          intentRecord({
            facts: factsOf({ stops: [stop({ proven: false, reasonCodes: ['PRIVACY_INDETERMINATE'] })] }),
          }),
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
          'links',
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

const ORIGINAL = MessageIntentIdSchema.make('99999999-9999-4999-8999-999999999991');
const RESEND = MessageIntentIdSchema.make('99999999-9999-4999-8999-999999999992');
const ACTIVATOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const REACTIVATOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const RETRY_LINK = {
  attemptId: ATTEMPT_2,
  basisKind: 'PRIOR_REJECTED',
  previousAttemptId: ATTEMPT_1,
  reasonCode: 'PRIOR_NOT_ACCEPTED',
} as const;
const retriedFacts = factsOf({
  attempts: [attempt('REJECTED', { prepared: 1 }), attempt('ACCEPTED', { id: ATTEMPT_2, number: 2, prepared: 3 })],
});

describe('Explicit Resend and Technical Retry explain their link from either end (#1402 D9, AC-09; #1403 AC-05)', () => {
  it.effect('[AC-09] a resend names its original and an original names its resend, with the approved reason', () =>
    Effect.gen(function* resendLinks() {
      const resend = yield* project(
        withMask,
        intentRecord({
          links: linksFixture({ resendOf: { intentId: ORIGINAL, reasonCode: 'PRIOR_DELIVERY_FAILED' } }),
        }),
      );
      expect(resend.links).toEqual([
        { direction: 'RESEND_OF', intentId: ORIGINAL, kind: 'EXPLICIT_RESEND', reasonCode: 'PRIOR_DELIVERY_FAILED' },
      ]);
      const original = yield* project(
        withMask,
        intentRecord({
          links: linksFixture({ resentAs: [{ intentId: RESEND, reasonCode: 'SOURCE_APPROVED_RESEND' }] }),
        }),
      );
      expect(original.links).toEqual([
        { direction: 'RESENT_AS', intentId: RESEND, kind: 'EXPLICIT_RESEND', reasonCode: 'SOURCE_APPROVED_RESEND' },
      ]);
      // the timeline of each end carries the same link on the decision fact
      const entries = yield* projectTimeline(
        intentRecord({
          links: linksFixture({ resendOf: { intentId: ORIGINAL, reasonCode: 'PRIOR_DELIVERY_FAILED' } }),
        }),
      );
      expect(entries[0]?.links).toEqual(resend.links);
    }),
  );

  it.effect('[AC-09] a Technical Retry names both attempts and its basis, on the item and on both attempt facts', () =>
    Effect.gen(function* retryLinks() {
      const intent = intentRecord({ facts: retriedFacts, links: linksFixture({ retries: [RETRY_LINK] }) });
      const item = yield* project(withMask, intent);
      const expected = {
        attemptNumber: 2,
        basisKind: 'PRIOR_REJECTED',
        kind: 'TECHNICAL_RETRY',
        previousAttemptNumber: 1,
        reasonCode: 'PRIOR_NOT_ACCEPTED',
      };
      expect(item.links).toEqual([expected]);
      const prepared = (yield* projectTimeline(intent)).filter(({ kind }) => kind === 'ATTEMPT_PREPARED');
      // from the earlier attempt and from the retry, the same link explains itself
      expect(prepared.map(({ attemptNumber, links }) => [attemptNumber, links])).toEqual([
        [1, [expected]],
        [2, [expected]],
      ]);
    }),
  );

  it.effect('a message without a link has no link at all, and a code that is not closed is never shown', () =>
    Effect.gen(function* noLinks() {
      const plain = yield* project();
      expect(plain.links).toEqual([]);
      const entries = yield* projectTimeline(intentRecord());
      for (const entry of entries) {
        expect(entry).not.toHaveProperty('links');
      }
      const dirty = yield* project(
        withMask,
        intentRecord({
          links: linksFixture({ resendOf: { intentId: ORIGINAL, reasonCode: 'see https://example.test/x' } }),
        }),
      ).pipe(Effect.flip);
      expect(Schema.isSchemaError(dirty)).toBe(true);
    }),
  );
});

describe('The history shows that a document was disclosed, by reference only (#1409, #1396)', () => {
  it.effect('projects the pinned documents as a reference, a form and a time, never a name, link or byte', () =>
    Effect.gen(function* documents() {
      const item = yield* project(
        withMask,
        intentRecord({
          documents: [
            {
              document: Schema.decodeUnknownSync(CommunicationResourceRefSchema)({
                moduleId: 'fixture.invoicing',
                resourceId: 'invoice-1',
                resourceType: 'fixture.invoice',
              }),
              form: 'ATTACHMENT',
              pinnedAt: minute(2),
              position: 0,
            },
          ],
        }),
      );
      expect(item.documents).toMatchObject([
        { document: { moduleId: 'fixture.invoicing', resourceId: 'invoice-1' }, form: 'ATTACHMENT', position: 0 },
      ]);
      expect(Object.keys(item.documents[0] ?? {}).toSorted()).toEqual(['document', 'form', 'pinnedAt', 'position']);
      expect((yield* project()).documents).toEqual([]);
    }),
  );
});

const audit = () =>
  Schema.decodeUnknownSync(TemplateUseAuditSchema)({
    activations: [
      {
        activatedAt: '2026-11-18T09:00:00.000Z',
        activatedByPrincipalId: ACTIVATOR,
        activationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
        activationReason: 'Approved wording for invoices',
        endedAt: '2026-11-19T10:00:00.000Z',
        endedByPrincipalId: ACTIVATOR,
        endedKind: 'replaced',
        endReason: 'A newer wording',
        scopeKey: 'tenant',
      },
      {
        activatedAt: '2026-11-19T11:00:00.000Z',
        activatedByPrincipalId: REACTIVATOR,
        activationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
        activationReason: 'Reinstated',
        scopeKey: 'tenant',
      },
    ],
    activeAtDecisionTime: true,
    contentDigest: 'd'.repeat(64),
    decisionTime: '2026-11-19T12:00:00.000Z',
    identity: { channel: 'email', language: 'cs', messageType: 'fixture.single-message', scope: { kind: 'tenant' } },
    lifecycleState: 'active',
    optionalPlaceholders: [],
    requiredPlaceholders: ['invoice_number'],
    revisionId: TEMPLATE_REVISION_ID,
    revisionNumber: 3,
    source: 'TENANT_REVISION',
    templateTypeId: TEMPLATE_TYPE_ID,
  });

describe('The history answers which revision, who activated it, when, for which scope and why (#1398 AC-02, T-07)', () => {
  it.effect('[T-07] names the activation that was in force at the decision, with who, when, scope and reason', () =>
    Effect.gen(function* templateUse() {
      const item = yield* projectMessageHistoryItem(requestRecord([intentRecord()]), intentRecord(), {
        includeEndpointMask: true,
        templateUse: audit(),
      });
      // the first activation ended before the decision: only the one in force then explains the message
      expect(encodeItem(item).templateUse).toEqual({
        activation: {
          activatedAt: '2026-11-19T11:00:00.000Z',
          activatedByPrincipalId: REACTIVATOR,
          reason: 'Reinstated',
          scope: { kind: 'tenant' },
        },
        activeAtDecisionTime: true,
        contentDigest: 'd'.repeat(64),
        lifecycleState: 'active',
        revisionId: TEMPLATE_REVISION_ID,
        revisionNumber: 3,
        scope: { kind: 'tenant' },
        source: 'TENANT_REVISION',
      });
    }),
  );
});
