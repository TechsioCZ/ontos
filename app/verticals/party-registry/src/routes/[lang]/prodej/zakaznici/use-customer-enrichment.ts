import { subjectsWithTag } from '@app/tagging/clients/records';
import { useTagsFor } from '@app/tagging/components/tag-controls';
import type { SubjectId, TagId } from '@app/tagging/contracts/records';
import { SubjectIdSchema } from '@app/tagging/contracts/records';
import { Effect, Option, Result, Schema } from 'effect';
import { useEffect, useState } from 'react';

import type { CustomerSegment } from '../../../../api/customer-segments-client.ts';
import { customerSegmentsFor } from '../../../../api/customer-segments-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CustomersSnapshot } from './customers-data.ts';

type SegmentsError = Effect.Error<ReturnType<typeof customerSegmentsFor>>;
type TagFilterError = Effect.Error<ReturnType<typeof subjectsWithTag>>;

/** Customer partyIds are owner-validated resource ids, so they always satisfy the tagging subject contract. */
export const subjectIdOf = (partyId: string): SubjectId =>
  Result.getOrThrow(Schema.decodeResult(SubjectIdSchema)(partyId));

/**
 * Segment and tag data for the customers list. Both lookups are best effort: a failed segment lookup hides
 * the column, and a failed tag lookup clears the filter with a message instead of reading as "no results".
 */
export const useCustomerEnrichment = (data: CustomersSnapshot | undefined) => {
  const [segments, setSegments] = useState<ReadonlyMap<string, CustomerSegment> | null>(null);
  const [segmentsFailure, setSegmentsFailure] = useState<Option.Option<SegmentsError>>(Option.none);
  const [tagFilter, setTagFilter] = useState<TagId | null>(null);
  const [tagFailure, setTagFailure] = useState<Option.Option<TagFilterError>>(Option.none);
  const [tagRevision, setTagRevision] = useState(0);
  const [tagResult, setTagResult] = useState<{ readonly ids: ReadonlySet<string>; readonly key: string } | null>(null);

  const items = data?.items ?? [];
  const tags = useTagsFor(
    'customer',
    items.map((item) => subjectIdOf(item.partyId)),
  );

  useEffect(() => {
    let active = true;
    if (data !== undefined) {
      void browserRuntime.runPromise(
        customerSegmentsFor(data.items).pipe(
          Effect.match({
            onFailure: (failure) => {
              if (active) {
                setSegmentsFailure(Option.some(failure));
              }
            },
            onSuccess: (next) => {
              if (active) {
                setSegments(next);
                setSegmentsFailure(Option.none());
              }
            },
          }),
        ),
      );
    }
    return () => {
      active = false;
    };
  }, [data]);

  // The key ties a lookup result to one tag and one tagging revision, so a stale result never filters rows.
  const lookupKey = tagFilter === null ? null : `${tagFilter}:${tagRevision}`;
  useEffect(() => {
    let active = true;
    if (tagFilter !== null && lookupKey !== null) {
      void browserRuntime.runPromise(
        subjectsWithTag('customer', tagFilter).pipe(
          Effect.match({
            onFailure: (failure) => {
              if (active) {
                setTagFailure(Option.some(failure));
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

  const taggedIds = lookupKey !== null && tagResult?.key === lookupKey ? tagResult.ids : null;

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
    segmentsFailed: Option.isSome(segmentsFailure),
    tagFilter,
    tagFilterFailed: Option.isSome(tagFailure),
    tagFilterLoading: tagFilter !== null && taggedIds === null,
    taggedIds,
    tagsBySubject: tags.tagsBySubject,
    tagStatus: tags.status,
  };
};
