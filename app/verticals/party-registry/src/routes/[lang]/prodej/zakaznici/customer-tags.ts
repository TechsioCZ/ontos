// Tags of the customers on screen, read through the tagging owner's generated records client. Tags are optional
// here: a person who may not read them gets `forbidden` (no Štítky column, no tag bulk action), never a load error.
import { documentNavigationModules } from '@app/shared-contracts';
import { executeRecords as executeTagRecords } from '@app/tagging/clients/records';
import type { TagsStatus } from '@app/tagging/components/tag-controls';
import { SubjectIdsQuerySchema } from '@app/tagging/contracts/records';
import type { RecordsRequest, SubjectId, SubjectKind, Tag, TagId } from '@app/tagging/contracts/records';
import { Effect, Predicate, Random, Schema } from 'effect';
import { useEffect, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

/** Tagging records for this view, each read under its own correlation. */
const readTagRecords = (payload: RecordsRequest) =>
  Random.nextInt.pipe(Effect.flatMap((id) => executeTagRecords(payload, `tagging:records:${id}`)));

/** Ids of the subjects of one kind that carry the given tag. */
export const subjectsWithTag = (kind: SubjectKind, tagId: TagId) =>
  readTagRecords({ subjectKind: kind, tagId }).pipe(
    Effect.map((records) => records.assignments.map((assignment) => assignment.subject.id)),
  );

/** `SubjectIdsQuerySchema` caps one records query at this many characters. */
const subjectIdsQueryLimit = 8000;

/**
 * Comma-joined id lists, each within the records query limit. The accumulator belongs to this invocation; the
 * caller's ids are never mutated.
 */
const subjectIdQueries = (ids: readonly string[]): string[] => {
  const queries: string[] = [];
  for (const id of ids) {
    const last = queries.at(-1);
    if (last !== undefined && last.length + 1 + id.length <= subjectIdsQueryLimit) {
      queries.splice(-1, 1, `${last},${id}`);
    } else {
      queries.push(id);
    }
  }
  return queries;
};

/**
 * Tags and the assignments of the given subject ids: one read per query-limit chunk, the tags and `canWrite` of the
 * first page and the assignments of every page.
 */
const recordsFor = (kind: SubjectKind, ids: readonly SubjectId[]) =>
  Effect.forEach(
    subjectIdQueries(ids),
    (query) =>
      Schema.decodeEffect(SubjectIdsQuerySchema)(query).pipe(
        Effect.flatMap((subjectIds) => readTagRecords({ subjectIds, subjectKind: kind })),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((pages) => ({
      assignments: pages.flatMap((page) => page.assignments),
      canWrite: pages[0]?.canWrite,
      tags: pages[0]?.tags ?? [],
    })),
  );

/** False when the Shell's per-document navigation hint leaves tagging out; unknown (no hint) reads as readable. */
const tagsReadable = (): boolean => documentNavigationModules()?.has('demo.tagging') ?? true;

/** A refused tag read (owner 403 or gateway refusal) reads as `forbidden`; anything else as a retryable error. */
const tagsFailureStatus = (failure: { readonly _tag: string }): TagsStatus =>
  Predicate.isTagged(failure, 'RecordsForbiddenProblem') || Predicate.isTagged(failure, 'GatewayForbiddenProblem')
    ? 'forbidden'
    : 'error';

/** Groups the assignments of one records read by subject, resolving each tag id against the tags of that read. */
const tagsBySubjectOf = (records: {
  readonly assignments: readonly { readonly subject: { readonly id: SubjectId }; readonly tagId: TagId }[];
  readonly tags: readonly Tag[];
}): ReadonlyMap<SubjectId, Tag[]> => {
  const tagById = new Map(records.tags.map((tag) => [tag.id, tag] as const));
  const next = new Map<SubjectId, Tag[]>();
  for (const assignment of records.assignments) {
    const tag = tagById.get(assignment.tagId);
    if (tag !== undefined) {
      next.set(assignment.subject.id, [...(next.get(assignment.subject.id) ?? []), tag]);
    }
  }
  return next;
};

interface TagsRequest {
  readonly kind: SubjectKind;
  readonly subjectIds: readonly SubjectId[];
  readonly subjectKey: string;
}

/** What `useTagsFor` returns for the rows of a list. */
export interface SubjectTags {
  /** The read's scope-wide tag write capability; `undefined` until a read succeeds. */
  readonly canWrite: boolean | undefined;
  readonly refetch: () => void;
  readonly status: TagsStatus;
  readonly tagsBySubject: ReadonlyMap<SubjectId, Tag[]>;
}

/**
 * Tags for the given subjects, keyed by subject id. Failures set `status` to `error`; they never read as no tags.
 * A person who may not read tags gets `forbidden` without a read (or after the owner refuses one).
 */
export const useTagsFor = (kind: SubjectKind, ids: readonly SubjectId[]): SubjectTags => {
  const subjectKey = ids.join(',');
  const [request, setRequest] = useState<TagsRequest>({ kind, subjectIds: ids, subjectKey });
  const [status, setStatus] = useState<TagsStatus>('loading');
  const [canWrite, setCanWrite] = useState<boolean>();
  const [tagsBySubject, setTagsBySubject] = useState<ReadonlyMap<SubjectId, Tag[]>>(new Map());
  // A new kind or new subject ids start a new request; the previous rows stay until the new ones arrive.
  if (request.kind !== kind || request.subjectKey !== subjectKey) {
    setRequest({ kind, subjectIds: ids, subjectKey });
  }
  const readable = tagsReadable();
  useEffect(() => {
    let active = true;
    // One records read carries both the tag catalog and the assignments, so a list costs one operation.
    if (readable && request.subjectIds.length > 0) {
      void browserRuntime.runPromise(
        recordsFor(request.kind, request.subjectIds).pipe(
          Effect.match({
            onFailure: (error) => {
              if (active) {
                setStatus(tagsFailureStatus(error));
                setTagsBySubject(new Map());
              }
            },
            onSuccess: (records) => {
              if (!active) {
                return;
              }
              setStatus('ready');
              setCanWrite(records.canWrite);
              setTagsBySubject(tagsBySubjectOf(records));
            },
          }),
        ),
      );
    }
    return () => {
      active = false;
    };
  }, [readable, request]);
  const refetch = () => setRequest((current) => ({ ...current }));
  if (!readable) {
    return { canWrite: false, refetch, status: 'forbidden', tagsBySubject };
  }
  // An empty list has nothing to load, so it is ready at once and never issues a read.
  return { canWrite, refetch, status: request.subjectIds.length === 0 ? 'ready' : status, tagsBySubject };
};
