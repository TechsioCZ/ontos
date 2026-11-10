import {
  UpdateTagActionConflictProblemSchema,
  UpdateTagActionUnavailableProblemSchema,
} from '../../shared/apis/update-tag-action.ts';
import { startDraftSave } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TagIdSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse, Tag } from '../../shared/apis/records.ts';
import {
  sameTagDraft,
  tagDraftOf,
  tagFieldsOf,
  tagSaveResult,
  tagUnchangedSince,
  validTagDraft,
} from '../../src/routes/[lang]/nastaveni/stitky/tag-draft.ts';
import type { TagDraft } from '../../src/routes/[lang]/nastaveni/stitky/tag-draft.ts';

const now = DateTime.makeUnsafe('2026-11-01T10:00:00Z');
const vip: Tag = {
  color: 'green',
  createdAt: now,
  id: Schema.decodeUnknownSync(TagIdSchema)('tag-vip'),
  name: 'VIP',
  subjectKinds: ['order', 'customer'],
  updatedAt: now,
};
const records = (tags: readonly Tag[]): RecordsResponse => ({
  assignments: [],
  canWrite: true,
  indicators: { assignmentCount: 0, tagCount: tags.length },
  revision: 7,
  tags: tags.map((tag) => ({ ...tag, counts: { customer: 0, employee: 0, opportunity: 0, order: 0, product: 0 } })),
});
const saved = tagDraftOf(vip);

describe('tag edit draft', () => {
  it('treats spaces and kind order as no change', () => {
    expect(sameTagDraft(saved, { ...saved, kinds: ['customer', 'order'], name: ' VIP ' })).toBe(true);
    expect(sameTagDraft(saved, { ...saved, name: 'VIP klient' })).toBe(false);
  });

  it('never saves a tag without a name, with a name over 60 characters or without a kind', () => {
    expect(validTagDraft(saved)).toBe(true);
    expect(validTagDraft({ ...saved, name: '  ' })).toBe(false);
    expect(validTagDraft({ ...saved, name: 'x'.repeat(61) })).toBe(false);
    expect(validTagDraft({ ...saved, kinds: [] })).toBe(false);
  });

  it('sends trimmed fields and clears an emptied description', () => {
    expect(tagFieldsOf({ ...saved, description: ' ', name: ' VIP klient ' })).toEqual({
      color: 'green',
      description: '',
      name: 'VIP klient',
      subjectKinds: ['customer', 'order'],
    });
  });

  it('writes only while the owner still has the version the draft builds on', () => {
    const other: Tag = { ...vip, id: Schema.decodeUnknownSync(TagIdSchema)('tag-other'), name: 'Jiný' };
    expect(tagUnchangedSince(vip.id, saved)(records([vip, { ...other, color: 'red' }]))).toBe(true);
    expect(tagUnchangedSince(vip.id, saved)(records([{ ...vip, color: 'red' }]))).toBe(false);
    expect(tagUnchangedSince(vip.id, saved)(records([other]))).toBe(false);
  });
});

const isConflict = UpdateTagActionConflictProblemSchema.make({
  code: 'tagging_revision_conflict',
  detail: 'The tag changed',
  status: 409,
  title: 'Conflict',
  type: 'urn:ontos:test:tag-revision',
});

const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-10T12:00:00.000Z',
  proposalId: '60000000-0000-4000-8000-000000000001',
});

const unavailable = UpdateTagActionUnavailableProblemSchema.make({
  code: 'tagging_persistence_unavailable',
  detail: 'The owner is unavailable',
  retryable: true,
  status: 503,
  title: 'Unavailable',
  type: 'urn:ontos:test:tag-unavailable',
});

const panel = Effect.fnUntraced(function* panel(write: Effect.Effect<'applied' | 'stale', unknown>) {
  const sent: TagDraft[] = [];
  const controller = yield* startDraftSave(saved, {
    equals: sameTagDraft,
    isValid: validTagDraft,
    save: (value: TagDraft) =>
      Effect.sync(() => sent.push(value)).pipe(
        Effect.andThen(tagSaveResult(write)),
        Effect.map((result): SaveOutcome => (Predicate.isNumber(result) ? 'saved' : result)),
      ),
  });
  return { controller, sent };
});

describe('tag edit panel save', () => {
  it.live('sends nothing while the draft only changes, and one update on Save', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel(Effect.succeed('applied'));
      controller.change({ ...saved, name: 'VIP klient' });
      expect(controller.status()).toBe('dirty');
      yield* Effect.sleep('1 second');
      expect(sent).toEqual([]);
      controller.save();
      yield* Effect.yieldNow;
      expect(sent.map(({ name }) => name)).toEqual(['VIP klient']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('keeps a draft without a kind local', () =>
    Effect.gen(function* invalid() {
      const { controller, sent } = yield* panel(Effect.succeed('applied'));
      controller.change({ ...saved, kinds: [] });
      controller.save();
      yield* Effect.yieldNow;
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('invalid');
    }),
  );

  it.effect('discarding goes back to the confirmed version without sending', () =>
    Effect.gen(function* discarded() {
      const { controller, sent } = yield* panel(Effect.succeed('applied'));
      controller.change({ ...saved, name: 'VIP klient' });
      controller.discard();
      expect(controller.status()).toBe('idle');
      controller.save();
      yield* Effect.yieldNow;
      expect(sent).toEqual([]);
    }),
  );

  it.effect('reports a conflict when someone else changed the tag or won the revision race', () =>
    Effect.gen(function* conflict() {
      const stale = yield* panel(Effect.succeed('stale'));
      stale.controller.change({ ...saved, color: 'blue' });
      stale.controller.save();
      yield* Effect.yieldNow;
      expect(stale.controller.status()).toBe('conflict');

      const race = yield* panel(Effect.fail(isConflict));
      race.controller.change({ ...saved, color: 'blue' });
      race.controller.save();
      yield* Effect.yieldNow;
      expect(race.controller.status()).toBe('conflict');

      const failed = yield* panel(Effect.fail(unavailable));
      failed.controller.change({ ...saved, color: 'blue' });
      failed.controller.save();
      yield* Effect.yieldNow;
      expect(failed.controller.status()).toBe('error');
    }),
  );

  it.effect('parks a change sent for approval and does not send it again', () =>
    Effect.gen(function* proposed() {
      const { controller, sent } = yield* panel(Effect.fail(proposal));
      controller.change({ ...saved, color: 'blue' });
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('proposed');
      controller.save();
      yield* Effect.yieldNow;
      expect(sent).toHaveLength(1);
    }),
  );
});
