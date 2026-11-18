import {
  UpdateTagActionConflictProblemSchema,
  UpdateTagActionUnavailableProblemSchema,
} from '../../shared/apis/update-tag-action.ts';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { DateTime, Effect, Schema } from 'effect';
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

describe('tag save result', () => {
  it.effect('distinguishes committed, stale, revision-race, unavailable and approval outcomes', () =>
    Effect.gen(function* outcomes() {
      expect(yield* tagSaveResult(Effect.succeed('applied'))).toBe('saved');
      expect(yield* tagSaveResult(Effect.succeed('stale'))).toBe('conflict');
      expect(yield* tagSaveResult(Effect.fail(isConflict))).toBe('conflict');
      expect(yield* tagSaveResult(Effect.fail(unavailable))).toBe('failed');
      expect(yield* tagSaveResult(Effect.fail(proposal))).toBe('proposed');
    }),
  );
});
