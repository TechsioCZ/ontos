// Owner-only write orchestration over the public records read interface and the generated Action clients. The
// read-before-write revision, the single-use idempotency key and the committed-versus-proposed result handling are
// owner policy, so they stay out of the published read client.
import { Effect, Match } from 'effect';
import type { RecordsResponse, Subject, TagId } from '../../shared/apis/records.ts';
import type { TaggingCommand } from '../../shared/actions/apply-command.ts';
import { committedResult } from './action-result.ts';
import { executeApplyCommand } from './apply-command-action-client.ts';
import { executeAssignTag } from './assign-tag-action-client.ts';
import { executeDeleteTag } from './delete-tag-action-client.ts';
import { executeRecords, freshCorrelation } from './records-consumer.ts';
import { executeUnassignTag } from './unassign-tag-action-client.ts';
import { executeUpdateTag } from './update-tag-action-client.ts';

/** The owner workflow chooses the published operation before obtaining its single-use assertion. */
const submitTagCommand = (command: TaggingCommand, expectedRevision: number, id: string) =>
  Match.value(command).pipe(
    Match.tag('CreateTag', (value) =>
      executeApplyCommand({ command: value, expectedRevision }, id, { idempotencyKey: id }),
    ),
    Match.tag('UpdateTag', (value) =>
      executeUpdateTag({ command: value, expectedRevision }, id, { idempotencyKey: id }),
    ),
    Match.tag('DeleteTag', (value) =>
      executeDeleteTag({ command: value, expectedRevision }, id, { idempotencyKey: id }),
    ),
    Match.tag('AssignTag', (value) =>
      executeAssignTag({ command: value, expectedRevision }, id, { idempotencyKey: id }),
    ),
    Match.tag('UnassignTag', (value) =>
      executeUnassignTag({ command: value, expectedRevision }, id, { idempotencyKey: id }),
    ),
    Match.exhaustive,
    Effect.flatMap(committedResult),
  );

/** Runs one command against the current revision, read immediately before the write. */
export const applyTaggingCommand = (command: TaggingCommand) =>
  freshCorrelation.pipe(
    Effect.flatMap((readId) => executeRecords({}, readId)),
    Effect.flatMap((current) =>
      freshCorrelation.pipe(Effect.flatMap((id) => submitTagCommand(command, current.revision, id))),
    ),
  );

/**
 * Runs one command only while `unchanged` holds for the records read immediately before the write, against that read's
 * revision: `stale` when the caller's version is outdated, so nothing is overwritten.
 */
export const applyTaggingCommandIfUnchanged = (
  command: TaggingCommand,
  unchanged: (current: RecordsResponse) => boolean,
) =>
  freshCorrelation.pipe(
    Effect.flatMap((readId) => executeRecords({}, readId)),
    Effect.flatMap((current) =>
      unchanged(current)
        ? freshCorrelation.pipe(
            Effect.flatMap((id) => submitTagCommand(command, current.revision, id)),
            Effect.as('applied' as const),
          )
        : Effect.succeed('stale' as const),
    ),
  );

/** Idempotent: subjects that already carry the tag are skipped. */
export const assignTag = (tagId: TagId, subjects: readonly Subject[]) =>
  applyTaggingCommand({ _tag: 'AssignTag', subjects, tagId });

export const unassignTag = (tagId: TagId, subjects: readonly Subject[]) =>
  applyTaggingCommand({ _tag: 'UnassignTag', subjects, tagId });
