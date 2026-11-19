import { findPostgresFailure } from '@app/core-runtime';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { messageHistoryDetailRead } from '../../src/api/message-history-detail.read.ts';
import { messageHistoryListRead } from '../../src/api/message-history-list.read.ts';
import { MESSAGE_HISTORY_MAX_PAGE_SIZE, MessageHistoryCursorSchema } from '../../shared/message-history-read.ts';
import type { MessageHistoryListResultSchema } from '../../shared/message-history-read.ts';
import {
  attemptRetryLinks,
  communicationDecisions,
  communicationRequests,
  deliveryAttempts,
  intentHandoffStops,
  intentResendLinks,
  messageIntents,
  providerObservationConflicts,
  providerObservations,
} from '../../src/database/schema.ts';
import { profileRef } from '../unit/support/recipient-fixtures.ts';
import { messageHistoryReadService } from '../../src/services/message-history-read.service.ts';
import { accessReads, nativeRuntimeClient, operationalScopeOf, visibilityDouble } from '../support/access-reads.ts';
import type { AccessReadOptions } from '../support/access-reads.ts';
import { decideOne, ingest, minutesFromNow, step, targetOf } from '../support/history-world.ts';
import { communicationRequest, handoffDouble, originalRecipient } from '../support/intake-fixtures.ts';
import type { RequestInput } from '../support/intake-fixtures.ts';
import { decided, intakeWorld } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import { step22Double } from '../support/step22-observation-double.ts';

/**
 * [#1409] The public history Reads through Core's REAL Read lifecycle over REAL owner SQL on native PostgreSQL as the runtime
 * role. The access gate is a SCRIPT (not SpiceDB) and the source-owner visibility, the Messaging Adapter and the step 22
 * evidence are labelled doubles: this proves the lifecycle, the exact-scope queries, the projection and that nothing is
 * deleted or rewritten, NEVER an authorization graph, a provider delivery or a published document.
 */

const LIST = 'communications.core.message-history.list';
const LIST_MASK = 'communications.core.message-history-recipient-mask.list';
const READ = 'communications.core.message-history.read';
const READ_MASK = 'communications.core.message-history-recipient-mask.read';
const allowed = { [LIST]: 'allowed', [LIST_MASK]: 'allowed', [READ]: 'allowed', [READ_MASK]: 'allowed' } as const;
const LEGAL_ENTITY_ONE = 'a1111111-1111-4111-8111-111111111111';
const LEGAL_ENTITY_TWO = 'a2222222-2222-4222-8222-222222222222';
const RECIPIENTS = ['customer-1', 'customer-2'] as const;
const NOT_AN_INTENT = MessageIntentIdSchema.make('00000000-0000-4000-8000-00000000dead');
const visibleToAll = () => visibilityDouble(() => 'VISIBLE');
const encodeCursor = Schema.encodeSync(MessageHistoryCursorSchema);
const isTagged = Schema.is(Schema.Struct({ _tag: Schema.String }));

const setup = Effect.fn('HistoryAccessTest.setup')(function* setupWorld() {
  const client = yield* nativeRuntimeClient;
  const database = yield* makeRuntimeDatabase();
  const world = yield* intakeWorld(database, { recipients: RECIPIENTS });
  return { client, world };
});
type World = Effect.Success<ReturnType<typeof setup>>['world'];
type Client = Effect.Success<ReturnType<typeof setup>>['client'];
type Page = typeof MessageHistoryListResultSchema.Type;

interface ScopeOf {
  readonly counterpartyId?: string;
  readonly legalEntityId?: string;
  readonly occurrenceId: string;
  readonly profileId?: string;
  readonly recipient?: string;
}

/** The request under construction: the dimensions this scenario names, added only when it names them. */
interface RequestDraft {
  bindings: RequestInput['bindings'];
  counterpartyId?: string;
  legalEntityId?: string;
  occurrenceId: string;
  profileId?: string;
  tenantId: string;
}

