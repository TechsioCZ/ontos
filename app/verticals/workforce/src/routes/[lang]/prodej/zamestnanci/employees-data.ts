import { documentNavigationModules } from '@app/shared-contracts';
import { definePageData } from '@app/shared-contracts/page-data';
import { executeRecords as executeTagRecords } from '@app/tagging/clients/records';
import type { TagCallFailure, TagsStatus } from '@app/tagging/components/tag-controls';
import type { Assignment, SubjectId, Tag } from '@app/tagging/contracts/records';
import { Data, Effect, Match, Predicate, Schema } from 'effect';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { AiActivityEntry } from '../../../../../shared/apis/records.ts';
import { newRequestToken } from './employee-model.ts';

/**
 * Datasets of the Zaměstnanci page, one entry per legal entity. The page's `preloadPage` fills them before the Shell
 * reveals the page, so the stat tiles, the rows and their Štítky render real data in the first commit.
 */

export const EmployeesLoadErrorSchema = Schema.Literals(['error', 'forbidden']);
export type EmployeesLoadError = typeof EmployeesLoadErrorSchema.Type;

/** Every Employee the caller may see, unfiltered, so the stat tiles describe the whole team. */
export const employeesData = definePageData({
  // Core identity changes (invite, deactivation, rename) arrive as 'shell'; the read shows assignable principals.
  changesFrom: ['shell', 'workforce'],
  key: (legalEntityId: string) => legalEntityId,
  load: () =>
    newRequestToken.pipe(
      Effect.flatMap((token) => executeRecords({}, `workforce:list:${token}`)),
      Effect.mapError((problem): EmployeesLoadError =>
        Match.value(problem).pipe(
          Match.tag('RecordsForbiddenProblem', () => 'forbidden' as const),
          Match.orElse(() => 'error' as const),
        ),
      ),
    ),
  retainStale: false,
  runtime: browserRuntime,
});

export interface EmployeeTags {
  /** Tags that apply to employees, for the tag filter. */
  readonly catalog: readonly Tag[];
  readonly tagsBySubject: ReadonlyMap<SubjectId, readonly Tag[]>;
}

/** Groups the assignments of one tagging records read by subject, resolving each tag id against that read's tags. */
const employeeTagsOf = (records: {
  readonly assignments: readonly Assignment[];
  readonly tags: readonly Tag[];
}): EmployeeTags => {
  const tagById = new Map(records.tags.map((tag) => [tag.id, tag] as const));
  const tagsBySubject = new Map<SubjectId, Tag[]>();
  for (const assignment of records.assignments) {
    const tag = tagById.get(assignment.tagId);
    if (tag !== undefined) {
      tagsBySubject.set(assignment.subject.id, [...(tagsBySubject.get(assignment.subject.id) ?? []), tag]);
    }
  }
  return { catalog: records.tags.filter((tag) => tag.subjectKinds.includes('employee')), tagsBySubject };
};

/**
 * False when the Shell's per-document navigation hint leaves tagging out, so the page never sends a tag read the
 * owner would refuse. Without the hint nothing is known and tags are read.
 */
export const tagsReadable = (): boolean => documentNavigationModules()?.has('demo.tagging') ?? true;

/** A refused tag read (owner 403 or gateway refusal) reads as `forbidden`; anything else as a retryable error. */
export const tagsFailureStatus = (failure: TagCallFailure): TagsStatus =>
  Predicate.isTagged(failure, 'RecordsForbiddenProblem') || Predicate.isTagged(failure, 'GatewayForbiddenProblem')
    ? 'forbidden'
    : 'error';

/** Tags of every employee in one tagging read; it does not wait for the employee ids, so both load side by side. */
export const employeeTagsData = definePageData({
  changesFrom: ['tagging', 'workforce'],
  key: (legalEntityId: string) => legalEntityId,
  load: () =>
    newRequestToken.pipe(
      Effect.flatMap((token) => executeTagRecords({ subjectKind: 'employee' }, `workforce:tags:${token}`)),
      Effect.map(employeeTagsOf),
    ),
  runtime: browserRuntime,
});

/** The records read carried no AI activity: it failed, or the audit could not be read (the feed is best-effort). */
export class AiActivityUnavailable extends Data.TaggedError('AiActivityUnavailable')<{
  readonly cause?: unknown;
}> {}

/** The "AI aktivita" feed: secondary data, started with the page but never awaited before the reveal. */
// No `changesFrom`: the feed shows agents' Core audit events in every module, so any module's change concerns it.
export const aiActivityData = definePageData({
  key: (legalEntityId: string) => legalEntityId,
  load: () =>
    newRequestToken.pipe(
      Effect.flatMap((token) => executeRecords({ includeAiActivity: true }, `workforce:ai-activity:${token}`)),
      Effect.mapError((problem) => new AiActivityUnavailable({ cause: problem })),
      Effect.flatMap((data): Effect.Effect<readonly AiActivityEntry[], AiActivityUnavailable> =>
        data.aiActivity === undefined ? Effect.fail(new AiActivityUnavailable({})) : Effect.succeed(data.aiActivity),
      ),
    ),
  runtime: browserRuntime,
});
