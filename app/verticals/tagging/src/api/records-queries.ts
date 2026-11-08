// Owner-only unchunked reads over the public records read interface. The per-(kind, id) chunking and the page
// concatenation are owner policy, so they stay out of the published read client.
import { Effect } from 'effect';
import type { SubjectKind } from '../../shared/apis/records.ts';
import { executeRecords, freshCorrelation, subjectIdQueries } from './records-consumer.ts';

// Subject ids must not contain commas (records query format).

/** Assignments of the given subject ids of one kind, across all tags. */
export const assignmentsFor = (kind: SubjectKind, ids: readonly string[]) =>
  ids.length === 0
    ? Effect.succeed([])
    : freshCorrelation.pipe(
        Effect.flatMap((id) => executeRecords({ subjectIds: ids.join(','), subjectKind: kind }, id)),
        Effect.map((records) => records.assignments),
      );

/**
 * Tags and the assignments of the given subject ids. One operation per query-limit chunk: the tags come from the
 * first page and the assignments of every page are concatenated. Callers skip the call for an empty list.
 */
export const recordsFor = (kind: SubjectKind, ids: readonly string[]) =>
  Effect.forEach(
    subjectIdQueries(ids),
    (subjectIds) =>
      freshCorrelation.pipe(Effect.flatMap((id) => executeRecords({ subjectIds, subjectKind: kind }, id))),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap(([first, ...rest]) =>
      first === undefined
        ? freshCorrelation.pipe(Effect.flatMap((id) => executeRecords({ subjectIds: '', subjectKind: kind }, id)))
        : Effect.succeed({
            ...first,
            assignments: [...first.assignments, ...rest.flatMap((page) => page.assignments)],
          }),
    ),
  );