/** Submits one request of an exact scope and returns the identities of its decided intents. */
const submit = Effect.fn('HistoryAccessTest.submit')(function* submitRequest(world: World, input: ScopeOf) {
  const request: RequestDraft = {
    bindings: [originalRecipient(input.recipient ?? 'customer-1')],
    occurrenceId: input.occurrenceId,
    tenantId: world.tenantId,
  };
  if (input.legalEntityId !== undefined) {
    request.legalEntityId = input.legalEntityId;
  }
  if (input.profileId !== undefined) {
    request.profileId = input.profileId;
  }
  if (input.counterpartyId !== undefined) {
    request.counterpartyId = input.counterpartyId;
  }
  const run = yield* world.runner.submit(
    world.tenantId,
    communicationRequest(request),
    '00000000-0000-4000-8000-0000000000a9',
    'fixture.source',
    input.legalEntityId,
  );
  const result = decided(run);
  return result.decision.kind === 'MESSAGE_INTENTS' ? result.decision.intents.map(({ intentId }) => intentId) : [];
});

/** The one intent a request of this scope decided, or a defect of the test. */
const submitOne = Effect.fn('HistoryAccessTest.submitOne')(function* submitSingle(world: World, input: ScopeOf) {
  const [intentId] = yield* submit(world, input);
  return yield* Option.match(Option.fromNullishOr(intentId), {
    onNone: () => Effect.die(`the request ${input.occurrenceId} decided no intent`),
    onSome: (found) => Effect.succeed(found),
  });
});

const readsOf = (client: Client, world: World, options: Partial<AccessReadOptions> = {}) =>
  accessReads(client, { access: allowed, tenantId: world.tenantId, ...options });

/** The tag of the typed failure of a Read: what the caller is told, never what the store holds. */
const failureOf = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((failure) => (isTagged(failure) ? failure._tag : 'untagged')),
  );

/** Every row of every history table of the world's Tenant, as the runtime role sees them. */
const historyRows = (world: World) =>
  world.database.inTenant(world.tenantId, (tx) =>
    Effect.all(
      {
        attempts: tx.select().from(deliveryAttempts),
        conflicts: tx.select().from(providerObservationConflicts),
        decisions: tx.select().from(communicationDecisions),
        intents: tx.select().from(messageIntents),
        observations: tx.select().from(providerObservations),
        requests: tx.select().from(communicationRequests),
        resends: tx.select().from(intentResendLinks),
        retries: tx.select().from(attemptRetryLinks),
        stops: tx.select().from(intentHandoffStops),
      },
      { concurrency: 1 },
    ),
  );

const idsOf = (page: Page) => page.items.map(({ intentId }) => intentId);
const cursorOf = (page: Page) =>
  Option.match(Option.fromNullishOr(page.nextCursor), {
    onNone: () => Effect.die('the page has no next cursor'),
    onSome: (cursor) => Effect.succeed(encodeCursor(cursor)),
  });

const sqlStateOf = (failure: Parameters<typeof findPostgresFailure>[0]) =>
  Option.match(findPostgresFailure(failure), { onNone: () => 'none', onSome: ({ code }) => code });

const ADDRESS_LIKE = /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]|https?:\/\/|<\/?[a-z][^>]*>|token|password|\botp\b/iu;

