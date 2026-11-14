// Owner reads over the generated governed records client. Callers pass the encoded request, which is decoded with the
// owner's schema before the generated client sends it. Every read draws a fresh correlation.
import { Effect, Random, Schema } from 'effect';
import { RecordsRequestSchema } from '../../shared/apis/records.ts';
import type { RecordsRequestEncoded, SubjectKind, TagId } from '../../shared/apis/records.ts';
import { executeRecords } from '../api/records-client.ts';

/**
 * The native randomness source every tagging read draws its correlation from, so one operation never reuses the
 * correlation of another.
 */
export const freshCorrelation = Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
  Effect.map(([first, second]) => `tagging:${first}:${second}`),
);

/** One records read of the encoded request under a fresh correlation. */
export const readRecords = (payload: RecordsRequestEncoded) =>
  Schema.decodeEffect(RecordsRequestSchema)(payload).pipe(
    Effect.flatMap((decoded) => freshCorrelation.pipe(Effect.flatMap((id) => executeRecords(decoded, id)))),
  );

/** All tags with their tag-wide assignment counts per subject kind. */
export const listTags = readRecords({}).pipe(Effect.map((records) => records.tags));

/** Ids of the subjects of one kind that carry the given tag. */
export const subjectsWithTag = (kind: SubjectKind, tagId: TagId) =>
  readRecords({ subjectKind: kind, tagId }).pipe(
    Effect.map((records) => records.assignments.map((assignment) => assignment.subject.id)),
  );
