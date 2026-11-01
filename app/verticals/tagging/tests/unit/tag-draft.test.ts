import { startAutosave } from '@app/admin-ui';
import type { AutosaveOutcome } from '@app/admin-ui';
import { DateTime, Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { TagIdSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse, Tag } from '../../shared/apis/records.ts';
import {
  sameTagDraft,
  tagAutosaveResult,
  tagDraftOf,
  tagFieldsOf,
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

const isConflict = { _tag: 'ApplyCommandActionConflictProblem', code: 'tagging_revision_conflict' };

const panel = Effect.fnUntraced(function* panel(write: Effect.Effect<'applied' | 'stale', unknown>) {
  const sent: TagDraft[] = [];
  const controller = yield* startAutosave(saved, {
    equals: sameTagDraft,
    isValid: validTagDraft,
    save: (value: TagDraft) =>
      Effect.sync(() => sent.push(value)).pipe(
        Effect.andThen(tagAutosaveResult(write)),
        Effect.map((result): AutosaveOutcome => (result === 'conflict' || result === 'failed' ? result : 'saved')),
      ),
  });
  return { controller, sent };
});

describe('tag edit panel autosave', () => {
  it.effect('saves a typed name after the quiet time', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel(Effect.succeed('applied'));
      controller.change({ ...saved, name: 'VIP klient' });
      expect(controller.status()).toBe('dirty');
      yield* TestClock.adjust('800 millis');
      expect(sent.map(({ name }) => name)).toEqual(['VIP klient']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('keeps a draft without a kind local', () =>
    Effect.gen(function* invalid() {
      const { controller, sent } = yield* panel(Effect.succeed('applied'));
      controller.change({ ...saved, kinds: [] });
      controller.flush();
      yield* TestClock.adjust('1 second');
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('invalid');
    }),
  );

  it.effect('reports a conflict when someone else changed the tag or won the revision race', () =>
    Effect.gen(function* conflict() {
      const stale = yield* panel(Effect.succeed('stale'));
      stale.controller.change({ ...saved, color: 'blue' });
      stale.controller.flush();
      yield* Effect.yieldNow;
      expect(stale.controller.status()).toBe('conflict');

      const race = yield* panel(Effect.fail(isConflict));
      race.controller.change({ ...saved, color: 'blue' });
      race.controller.flush();
      yield* Effect.yieldNow;
      expect(race.controller.status()).toBe('conflict');

      const failed = yield* panel(Effect.fail({ _tag: 'ApplyCommandActionUnavailableProblem' }));
      failed.controller.change({ ...saved, color: 'blue' });
      failed.controller.flush();
      yield* Effect.yieldNow;
      expect(failed.controller.status()).toBe('error');
    }),
  );
});