describe('The public history Reads over native PostgreSQL (#1409)', () => {
  it.live(
    '[S01 AC-01] an authorized worker reads the real, safe metadata of a message, list and detail, and nothing else',
    () =>
      Effect.gen(function* authorizedWorker() {
        const { client, world } = yield* setup();
        const { intentId } = yield* decideOne(world);
        yield* step(world, handoffDouble(), intentId);
        const [attempt] = yield* world.read((tx) => tx.select().from(deliveryAttempts));
        yield* ingest(
          world,
          step22Double.delivered(targetOf(world, intentId, attempt?.attemptId ?? ''), {
            key: 'evt-delivered-1',
            observedAt: yield* minutesFromNow(1),
          }),
        );
        const reads = yield* readsOf(client, world);
        const visibility = visibleToAll();
        const page = yield* reads.list().pipe(Effect.provide(visibility.layer));
        expect(page.items).toHaveLength(1);
        expect(page.nextCursor).toBeUndefined();
        const [item] = page.items;
        expect(item).toMatchObject({
          headline: { attention: 'NO_FAILURE', deliveryProven: true, status: 'DELIVERED' },
          intentId,
          recipient: { channel: 'email', role: 'original-recipient' },
          template: { language: 'cs', notice: 'TEMPLATE_PREVIEW_NOT_EXACT_SENT_EMAIL', revisionNumber: 1 },
        });
        expect(item?.recipient.endpointMask).toBeDefined();
        const detail = yield* reads.detail({ intentId }).pipe(Effect.provide(visibility.layer));
        expect(detail.message).toEqual(item);
        expect(detail.timeline.map(({ kind }) => kind)).toEqual(
          expect.arrayContaining(['INTENT_PREPARED', 'ATTEMPT_PREPARED', 'SUBMISSION_ANSWERED', 'PROVIDER_OBSERVED']),
        );
        // a tenant-level history has no narrower source scope: no owner was asked
        expect(visibility.asked).toEqual([]);
        for (const text of [JSON.stringify(page), JSON.stringify(detail)]) {
          expect(text).not.toMatch(ADDRESS_LIKE);
          expect(text).not.toMatch(/"(?:body|subject|html|text|content|payload|url|link)"/u);
        }
        expect(reads.harness.snapshot().evidenceWrites).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-01] pages by a stable cursor under ONE technical cap: no gap, no duplicate, new messages do not shift a page',
    () =>
      Effect.gen(function* paging() {
        const { client, world } = yield* setup();
        yield* Effect.forEach(['o1', 'o2', 'o3', 'o4', 'o5'], (occurrenceId) => submitOne(world, { occurrenceId }), {
          concurrency: 1,
        });
        // the order the store itself defines: newest first, the intent identity as the explicit tie-break
        const stored = yield* historyRows(world);
        const expectedOrder = stored.intents
          .toSorted(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime() || right.intentId.localeCompare(left.intentId),
          )
          .map(({ intentId }) => intentId);
        const reads = yield* readsOf(client, world);
        const visibility = visibleToAll();
        const first = yield* reads.list({ limit: 2 }).pipe(Effect.provide(visibility.layer));
        expect(first.items).toHaveLength(2);
        // a newer message arrives between the pages: the cursor is a position, so the next page is not shifted by it
        yield* submitOne(world, { occurrenceId: 'o6' });
        const second = yield* reads
          .list({ cursor: yield* cursorOf(first), limit: 2 })
          .pipe(Effect.provide(visibility.layer));
        const third = yield* reads
          .list({ cursor: yield* cursorOf(second), limit: 2 })
          .pipe(Effect.provide(visibility.layer));
        const seen = [...idsOf(first), ...idsOf(second), ...idsOf(third)];
        expect(new Set(seen).size).toBe(seen.length);
        // the five original messages come back in the store's order, without the one that arrived between the pages
        expect(seen).toEqual(expectedOrder);
        expect(third.nextCursor).toBeUndefined();
        // a limit above the cap is refused at decoding, never silently clamped
        const tag = yield* failureOf(
          reads.list({ limit: MESSAGE_HISTORY_MAX_PAGE_SIZE + 1 }).pipe(Effect.provide(visibility.layer)),
        );
        expect(tag).toBe('ReadInputValidationError');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S05 AC-02] a revoked permission denies the NEXT read at the gate and leaves every history row untouched',
    () =>
      Effect.gen(function* revoked() {
        const { client, world } = yield* setup();
        const { intentId } = yield* decideOne(world);
        const before = JSON.stringify(yield* historyRows(world));
        const visibility = visibleToAll();
        const granted = yield* readsOf(client, world);
        const read = yield* granted.detail({ intentId }).pipe(Effect.provide(visibility.layer));
        expect(read.message.intentId).toBe(intentId);
        const revokedReads = yield* readsOf(client, world, { access: 'denied' });
        expect(yield* failureOf(revokedReads.list().pipe(Effect.provide(visibility.layer)))).toBe(
          'ReadPermissionDenied',
        );
        expect(yield* failureOf(revokedReads.detail({ intentId }).pipe(Effect.provide(visibility.layer)))).toBe(
          'ReadPermissionDenied',
        );
        // refusing a read is not deleting: the handler never ran, and the history is byte for byte what it was
        expect(revokedReads.ownerStatements()).toBe(0);
        expect(JSON.stringify(yield* historyRows(world))).toBe(before);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S07 AC-07] an authorization that cannot be evaluated is an unavailable Read: no data, no empty success, no fallback',
    () =>
      Effect.gen(function* authorizationUnavailable() {
        const { client, world } = yield* setup();
        const { intentId } = yield* decideOne(world);
        const visibility = visibleToAll();
        const unavailable = yield* readsOf(client, world, { access: 'unavailable' });
        expect(yield* failureOf(unavailable.list().pipe(Effect.provide(visibility.layer)))).toBe(
          'ReadPermissionUnavailable',
        );
        expect(yield* failureOf(unavailable.detail({ intentId }).pipe(Effect.provide(visibility.layer)))).toBe(
          'ReadPermissionUnavailable',
        );
        // a grant that still needs an approval is not a grant to read
        const proposed = yield* readsOf(client, world, { access: 'needs_approval' });
        expect(yield* failureOf(proposed.list().pipe(Effect.provide(visibility.layer)))).toBe('ReadPermissionDenied');
        expect(unavailable.ownerStatements() + proposed.ownerStatements()).toBe(0);
        // each capability is its own question: the detail permission does not read the list, and the list permission
        // does not read a detail (nothing is implied between the keys)
        const detailOnly = yield* readsOf(client, world, { access: { [READ]: 'allowed' } });
        expect(yield* failureOf(detailOnly.list().pipe(Effect.provide(visibility.layer)))).toBe('ReadPermissionDenied');
        const listOnly = yield* readsOf(client, world, { access: { [LIST]: 'allowed' } });
        expect(yield* failureOf(listOnly.detail({ intentId }).pipe(Effect.provide(visibility.layer)))).toBe(
          'ReadPermissionDenied',
        );
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[S06 AC-03] another Tenant sees nothing of this one, list or detail, and cannot probe an identity', () =>
    Effect.gen(function* otherTenant() {
      const { client, world } = yield* setup();
      const { intentId } = yield* decideOne(world);
      const otherWorld = yield* intakeWorld(world.database, { recipients: RECIPIENTS });
      yield* submit(otherWorld, { occurrenceId: 'other-1' });
      const visibility = visibleToAll();
      const theirs = yield* readsOf(client, otherWorld);
      const page = yield* theirs.list().pipe(Effect.provide(visibility.layer));
      expect(page.items).toHaveLength(1);
      expect(idsOf(page)).not.toContain(intentId);
      // an identity of another Tenant is the same answer as an identity that does not exist
      expect(yield* failureOf(theirs.detail({ intentId }).pipe(Effect.provide(visibility.layer)))).toBe(
        'ReadHandlerNotFound',
      );
      expect(yield* failureOf(theirs.detail({ intentId: NOT_AN_INTENT }).pipe(Effect.provide(visibility.layer)))).toBe(
        'ReadHandlerNotFound',
      );
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-03] the scope is EXACT: a Legal Entity sees only its own history, the Tenant context only Tenant-level history',
    () =>
      Effect.gen(function* exactScope() {
        const { client, world } = yield* setup();
        const tenantLevel = yield* submitOne(world, { occurrenceId: 'tenant-level' });
        const entityOne = yield* submitOne(world, { legalEntityId: LEGAL_ENTITY_ONE, occurrenceId: 'le-one' });
        const entityTwo = yield* submitOne(world, { legalEntityId: LEGAL_ENTITY_TWO, occurrenceId: 'le-two' });
        const visibility = visibleToAll();
        const asEntityOne = yield* readsOf(client, world, { legalEntityId: LEGAL_ENTITY_ONE });
        expect(idsOf(yield* asEntityOne.list().pipe(Effect.provide(visibility.layer)))).toEqual([entityOne]);
        const asTenant = yield* readsOf(client, world);
        expect(idsOf(yield* asTenant.list().pipe(Effect.provide(visibility.layer)))).toEqual([tenantLevel]);
        // a detail of another scope is "not found", never a global fallback to the Tenant or to another Legal Entity
        for (const [reads, intentId] of [
          [asEntityOne, entityTwo],
          [asEntityOne, tenantLevel],
          [asTenant, entityOne],
        ] as const) {
          expect(yield* failureOf(reads.detail({ intentId }).pipe(Effect.provide(visibility.layer)))).toBe(
            'ReadHandlerNotFound',
          );
        }
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S04 AC-03] with ONLY the capabilities the Reads declare granted, both Reads succeed and return references only',
    () =>
      Effect.gen(function* noSourceAccess() {
        const { client, world } = yield* setup();
        const scoped = yield* submitOne(world, {
          counterpartyId: 'counterparty-1',
          legalEntityId: LEGAL_ENTITY_ONE,
          occurrenceId: 'order-1',
        });
        // the capabilities the two Reads DECLARE, read from their descriptors; the script grants exactly these and denies
        // every other key by default, so a Read that needed an Order, a Party, a Counterparty or a document capability
        // would be refused and this test would fail
        const declared = [messageHistoryListRead, messageHistoryDetailRead].flatMap(({ descriptor }) => [
          descriptor.accessDeclaration?.key ?? '',
          ...(descriptor.accessFieldGroups?.map(({ key }) => key) ?? []),
        ]);
        expect(declared).toHaveLength(4);
        expect(declared.every((key) => key.startsWith('communications.core.'))).toBe(true);
        const access = Object.fromEntries(declared.map((key) => [key, 'allowed' as const]));
        const reads = yield* readsOf(client, world, { access, legalEntityId: LEGAL_ENTITY_ONE });
        const visibility = visibleToAll();
        const page = yield* reads
          .list({ scope: { counterpartyRef: profileRef('counterparty-1') } })
          .pipe(Effect.provide(visibility.layer));
        expect(page.items).toHaveLength(1);
        const detail = yield* reads.detail({ intentId: scoped }).pipe(Effect.provide(visibility.layer));
        const [item] = page.items;
        // the source is only a reference: no Order, Counterparty, Party or document field exists in the result
        expect(item?.source.scope.counterpartyRef).toMatchObject({ resourceId: 'counterparty-1' });
        const allowedKeys = new Set([
          'decidedAt',
          'headline',
          'intentId',
          'lastEventAt',
          'recipient',
          'requestId',
          'slotKey',
          'source',
          'template',
          'type',
        ]);
        expect(Object.keys(item ?? {}).every((key) => allowedKeys.has(key))).toBe(true);
        expect(Object.keys(detail.message).every((key) => allowedKeys.has(key))).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-03 ACC-02] a source-scoped LIST needs the source owner: not visible is not found, an outage is unavailable, never empty',
    () =>
      Effect.gen(function* sourceVisibility() {
        const { client, world } = yield* setup();
        const scoped = yield* submitOne(world, { counterpartyId: 'counterparty-1', occurrenceId: 'scoped-1' });
        const reads = yield* readsOf(client, world);
        const selection = { scope: { counterpartyRef: profileRef('counterparty-1') } };
        const visible = visibilityDouble(() => 'VISIBLE');
        expect((yield* reads.list(selection).pipe(Effect.provide(visible.layer))).items).toHaveLength(1);
        expect(visible.asked).toHaveLength(1);
        expect(visible.asked[0]?.scope.counterpartyRef?.resourceId).toBe('counterparty-1');
        const hidden = visibilityDouble(() => 'NOT_VISIBLE');
        expect(yield* failureOf(reads.list(selection).pipe(Effect.provide(hidden.layer)))).toBe('ReadHandlerNotFound');
        expect(yield* failureOf(reads.detail({ intentId: scoped }).pipe(Effect.provide(hidden.layer)))).toBe(
          'ReadHandlerNotFound',
        );
        // a transient outage is a retryable unavailable Read; the caller named the scope, so it says nothing about a message
        const outage = visibilityDouble(() => 'UNAVAILABLE');
        expect(yield* failureOf(reads.list(selection).pipe(Effect.provide(outage.layer)))).toBe(
          'ReadHandlerUnavailable',
        );
        // no source owner is composed at all: no retry can ever succeed, so it is NOT told as a retryable outage
        const notComposed = visibilityDouble(() => 'NOT_COMPOSED');
        const structural = yield* failureOf(reads.list(selection).pipe(Effect.provide(notComposed.layer)));
        expect(structural).toBe('ReadHandlerExecutionError');
        expect(structural).not.toBe('ReadHandlerUnavailable');
        // the history of the SAME occurrence in the tenant-level scope is another scope: it is not here
        expect((yield* reads.list().pipe(Effect.provide(outage.layer))).items).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-03 ACC-02] a DETAIL cannot be used to probe existence: an owner that cannot answer looks exactly like absent or foreign',
    () =>
      Effect.gen(function* detailOracle() {
        const { client, world } = yield* setup();
        const own = yield* submitOne(world, {
          counterpartyId: 'counterparty-1',
          legalEntityId: LEGAL_ENTITY_ONE,
          occurrenceId: 'own-scoped',
        });
        const foreign = yield* submitOne(world, {
          counterpartyId: 'counterparty-1',
          legalEntityId: LEGAL_ENTITY_TWO,
          occurrenceId: 'foreign-scoped',
        });
        const tenantLevel = yield* submitOne(world, { legalEntityId: LEGAL_ENTITY_ONE, occurrenceId: 'plain' });
        const reads = yield* readsOf(client, world, { legalEntityId: LEGAL_ENTITY_ONE });
        const answers = [
          ['an owner outage', visibilityDouble(() => 'UNAVAILABLE')],
          ['no owner composed', visibilityDouble(() => 'NOT_COMPOSED')],
          ['not visible', visibilityDouble(() => 'NOT_VISIBLE')],
        ] as const;
        for (const [label, owner] of answers) {
          const outcomes = yield* Effect.forEach(
            [own, foreign, NOT_AN_INTENT],
            (intentId) => failureOf(reads.detail({ intentId }).pipe(Effect.provide(owner.layer))),
            { concurrency: 1 },
          );
          // an intent of the caller's own Legal Entity, a foreign one and a missing one are ONE answer, whatever the owner says
          expect({ label, outcomes }).toEqual({
            label,
            outcomes: ['ReadHandlerNotFound', 'ReadHandlerNotFound', 'ReadHandlerNotFound'],
          });
        }
        // a message of the caller's own scope that needs no owner is still readable while the owners are down
        const [[, outage]] = answers;
        expect(
          (yield* reads.detail({ intentId: tenantLevel }).pipe(Effect.provide(outage.layer))).message.intentId,
        ).toBe(tenantLevel);
        // and the visible own message is readable once its owner says so
        const visible = visibleToAll();
        expect((yield* reads.detail({ intentId: own }).pipe(Effect.provide(visible.layer))).message.intentId).toBe(own);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S06b AC-03] identical e-mail in two Parties and a shared mailbox are never merged: each scope and each recipient stands alone',
    () =>
      Effect.gen(function* sharedMailbox() {
        const { client, world } = yield* setup();
        // two Parties (profiles) whose recipients resolve to the SAME endpoint mask
        const partyA = yield* submitOne(world, { occurrenceId: 'same-mail', profileId: 'party-a' });
        const partyB = yield* submitOne(world, { occurrenceId: 'same-mail', profileId: 'party-b' });
        // two recipients that share one mailbox, in the same scope: two messages, two recipient references, never one merged
        const sharedOne = yield* submitOne(world, { occurrenceId: 'shared-1', recipient: 'customer-1' });
        const sharedTwo = yield* submitOne(world, { occurrenceId: 'shared-2', recipient: 'customer-2' });
        const reads = yield* readsOf(client, world);
        const onlyPartyB = visibilityDouble((query) =>
          query.scope.profileRef?.resourceId === 'party-b' ? 'VISIBLE' : 'NOT_VISIBLE',
        );
        const asB = yield* reads
          .list({ scope: { profileRef: profileRef('party-b') } })
          .pipe(Effect.provide(onlyPartyB.layer));
        expect(idsOf(asB)).toEqual([partyB]);
        // the same mask in another Party grants no history of the first: its owner says not visible, so it is not found
        expect(
          yield* failureOf(
            reads.list({ scope: { profileRef: profileRef('party-a') } }).pipe(Effect.provide(onlyPartyB.layer)),
          ),
        ).toBe('ReadHandlerNotFound');
        expect(yield* failureOf(reads.detail({ intentId: partyA }).pipe(Effect.provide(onlyPartyB.layer)))).toBe(
          'ReadHandlerNotFound',
        );
        const tenantPage = yield* reads.list().pipe(Effect.provide(visibleToAll().layer));
        const recipientOf = (id: string) => tenantPage.items.find(({ intentId }) => intentId === id)?.recipient;
        expect([recipientOf(sharedOne)?.ref.resourceId, recipientOf(sharedTwo)?.ref.resourceId]).toEqual([
          'customer-1',
          'customer-2',
        ]);
        expect(recipientOf(sharedOne)?.endpointMask).toBe(recipientOf(sharedTwo)?.endpointMask);
        // the identity of each message is its own: the mask never stands for a recipient, a Party or a profile
        expect(sharedOne).not.toBe(sharedTwo);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[ACC-01 field permission] a role without the mask permission reads the history without the masked recipient endpoint',
    () =>
      Effect.gen(function* maskPermission() {
        const { client, world } = yield* setup();
        const { intentId } = yield* decideOne(world);
        const visibility = visibleToAll();
        const reads = yield* readsOf(client, world, { access: { [LIST]: 'allowed', [READ]: 'allowed' } });
        const page = yield* reads.list().pipe(Effect.provide(visibility.layer));
        const detail = yield* reads.detail({ intentId }).pipe(Effect.provide(visibility.layer));
        expect(page.items[0]?.recipient).not.toHaveProperty('endpointMask');
        expect(detail.message.recipient).not.toHaveProperty('endpointMask');
        expect(page.items[0]?.recipient.ref.resourceId).toBe('customer-1');
        expect(JSON.stringify([page, detail])).not.toContain('example.test');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

/** A row filter that names a record scope: the gate can never produce one for these scope-wide Reads. */
const recordScopedFilter = (intentId: string): ListAccessPredicate => ({
  groups: [{ clauses: [{ conditions: [{ _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(intentId)] }] }] }],
});
const SCOPE_WIDE_FILTER: ListAccessPredicate = { groups: [] };

describe('The row filter of the list is never applied after the page was read (#1409, AUTHORIZATION: no fetch-then-filter)', () => {
  it('declares both Reads scope-wide, so no record selector is offered and only the all-in-scope filter can exist', () => {
    for (const read of [messageHistoryListRead, messageHistoryDetailRead]) {
      expect(read.descriptor.accessDeclaration?.selectors).toEqual([]);
      expect(read.descriptor.accessTarget).toBeUndefined();
    }
    expect(messageHistoryListRead.descriptor.accessKind).toBe('list');
  });

  it.live(
    '[listAccess] the all-in-scope filter pages exactly as no filter does, and a record-scoped filter yields NO page and NO cursor',
    () =>
      Effect.gen(function* rowFilter() {
        const { world } = yield* setup();
        const ids = yield* Effect.forEach(['f1', 'f2', 'f3'], (occurrenceId) => submitOne(world, { occurrenceId }), {
          concurrency: 1,
        });
        const scope = yield* operationalScopeOf({ access: allowed, tenantId: world.tenantId });
        const visibility = visibleToAll();
        const outcome = yield* world.database
          .inTenant(world.tenantId, (tx) =>
            Effect.gen(function* inTransaction() {
              const service = yield* messageHistoryReadService(tx, scope);
              const options = { includeEndpointMask: true };
              const unfiltered = yield* service.list({ limit: 2 }, options);
              const scopeWide = yield* service.list({ limit: 2 }, { ...options, listAccess: SCOPE_WIDE_FILTER });
              // a record-scoped filter on the newest, the oldest and an unrelated record: whatever it names, no short page with a
              // cursor (the hidden rows would leak through `more`), no page at all
              const filtered = yield* Effect.forEach(
                [ids[0] ?? '', ids[1] ?? '', ids[2] ?? '', NOT_AN_INTENT],
                (intentId) =>
                  Effect.all(
                    {
                      detail: failureOf(
                        service.detail(ids[0] ?? '', { ...options, listAccess: recordScopedFilter(intentId) }),
                      ),
                      list: failureOf(
                        service.list({ limit: 2 }, { ...options, listAccess: recordScopedFilter(intentId) }),
                      ),
                    },
                    { concurrency: 1 },
                  ),
                { concurrency: 1 },
              );
              return { filtered, scopeWide, unfiltered };
            }),
          )
          .pipe(Effect.provide(visibility.layer));
        expect(outcome.unfiltered.items).toHaveLength(2);
        expect(outcome.unfiltered.nextCursor).toBeDefined();
        expect(outcome.scopeWide).toEqual(outcome.unfiltered);
        expect(outcome.filtered).toEqual(
          Array.from({ length: 4 }, () => ({ detail: 'ReadHandlerExecutionError', list: 'ReadHandlerExecutionError' })),
        );
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('A page of the history is loaded with a bounded number of statements (#1409)', () => {
  it.live('[N+1] the owner statements of a list do not grow with the number of messages on the page', () =>
    Effect.gen(function* boundedStatements() {
      const { client, world } = yield* setup();
      yield* Effect.forEach(['n1', 'n2', 'n3', 'n4', 'n5'], (occurrenceId) => submitOne(world, { occurrenceId }), {
        concurrency: 1,
      });
      const visibility = visibleToAll();
      const one = yield* readsOf(client, world);
      expect((yield* one.list({ limit: 1 }).pipe(Effect.provide(visibility.layer))).items).toHaveLength(1);
      const many = yield* readsOf(client, world);
      expect((yield* many.list().pipe(Effect.provide(visibility.layer))).items).toHaveLength(5);
      // the page query plus the fixed set of history statements: the same for one message and for five
      expect(many.ownerStatements()).toBe(one.ownerStatements());
      expect(many.ownerStatements()).toBeLessThanOrEqual(10);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('History reads, refusals and permission changes never delete or rewrite (#1409, ACC-12, AC-08)', () => {
  it.live(
    '[S15 AC-08] a read after the retention window, a refusal and a page leave every row as it was, and the database itself refuses the destructive verbs',
    () =>
      Effect.gen(function* nothingDestroyed() {
        const { client, world } = yield* setup();
        const { intentId } = yield* decideOne(world);
        const before = JSON.stringify(yield* historyRows(world));
        const visibility = visibleToAll();
        // every Read runs a century after the rows were written: the read time branches nothing
        const reads = yield* readsOf(client, world);
        yield* reads.list({ limit: 1 }).pipe(Effect.provide(visibility.layer));
        yield* reads.detail({ intentId }).pipe(Effect.provide(visibility.layer));
        const denied = yield* readsOf(client, world, { access: 'denied' });
        yield* denied.list().pipe(Effect.provide(visibility.layer), Effect.ignore);
        yield* denied.detail({ intentId }).pipe(Effect.provide(visibility.layer), Effect.ignore);
        expect(JSON.stringify(yield* historyRows(world))).toBe(before);
        // the database itself refuses the destructive verbs to the runtime role the Reads run as: every one of them fails with
        // the privilege error (42501), not with an arbitrary failure of the statement
        const destructive = [
          world.read((tx) => tx.delete(messageIntents)),
          world.read((tx) => tx.delete(communicationRequests)),
          world.read((tx) => tx.delete(communicationDecisions)),
          world.read((tx) => tx.delete(deliveryAttempts)),
          world.read((tx) => tx.delete(providerObservations)),
          world.read((tx) => tx.update(messageIntents).set({ status: 'NOT_SENT' })),
          world.read((tx) => tx.update(communicationRequests).set({ purpose: 'x' })),
        ];
        const causes = yield* Effect.forEach(
          destructive,
          (attempt) =>
            attempt.pipe(
              Effect.flip,
              Effect.map((failure) => sqlStateOf(failure)),
            ),
          { concurrency: 1 },
        );
        expect(causes).toEqual(destructive.map(() => '42501'));
        expect(JSON.stringify(yield* historyRows(world))).toBe(before);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-08 ACC-12] provider success adds a fact and rewrites none: every earlier row is byte for byte unchanged',
    () =>
      Effect.gen(function* providerSuccess() {
        const { client, world } = yield* setup();
        const { intentId } = yield* decideOne(world);
        yield* step(world, handoffDouble(), intentId);
        const [attempt] = yield* world.read((tx) => tx.select().from(deliveryAttempts));
        const before = yield* historyRows(world);
        yield* ingest(
          world,
          step22Double.delivered(targetOf(world, intentId, attempt?.attemptId ?? ''), {
            key: 'evt-delivered-2',
            observedAt: yield* minutesFromNow(2),
          }),
        );
        const after = yield* historyRows(world);
        expect(after.observations).toHaveLength(before.observations.length + 1);
        for (const table of ['attempts', 'decisions', 'intents', 'requests', 'stops'] as const) {
          expect(JSON.stringify(after[table])).toBe(JSON.stringify(before[table]));
        }
        expect(JSON.stringify(after.observations.slice(0, before.observations.length))).toBe(
          JSON.stringify(before.observations),
        );
        const reads = yield* readsOf(client, world);
        const page = yield* reads.list().pipe(Effect.provide(visibleToAll().layer));
        expect(page.items[0]?.headline.status).toBe('DELIVERED');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
