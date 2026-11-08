// Public read interface over the generated governed records client. Callers pass the encoded request, which is
// decoded here before the generated client sends it. Owner-only write orchestration builds on this interface from
// `records-commands.ts`, and the owner-only unchunked reads from `records-queries.ts`, so the published surface
// stays pure reads and the write path stays private.
import { Effect, Random, Schema } from 'effect';
import { RecordsRequestSchema } from '../../shared/apis/records.ts';
import type { RecordsRequestEncoded, SubjectKind, TagId } from '../../shared/apis/records.ts';
import {
  executeRecords as executeDecodedRecords,
  executeRecordsWithAuthorization as executeDecodedRecordsWithAuthorization,
} from './records-client.ts';

/** The generated client's invocation after its payload. */
type Invocation<Arguments extends readonly unknown[]> = Arguments extends readonly [unknown, ...infer Rest]
  ? Rest
  : never;

export const executeRecordsWithAuthorization = (
  payload: RecordsRequestEncoded,
  ...invocation: Invocation<Parameters<typeof executeDecodedRecordsWithAuthorization>>
) =>
  Schema.decodeEffect(RecordsRequestSchema)(payload).pipe(
    Effect.flatMap((decoded) => executeDecodedRecordsWithAuthorization(decoded, ...invocation)),
  );

export const executeRecords = (
  payload: RecordsRequestEncoded,
  ...invocation: Invocation<Parameters<typeof executeDecodedRecords>>
) =>
  Schema.decodeEffect(RecordsRequestSchema)(payload).pipe(
    Effect.flatMap((decoded) => executeDecodedRecords(decoded, ...invocation)),
  );

/**
 * The native randomness source every tagging read draws its correlation from, so one operation never reuses the
 * correlation of another.
 */
export const freshCorrelation = Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
  Effect.map(([first, second]) => `tagging:${first}:${second}`),
);

/** All tags with their tag-wide assignment counts per subject kind. */
export const listTags = freshCorrelation.pipe(
  Effect.flatMap((id) => executeRecords({}, id)),
  Effect.map((records) => records.tags),
);

/** Tags and every assignment of one subject kind in one operation, without needing the subject ids first. */
export const recordsOfKind = (kind: SubjectKind) =>
  freshCorrelation.pipe(Effect.flatMap((id) => executeRecords({ subjectKind: kind }, id)));

/** Ids of the subjects of one kind that carry the given tag. */
export const subjectsWithTag = (kind: SubjectKind, tagId: TagId) =>
  freshCorrelation.pipe(
    Effect.flatMap((id) => executeRecords({ subjectKind: kind, tagId }, id)),
    Effect.map((records) => records.assignments.map((assignment) => assignment.subject.id)),
  );

/** `SubjectIdsQuerySchema` caps one records query at this many characters. */
const subjectIdsQueryLimit = 8000;

/**
 * Comma-joined id lists, each within the records query limit. Exported so the owner-only reads in
 * `records-queries.ts` share this one implementation of the public chunking bound. The accumulator belongs to this
 * invocation; the caller's ids and shared module state are never mutated.
 */
export const subjectIdQueries = (ids: readonly string[]): string[] => {
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
 * Assignments of subjects of several kinds, across all tags. One records operation covers every kind; a list longer
 * than the query limit takes one more operation per extra chunk. Only assignments of the requested (kind, id) pairs
 * are returned, so an id shared by two kinds never leaks the other kind's tags.
 */
export const assignmentsForSubjects = (subjects: readonly { readonly id: string; readonly kind: SubjectKind }[]) => {
  const wanted = new Set(subjects.map((subject) => `${subject.kind}:${subject.id}`));
  const ids = [...new Set(subjects.map((subject) => subject.id))];
  return ids.length === 0
    ? Effect.succeed([])
    : Effect.forEach(
        subjectIdQueries(ids),
        (subjectIds) => freshCorrelation.pipe(Effect.flatMap((id) => executeRecords({ subjectIds }, id))),
        { concurrency: 1 },
      ).pipe(
        Effect.map((pages) =>
          pages.flatMap((records) =>
            records.assignments.filter((assignment) =>
              wanted.has(`${assignment.subject.kind}:${assignment.subject.id}`),
            ),
          ),
        ),
      );
};
