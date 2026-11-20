import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Redacted } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationRequestIdSchema } from '../../shared/communication-intake.ts';
import { intentDocumentPins } from '../../src/database/schema.ts';
import { DocumentStopReasonSchema, stopIsProven } from '../../src/domain/documents/disclosure.ts';
import type { DocumentStopReason } from '../../src/domain/documents/disclosure.ts';
import { fixtureRecovery, fixtureType } from '../unit/support/catalog-fixtures.ts';
import { privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
import { assetRef, foreignAssetRef } from '../support/document-owner-double.ts';
import { historyOf, intentHistoryOf, intentIdAt } from '../support/history-world.ts';
import type { World } from '../support/history-world.ts';
import { communicationRequest, handoffDouble, originalRecipient } from '../support/intake-fixtures.ts';
import { decided, intakeWorld } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import { answers, kindOf, recoveriesOf, stepWith, stopsOf } from '../support/recovery-world.ts';

/**
 * [#1409] The document disclosure of the pre-handoff step, on native PostgreSQL as the runtime role and through the REAL scoped
 * routines. Core Media V1 and the document owners do not exist yet (#1443, #1446): the owner is the LABELLED DOUBLE of the
 * port, so these tests prove how Communications ASKS, pins and stops, never that a real Media Asset is stored or authorized.
 * The Messaging Adapter is a labelled double too and records every call, so "nothing was submitted" is a measured fact.
 */
const setup = (types: readonly ReturnType<typeof fixtureType>[]) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, { types })));

const policy = (attachment = false) => ({
  attachment: attachment ? { approvalKey: 'fixture.rule.attachment', kind: 'APPROVED' } : { kind: 'NOT_ALLOWED' },
  classification: 'fixture.classification.customer',
  documentOwner: 'fixture.documents',
  link: 'ALLOWED',
  recipientScope: 'ORIGINAL_RECIPIENT',
});
const linkType = (overrides: Parameters<typeof fixtureType>[0] = {}) =>
  fixtureType({ documents: policy(), ...overrides });
const recoverableLinkType = () => linkType({ recovery: fixtureRecovery(3) });

type NamedDocument = NonNullable<Parameters<typeof communicationRequest>[0]['documents']>[number];

/** One request that names `documents`, decided through the public intake. */
const decideWith = Effect.fn('DocumentDisclosureTest.decideWith')(function* decideRequest(
  world: World,
  documents: readonly NamedDocument[],
  occurrenceId = 'fixture-occurrence-1',
) {
  const run = yield* world.runner.submit(
    world.tenantId,
    communicationRequest({
      bindings: [originalRecipient('customer-1')],
      documents,
      occurrenceId,
      tenantId: world.tenantId,
    }),
  );
  const result = decided(run);
  const intents = result.decision.kind === 'MESSAGE_INTENTS' ? result.decision.intents : [];
  return { intentId: yield* intentIdAt(intents), requestId: CommunicationRequestIdSchema.make(result.requestId) };
});

const pinsOf = (world: World, intentId: string) =>
  world.read((tx) =>
    tx
      .select()
      .from(intentDocumentPins)
      .where(and(eq(intentDocumentPins.tenantId, world.tenantId), eq(intentDocumentPins.intentId, intentId))),
  );

/** The provider refuses the first attempt (a temporary refusal) and accepts every later one. */
const refusedThenAccepted = () => {
  let answered = 0;
  return handoffDouble(() => {
    const answer = answered === 0 ? answers.rateLimited : answers.accepted;
    answered += 1;
    return answer();
  });
};

const stoppedReasons = (processing: Effect.Success<ReturnType<typeof stepWith>>) =>
  processing.kind === 'STOPPED'
    ? processing.reasons.map(({ category, proven }) => `${category}:${String(proven)}`)
    : [];

const sqlStateOf = (failure: Parameters<typeof findPostgresFailure>[0]) =>
  Option.match(findPostgresFailure(failure), { onNone: () => 'none', onSome: ({ code }) => code });

