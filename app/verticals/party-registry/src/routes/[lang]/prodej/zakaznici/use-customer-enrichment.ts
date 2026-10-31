import { subjectsWithTag } from '@app/tagging/clients/records';
import { useTagsFor } from '@app/tagging/components/tag-controls';
import type { SubjectId, Tag, TagId } from '@app/tagging/contracts/records';
import { SubjectIdSchema } from '@app/tagging/contracts/records';
import type { Cause } from 'effect';
import { Duration, Effect, Option, Result, Schema } from 'effect';
import { useEffect, useState } from 'react';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CustomersSnapshot } from './customers-data.ts';

type TagFilterError = Effect.Error<ReturnType<typeof subjectsWithTag>> | Cause.TimeoutError;

/** A tag lookup that has not answered by then counts as failed, so the table never stays a skeleton. */
const TAG_LOOKUP_TIMEOUT = Duration.seconds(10);

/** Customer partyIds are owner-validated resource ids, so they always satisfy the tagging subject contract. */
export const subjectIdOf = (partyId: string): SubjectId =>
  Result.getOrThrow(Schema.decodeResult(SubjectIdSchema)(partyId));

/** Subject ids carrying the tag, read from the assignments loaded for the tag column. */
const subjectsTaggedWith = (tagsBySubject: ReadonlyMap<SubjectId, readonly Tag[]>, tagId: TagId): ReadonlySet<string> =>
  new Set([...tagsBySubject].flatMap(([subjectId, tags]) => (tags.some((tag) => tag.id === tagId) ? [subjectId] : [])));

/**
 * Segment and tag data for the customers list. Segments arrive with the customer list (`loadCustomers`), so their
 * labels render in the first commit; a failed segment lookup hides the column. The tag lookup is best effort: a
 * failed or stalled tag lookup clears the filter with a message instead of reading as "no results". Any failure
 * counts, defects and timeouts included, so it can never stay pending.
 * The tag filter reads the assignments already loaded for the tag column, so it answers at once; it asks the
 * tagging owner only while those assignments are loading or failed.
 */
export const useCustomerEnrichment = (data: CustomersSnapshot | undefined) => {
  const segments = data === undefined ? null : Option.getOrNull(data.segments);
  const segmentsFailed = data !== undefined && Option.isNone(data.segments);
  const [tagFilter, setTagFilter] = useState<TagId | null>(null);
  const [tagFailure, setTagFailure] = useState<Option.Option<Cause.Cause<TagFilterError>>>(Option.none);
  const [tagRevision, setTagRevision] = useState(0);
  const [tagResult, setTagResult] = useState<{ readonly ids: ReadonlySet<string>; readonly key: string } | null>(null);

  const items = data?.items ?? [];
  const tags = useTagsFor(
    'customer',
    items.map((item) => subjectIdOf(item.partyId)),
  );

  const localTaggedIds =
    tagFilter !== null && tags.status === 'ready' ? subjectsTaggedWith(tags.tagsBySubject, tagFilter) : null;
  // The key ties a lookup result to one tag and one tagging revision, so a stale result never filters rows.
  const lookupKey = tagFilter === null || tags.status === 'ready' ? null : `${tagFilter}:${tagRevision}`;
  useEffect(() => {
    let active = true;
    if (tagFilter !== null && lookupKey !== null) {
      void browserRuntime.runPromise(
        subjectsWithTag('customer', tagFilter).pipe(
          Effect.timeout(TAG_LOOKUP_TIMEOUT),
          Effect.matchCause({
            onFailure: (cause) => {
              if (active) {
                setTagFailure(Option.some(cause));
                setTagFilter(null);
              }
            },
            onSuccess: (ids) => {
              if (active) {
                setTagResult({ ids: new Set<string>(ids), key: lookupKey });
              }
            },
          }),
        ),
      );
    }
    return () => {
      active = false;
    };
  }, [lookupKey, tagFilter]);

  const remoteTaggedIds = lookupKey !== null && tagResult?.key === lookupKey ? tagResult.ids : null;
  const taggedIds = localTaggedIds ?? remoteTaggedIds;

  const handleTagFilterChange = (next: TagId | null) => {
    setTagFailure(Option.none());
    setTagFilter(next);
  };

  const handleTagsChanged = () => {
    tags.refetch();
    setTagRevision((current) => current + 1);
  };

  return {
    handleTagFilterChange,
    handleTagsChanged,
    segments,
    segmentsFailed,
    tagFilter,
    tagFilterFailed: Option.isSome(tagFailure),
    tagFilterLoading: tagFilter !== null && taggedIds === null,
    taggedIds,
    tagsBySubject: tags.tagsBySubject,
    tagStatus: tags.status,
    /** Only a tagging read that says so offers tag edits; while it loads or after it fails, they stay hidden. */
    tagsWritable: tags.canWrite === true,
  };
};
