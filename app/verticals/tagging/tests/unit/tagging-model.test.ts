import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TaggingCommandSchema, TaggingReferenceIneligible } from '../../shared/actions/apply-command.ts';
import type { TaggingState } from '../../shared/apis/records.ts';
import { tagResourceDescriptor } from '../../shared/resources/tag.ts';
import { evolveTaggingState } from '../../src/services/persistence.service.ts';

const now = DateTime.makeUnsafe('2026-10-13T10:00:00Z');
const empty: TaggingState = { assignments: [], tags: [] };

const run = (state: TaggingState, input: typeof TaggingCommandSchema.Encoded, resourceId = 'tag-1') =>
  Effect.gen(function* runCommand() {
    const command = yield* Schema.decodeEffect(TaggingCommandSchema)(input);
    return yield* evolveTaggingState(state, command, { now, resourceId });
  });

it('owns its primary resource type', () => {
  expect(tagResourceDescriptor.owningModuleId).toBe('demo.tagging');
});

it.effect('AssignTag is idempotent and skips subjects already tagged', () =>
  Effect.gen(function* assignIsIdempotent() {
    const created = yield* run(empty, { _tag: 'CreateTag', color: 'blue', name: 'VIP', subjectKinds: ['customer'] });
    const first = yield* run(created.state, {
      _tag: 'AssignTag',
      subjects: [
        { id: 'customer-1', kind: 'customer' },
        { id: 'customer-1', kind: 'customer' },
        { id: 'customer-2', kind: 'customer' },
      ],
      tagId: created.tagId,
    });
    expect(first.affectedAssignments).toBe(2);
    expect(first.state.assignments).toHaveLength(2);

    const second = yield* run(first.state, {
      _tag: 'AssignTag',
      subjects: [{ id: 'customer-1', kind: 'customer' }],
      tagId: created.tagId,
    });
    expect(second.affectedAssignments).toBe(0);
    expect(second.state.assignments).toHaveLength(2);
  }),
);

it.effect('DeleteTag cascades to its assignments and leaves other tags intact', () =>
  Effect.gen(function* deleteCascades() {
    const vip = yield* run(
      empty,
      { _tag: 'CreateTag', color: 'blue', name: 'VIP', subjectKinds: ['customer'] },
      'tag-vip',
    );
    const risk = yield* run(
      vip.state,
      { _tag: 'CreateTag', color: 'red', name: 'Riziko', subjectKinds: ['customer', 'order'] },
      'tag-risk',
    );
    const withVip = yield* run(risk.state, {
      _tag: 'AssignTag',
      subjects: [{ id: 'customer-1', kind: 'customer' }],
      tagId: vip.tagId,
    });
    const withRisk = yield* run(withVip.state, {
      _tag: 'AssignTag',
      subjects: [
        { id: 'customer-1', kind: 'customer' },
        { id: 'order-1', kind: 'order' },
      ],
      tagId: risk.tagId,
    });

    const deleted = yield* run(withRisk.state, { _tag: 'DeleteTag', id: vip.tagId });
    expect(deleted.affectedAssignments).toBe(1);
    expect(deleted.state.tags.map((tag) => tag.id)).toEqual(['tag-risk']);
    expect(deleted.state.assignments).toHaveLength(2);
    expect(deleted.state.assignments.every((assignment) => assignment.tagId === risk.tagId)).toBe(true);
  }),
);

it.effect('AssignTag rejects a subject kind the tag does not apply to', () =>
  Effect.gen(function* rejectsWrongKind() {
    const created = yield* run(empty, {
      _tag: 'CreateTag',
      color: 'green',
      name: 'Senior',
      subjectKinds: ['employee'],
    });
    const error = yield* run(created.state, {
      _tag: 'AssignTag',
      subjects: [{ id: 'customer-1', kind: 'customer' }],
      tagId: created.tagId,
    }).pipe(Effect.flip);
    expect(Schema.is(TaggingReferenceIneligible)(error)).toBe(true);
  }),
);
