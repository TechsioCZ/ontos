import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationRequestIdSchema } from '../../shared/communication-intake.ts';
import { MessageHistoryCursorSchema } from '../../shared/message-history-read.ts';
import { accessReads, nativeRuntimeClient, visibilityDouble } from '../support/access-reads.ts';
import { decideOne } from '../support/history-world.ts';
import { communicationRequest, originalRecipient } from '../support/intake-fixtures.ts';
import { decided, intakeWorld } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import { fixtureType, noMessageType } from '../unit/support/catalog-fixtures.ts';

/**
 * [#1402 H-01 AC-01, #1398 AC-02] A request the catalog decided NO message for is a readable row of the public history Reads,
 * paged with the messages, and the template audit rides its own field permission. Core's REAL Read lifecycle over REAL owner
 * SQL on native PostgreSQL as the runtime role; the access gate is a SCRIPT and the source-owner visibility a labelled double
 * (see `message-history-access.test.ts`): this proves the lifecycle and the owner's queries, never an authorization graph.
 */
const LIST = 'communications.core.message-history.list';
const LIST_MASK = 'communications.core.message-history-recipient-mask.list';
const READ = 'communications.core.message-history.read';
const READ_MASK = 'communications.core.message-history-recipient-mask.read';
const READ_TEMPLATE_USE = 'communications.core.message-history-template-use.read';
const allowed = {
  [LIST]: 'allowed',
  [LIST_MASK]: 'allowed',
  [READ]: 'allowed',
  [READ_MASK]: 'allowed',
  [READ_TEMPLATE_USE]: 'allowed',
} as const;
const encodeCursor = Schema.encodeSync(MessageHistoryCursorSchema);
const isTagged = Schema.is(Schema.Struct({ _tag: Schema.String }));

const setup = Effect.fn('HistoryRequestRowsTest.setup')(function* setupWorld() {
  const client = yield* nativeRuntimeClient;
  const database = yield* makeRuntimeDatabase();
  const world = yield* intakeWorld(database, { recipients: ['customer-1'], types: [fixtureType(), noMessageType] });
  return { client, world };
});

const failureOf = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((failure) => (isTagged(failure) ? failure._tag : 'untagged')),
  );

describe('The history shows a request the catalog decided no message for, and the template audit by its own permission', () => {
  it.live(
    '[H-01 AC-01] a no-message request is a row of the list and of the detail by its request, and pages with the messages',
    () =>
      Effect.gen(function* noMessageRow() {
        const { client, world } = yield* setup();
        const visible = visibilityDouble(() => 'VISIBLE');
        const prepared = yield* decideOne(world, 'customer-1', 'o-prepared');
        const quiet = decided(
          yield* world.runner.submit(
            world.tenantId,
            communicationRequest({
              bindings: [originalRecipient('customer-1')],
              occurrenceId: 'o-quiet',
              purpose: noMessageType.purpose,
              tenantId: world.tenantId,
            }),
          ),
        );
        const reads = yield* accessReads(client, { access: allowed, tenantId: world.tenantId });
        const page = yield* reads.list().pipe(Effect.provide(visible.layer));
        expect(page.items.map(({ intentId }) => intentId)).toEqual([prepared.intentId]);
        expect(page.requests).toMatchObject([
          {
            headline: { reasonCodes: ['APPROVED_NO_MESSAGE'], status: 'NO_MESSAGE' },
            requestId: quiet.requestId,
            unresolvedSlots: [],
          },
        ]);

        // a page of one row never loses a row: both rows are reached through the cursor, each exactly once
        const first = yield* reads.list({ limit: 1 }).pipe(Effect.provide(visible.layer));
        expect(first.items.length + (first.requests?.length ?? 0)).toBe(1);
        expect(first.nextCursor).toBeDefined();
        const cursor = Option.map(Option.fromUndefinedOr(first.nextCursor), encodeCursor);
        const second = yield* reads
          .list(
            Option.match(cursor, { onNone: () => ({ limit: 1 }), onSome: (found) => ({ cursor: found, limit: 1 }) }),
          )
          .pipe(Effect.provide(visible.layer));
        expect(second.nextCursor).toBeUndefined();
        expect([...first.items, ...second.items].map(({ intentId }) => intentId)).toEqual([prepared.intentId]);
        expect([...(first.requests ?? []), ...(second.requests ?? [])].map(({ requestId }) => requestId)).toEqual([
          quiet.requestId,
        ]);

        const detail = yield* reads.requestDetail({ requestId: quiet.requestId }).pipe(Effect.provide(visible.layer));
        expect(detail).toMatchObject({ request: { headline: { status: 'NO_MESSAGE' }, requestId: quiet.requestId } });
        // a request whose messages all exist has no request-level row, and an unknown one is the same answer
        expect(
          yield* failureOf(reads.requestDetail({ requestId: prepared.requestId }).pipe(Effect.provide(visible.layer))),
        ).toBe('ReadHandlerNotFound');
        expect(
          yield* failureOf(
            reads
              .requestDetail({ requestId: CommunicationRequestIdSchema.make('00000000-0000-4000-8000-00000000dead') })
              .pipe(Effect.provide(visible.layer)),
          ),
        ).toBe('ReadHandlerNotFound');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[T-07] the template audit names the activation of the revision a message used and is omitted without its permission',
    () =>
      Effect.gen(function* templateAudit() {
        const { client, world } = yield* setup();
        const visible = visibilityDouble(() => 'VISIBLE');
        const { intentId } = yield* decideOne(world);
        const granted = yield* accessReads(client, { access: allowed, tenantId: world.tenantId });
        const read = yield* granted.detail({ intentId }).pipe(Effect.provide(visible.layer));
        expect(read.message.templateUse).toMatchObject({ lifecycleState: 'active', source: 'TENANT_REVISION' });
        expect(read.message.templateUse?.activation).toBeDefined();
        // the preview marker stays: the revision is never the exact sent e-mail
        expect(read.message.template?.notice).toBe('TEMPLATE_PREVIEW_NOT_EXACT_SENT_EMAIL');

        const withoutAudit = yield* accessReads(client, {
          access: { ...allowed, [READ_TEMPLATE_USE]: 'denied' },
          tenantId: world.tenantId,
        });
        const hidden = yield* withoutAudit.detail({ intentId }).pipe(Effect.provide(visible.layer));
        expect(hidden.message).not.toHaveProperty('templateUse');
        expect(hidden.message.template).toBeDefined();
        // the list never carries the audit: it is a detail field
        const page = yield* granted.list().pipe(Effect.provide(visible.layer));
        for (const item of page.items) {
          expect(item).not.toHaveProperty('templateUse');
        }
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