describe('a message type without documents is exactly what it always was (#1409)', () => {
  it.live('a request that names no document never asks the owner, pins nothing and hands off no document', () =>
    Effect.gen(function* noDocuments() {
      for (const type of [fixtureType(), linkType()]) {
        const world = yield* setup([type]);
        const handoff = handoffDouble();
        const { intentId } = yield* decideWith(world, []);
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('HANDED_OFF');
        expect(handoff.calls).toHaveLength(1);
        expect(handoff.calls[0]).not.toHaveProperty('documents');
        expect(world.documents.asked).toEqual([]);
        expect(yield* pinsOf(world, intentId)).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('a document named for a type that approved none is a proven stop, never silently dropped', () =>
    Effect.gen(function* notApproved() {
      const world = yield* setup([fixtureType()]);
      const handoff = handoffDouble();
      const { intentId } = yield* decideWith(world, [{ documentId: 'doc-1' }]);
      const processing = yield* stepWith(world, handoff, intentId);
      expect(stoppedReasons(processing)).toEqual(['DOCUMENT_NOT_APPROVED_FOR_TYPE:true']);
      expect(handoff.calls).toEqual([]);
      expect(world.documents.asked).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('a document-bearing type end to end through the worker (#1409)', () => {
  it.live(
    'a LINK is the default: the owner approves, the exact Asset is pinned and handed off as a reference only',
    () =>
      Effect.gen(function* link() {
        const world = yield* setup([linkType()]);
        world.documents.assign('doc-1', assetRef('asset-1'));
        const handoff = handoffDouble();
        const { intentId, requestId } = yield* decideWith(world, [{ documentId: 'doc-1' }]);
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('HANDED_OFF');
        expect(handoff.calls[0]?.documents).toEqual([
          {
            document: {
              moduleId: 'fixture.documents',
              resourceId: 'doc-1',
              resourceType: 'fixture.documents.document',
            },
            form: 'LINK',
            link: { assetRef: assetRef('asset-1'), revision: 1 },
          },
        ]);
        // the recipient and Privacy gates were asked in the SAME evaluation, before the owner and before the handoff
        expect(world.privacy.queries.length).toBeGreaterThan(0);
        expect(world.documents.asked).toEqual([{ kind: 'resolve', subject: 'LINK:doc-1' }]);
        expect(yield* pinsOf(world, intentId)).toMatchObject([
          {
            assetId: 'asset-1',
            assetModule: 'core.media',
            assetType: 'core.media.asset',
            form: 'LINK',
            position: 0,
            revision: 1,
          },
        ]);
        // nothing but references travels: no URL and no byte has a field
        expect(JSON.stringify(handoff.calls[0]?.documents)).not.toMatch(/https?:|bytes|url/iu);
        expect((yield* intentHistoryOf(world, requestId)).history.summary.status).toBe('PROVIDER_ACCEPTED');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'an ATTACHMENT needs the type approval, the owner approval and the Current recipient and Privacy before it is submitted',
    () =>
      Effect.gen(function* attachment() {
        const world = yield* setup([linkType({ documents: policy(true) })]);
        world.documents.assign('doc-1', assetRef('asset-1'));
        const handoff = handoffDouble();
        const { intentId } = yield* decideWith(world, [{ documentId: 'doc-1', form: 'ATTACHMENT' }]);
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('HANDED_OFF');
        expect(handoff.calls[0]?.documents?.[0]).toMatchObject({ form: 'ATTACHMENT', link: { revision: 1 } });
        expect(world.documents.asked).toEqual([{ kind: 'resolve', subject: 'ATTACHMENT:doc-1' }]);
        // a type that approved only the link never discloses an attachment, and never even asks the owner
        const linkOnly = yield* setup([linkType()]);
        linkOnly.documents.assign('doc-1', assetRef('asset-1'));
        const refused = handoffDouble();
        const second = yield* decideWith(linkOnly, [{ documentId: 'doc-1', form: 'ATTACHMENT' }]);
        expect(stoppedReasons(yield* stepWith(linkOnly, refused, second.intentId))).toEqual([
          'ATTACHMENT_NOT_APPROVED_FOR_TYPE:true',
        ]);
        expect(refused.calls).toEqual([]);
        expect(linkOnly.documents.asked).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'the Current recipient and Privacy gates come first: a message they stop never reaches the document owner',
    () =>
      Effect.gen(function* gatesFirst() {
        const world = yield* setup([linkType({ documents: policy(true) })]);
        world.documents.assign('doc-1', assetRef('asset-1'));
        const handoff = handoffDouble();
        const { intentId } = yield* decideWith(world, [{ documentId: 'doc-1', form: 'ATTACHMENT' }]);
        // Privacy changed after the decision: the step asks it again NOW
        world.privacy.answers.set('customer-1', privacyNotAllowed());
        const processing = yield* stepWith(world, handoff, intentId);
        expect(processing.kind).toBe('STOPPED');
        expect(stoppedReasons(processing).some((reason) => reason.startsWith('DOCUMENT_'))).toBe(false);
        expect(world.documents.asked).toEqual([]);
        expect(handoff.calls).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

interface StopCase {
  readonly assign?: Parameters<World['documents']['assign']>[2] & { readonly asset?: ReturnType<typeof assetRef> };
  readonly document?: Partial<NamedDocument>;
  readonly outage?: boolean;
  readonly reason: DocumentStopReason;
  readonly type?: ReturnType<typeof fixtureType>;
}

const STOP_CASES: readonly StopCase[] = [
  { document: { moduleId: 'fixture.other-module' }, reason: 'DOCUMENT_OWNER_MISMATCH' },
  { document: { classification: 'fixture.classification.other' }, reason: 'DOCUMENT_CLASSIFICATION_MISMATCH' },
  { document: { recipientScope: 'ANOTHER_RECIPIENT' }, reason: 'DOCUMENT_RECIPIENT_SCOPE_MISMATCH' },
  { assign: { asset: foreignAssetRef('foreign-1') }, reason: 'DOCUMENT_ASSET_NOT_CORE_MEDIA' },
  { assign: { disclosure: 'FORBIDDEN' }, reason: 'DOCUMENT_OWNER_FORBIDDEN' },
  { assign: { claimedRevision: 2 }, reason: 'DOCUMENT_REVISION_NOT_CURRENT' },
  { assign: { media: 'UNAVAILABLE' }, reason: 'DOCUMENT_MEDIA_UNAVAILABLE' },
  { outage: true, reason: 'DOCUMENT_OWNER_UNAVAILABLE' },
];

describe('every document stop reason is truthful, closed and visible to the source (#1409)', () => {
  it('lists the vocabulary: a policy mismatch is proven, a media or owner that could not answer is not', () => {
    expect(DocumentStopReasonSchema.literals.filter((reason) => !stopIsProven(reason)).toSorted()).toEqual([
      'DOCUMENT_MEDIA_UNAVAILABLE',
      'DOCUMENT_OWNER_UNAVAILABLE',
      'DOCUMENT_PRIVACY_INDETERMINATE',
      'DOCUMENT_RECIPIENT_UNKNOWN',
    ]);
  });

  for (const stopCase of STOP_CASES) {
    it.live(`stops with ${stopCase.reason}, submits nothing and shows the reason in the history and the feed`, () =>
      Effect.gen(function* stops() {
        const world = yield* setup([stopCase.type ?? linkType()]);
        const { asset, ...overrides } = stopCase.assign ?? {};
        world.documents.assign('doc-1', asset ?? assetRef('asset-1'), overrides);
        world.documents.setOutage(stopCase.outage === true);
        const handoff = handoffDouble();
        const { intentId, requestId } = yield* decideWith(world, [{ documentId: 'doc-1', ...stopCase.document }]);
        const proven = stopIsProven(stopCase.reason);
        expect(stoppedReasons(yield* stepWith(world, handoff, intentId))).toEqual([
          `${stopCase.reason}:${String(proven)}`,
        ]);
        expect(handoff.calls).toEqual([]);
        expect(yield* pinsOf(world, intentId)).toEqual([]);
        // an unproven stop holds the message for a new evaluation; a proven one is a failure the source owner decides on
        const record = yield* intentHistoryOf(world, requestId);
        expect(record.history.summary.status).toBe(proven ? 'SUPPRESSED' : 'HELD_UNPROVEN');
        const { feed } = yield* historyOf(world, requestId);
        expect(feed.messages[0]?.attention).toBe(proven ? 'FAILURE' : 'NEEDS_REEVALUATION');
        expect(record.history.entries.flatMap(({ reasonCodes }) => reasonCodes)).toContain(stopCase.reason);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
    );
  }

  it.live('an unavailable media or owner is recoverable by the next evaluation; a proven stop is final', () =>
    Effect.gen(function* recoverable() {
      const world = yield* setup([linkType()]);
      world.documents.assign('doc-1', assetRef('asset-1'), { media: 'UNAVAILABLE' });
      const handoff = handoffDouble();
      const { intentId, requestId } = yield* decideWith(world, [{ documentId: 'doc-1' }]);
      expect(stoppedReasons(yield* stepWith(world, handoff, intentId))).toEqual(['DOCUMENT_MEDIA_UNAVAILABLE:false']);
      world.documents.setOutage(true);
      expect(stoppedReasons(yield* stepWith(world, handoff, intentId))).toEqual(['DOCUMENT_OWNER_UNAVAILABLE:false']);
      expect(yield* stopsOf(world, intentId)).toHaveLength(2);
      expect(handoff.calls).toEqual([]);
      // the owner answers again: evaluation N+1 supersedes the unproven stops and the message goes out with its pin
      world.documents.setOutage(false);
      world.documents.assign('doc-1', assetRef('asset-1'));
      expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('HANDED_OFF');
      expect(handoff.calls).toHaveLength(1);
      expect((yield* intentHistoryOf(world, requestId)).history.summary.status).toBe('PROVIDER_ACCEPTED');
      // a proven stop is final whatever the owner says later
      const final = yield* setup([linkType()]);
      final.documents.assign('doc-1', assetRef('asset-1'));
      const second = yield* decideWith(final, [{ documentId: 'doc-1', moduleId: 'fixture.other-module' }]);
      expect(stoppedReasons(yield* stepWith(final, handoff, second.intentId))).toEqual([
        'DOCUMENT_OWNER_MISMATCH:true',
      ]);
      expect(kindOf(yield* stepWith(final, handoff, second.intentId))).toBe('SKIPPED:ALREADY_STOPPED');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('a Technical Retry hands off the SAME pinned Asset (#1409)', () => {
  it.live('the owner confirms the pin again and the retry carries the very same link', () =>
    Effect.gen(function* samePin() {
      const world = yield* setup([recoverableLinkType()]);
      world.documents.assign('doc-1', assetRef('asset-1'));
      const handoff = refusedThenAccepted();
      const { intentId } = yield* decideWith(world, [{ documentId: 'doc-1' }]);
      yield* stepWith(world, handoff, intentId);
      yield* stepWith(world, handoff, intentId);
      expect(handoff.calls).toHaveLength(2);
      expect(handoff.calls[1]?.documents).toEqual(handoff.calls[0]?.documents);
      // every Current question was asked again, and still exactly one pin exists
      expect(world.documents.asked).toHaveLength(2);
      expect(yield* pinsOf(world, intentId)).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('an owner that now names ANOTHER Asset never repoints the message: the retry stops, the pin stays', () =>
    Effect.gen(function* repointed() {
      const world = yield* setup([recoverableLinkType()]);
      world.documents.assign('doc-1', assetRef('asset-1'));
      const handoff = handoffDouble(answers.rateLimited);
      const { intentId, requestId } = yield* decideWith(world, [{ documentId: 'doc-1' }]);
      yield* stepWith(world, handoff, intentId);
      // new bytes are a NEW Asset and a new request: the owner now resolves the document to another Asset
      world.documents.assign('doc-1', assetRef('asset-2'));
      expect(stoppedReasons(yield* stepWith(world, handoff, intentId))).toEqual(['DOCUMENT_PIN_NOT_CURRENT:true']);
      expect(handoff.calls).toHaveLength(1);
      expect(yield* pinsOf(world, intentId)).toMatchObject([{ assetId: 'asset-1' }]);
      expect(yield* recoveriesOf(world, intentId)).toMatchObject([
        { code: 'DOCUMENT_PIN_NOT_CURRENT', outcome: 'STOPPED', proven: true },
      ]);
      const { feed } = yield* historyOf(world, requestId);
      expect(feed.messages[0]).toMatchObject({ attention: 'FAILURE', reason: 'DOCUMENT_PIN_NOT_CURRENT' });
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('an owner outage at the retry only holds it: the next evaluation continues with the same pin', () =>
    Effect.gen(function* outage() {
      const world = yield* setup([recoverableLinkType()]);
      world.documents.assign('doc-1', assetRef('asset-1'));
      const handoff = refusedThenAccepted();
      const { intentId, requestId } = yield* decideWith(world, [{ documentId: 'doc-1' }]);
      yield* stepWith(world, handoff, intentId);
      world.documents.setOutage(true);
      expect(stoppedReasons(yield* stepWith(world, handoff, intentId))).toEqual(['DOCUMENT_OWNER_UNAVAILABLE:false']);
      expect(handoff.calls).toHaveLength(1);
      const { feed } = yield* historyOf(world, requestId);
      expect(feed.messages[0]).toMatchObject({ attention: 'NEEDS_REEVALUATION', reason: 'DOCUMENT_OWNER_UNAVAILABLE' });
      world.documents.setOutage(false);
      expect(kindOf(yield* stepWith(world, handoff, intentId))).toBe('HANDED_OFF');
      expect(handoff.calls[1]?.documents).toEqual(handoff.calls[0]?.documents);
      expect(yield* pinsOf(world, intentId)).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

const adminClient = loadDatabaseConnectionPair().pipe(
  Effect.flatMap(({ admin }) => PgClient.makeClient({ url: Redacted.make(admin.connectionString) })),
);

describe('the pin table and its routine on PostgreSQL (#1409)', () => {
  it.live('the first writer wins, nothing edits or removes a pin, and the runtime role can only read it', () =>
    Effect.gen(function* pins() {
      const world = yield* setup([linkType()]);
      world.documents.assign('doc-1', assetRef('asset-1'));
      const { intentId } = yield* decideWith(world, [{ documentId: 'doc-1' }]);
      const pin = (assetId: string, tenantId = world.tenantId) =>
        world.database.inTenant(world.tenantId, (tx) =>
          tx
            .select({
              result: sql<{
                readonly outcome: string;
                readonly pin?: { readonly assetRef: { resourceId: string } };
              }>`routine.result`,
            })
            .from(
              sql`communications.worker_pin_document(${tenantId}::uuid, ${intentId}::uuid, 0, 'fixture.documents', 'fixture.documents.document', 'doc-1', 'fixture.classification.customer', 'LINK', 'core.media', 'core.media.asset', ${assetId}, 1) as routine(result)`,
            ),
        );
      expect((yield* pin('asset-1'))[0]?.result).toMatchObject({
        outcome: 'PINNED',
        pin: { assetRef: { resourceId: 'asset-1' } },
      });
      // a second answer never replaces the stored one: the stored pin is what comes back
      expect((yield* pin('asset-2'))[0]?.result).toMatchObject({
        outcome: 'EXISTS',
        pin: { assetRef: { resourceId: 'asset-1' } },
      });
      expect(sqlStateOf(yield* Effect.flip(pin('asset-3', '99999999-9999-4999-8999-999999999999')))).toBe('42501');
      const admin = yield* adminClient;
      for (const mutation of [
        `update communications.intent_document_pins set asset_id = 'other' where tenant_id = '${world.tenantId}'`,
        `delete from communications.intent_document_pins where tenant_id = '${world.tenantId}'`,
      ]) {
        const failure = yield* Effect.flip(
          admin.withTransaction(
            Effect.gen(function* inOwnerScope() {
              yield* admin.unsafe(`select set_config('ontos.tenant_id', $1, true)`, [world.tenantId]);
              return yield* admin.unsafe(mutation);
            }),
          ),
        );
        expect(sqlStateOf(failure)).toBe('55000');
      }
      const pinnedAt = yield* DateTime.nowAsDate;
      const insert = world.database.inTenant(world.tenantId, (tx) =>
        tx.insert(intentDocumentPins).values({
          assetId: 'asset-9',
          assetModule: 'core.media',
          assetType: 'core.media.asset',
          classification: 'fixture.classification.customer',
          documentId: 'doc-9',
          documentModule: 'fixture.documents',
          documentType: 'fixture.documents.document',
          form: 'LINK',
          intentId,
          pinnedAt,
          position: 5,
          revision: 1,
          tenantId: world.tenantId,
        }),
      );
      expect(sqlStateOf(yield* Effect.flip(insert))).toBe('42501');
      expect(yield* pinsOf(world, intentId)).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
