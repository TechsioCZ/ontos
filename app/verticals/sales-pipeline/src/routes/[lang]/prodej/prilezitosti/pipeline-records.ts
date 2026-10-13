import { Effect, Match, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { loadPipeline, recordsFilters } from './pipeline-api.ts';
import type { PipelineFilterValues } from './pipeline-api.ts';

export const RecordsLoadErrorSchema = Schema.Literals(['forbidden', 'unavailable']);
export type RecordsLoadError = typeof RecordsLoadErrorSchema.Type;

/**
 * Visible opportunities for the server filters. The read reruns when a filter changes or `reloadKey` is bumped;
 * a failed read keeps the last good response out of the way and reports why it failed. `pending` is true while
 * the read for changed filters has not settled, so the old rows are not presented as the new result.
 */
export const usePipelineRecords = (filters: PipelineFilterValues, reloadKey: number) => {
  const [response, setResponse] = useState<RecordsResponse>();
  const [loadError, setLoadError] = useState<RecordsLoadError>();
  const [settledKey, setSettledKey] = useState<string>();
  const { customer, owner, stage } = filters;
  // A reload after a command keeps the current rows on screen; only a filter change marks the list as pending.
  const filterKey = `${customer}|${owner}|${stage}`;

  useEffect(() => {
    let current = true;
    void browserRuntime.runPromise(
      loadPipeline(recordsFilters({ customer, owner, stage }), `sales-pipeline:records:${reloadKey}`).pipe(
        Effect.match({
          onFailure: (error) => {
            if (current) {
              setSettledKey(filterKey);
              setLoadError(
                Match.value(error).pipe(
                  Match.tag('RecordsForbiddenProblem', () => 'forbidden' as const),
                  Match.orElse(() => 'unavailable' as const),
                ),
              );
            }
          },
          onSuccess: (result) => {
            if (current) {
              setSettledKey(filterKey);
              setLoadError(undefined);
              setResponse(result);
            }
          },
        }),
      ),
    );
    return () => {
      current = false;
    };
  }, [customer, filterKey, owner, reloadKey, stage]);

  return { loadError, pending: settledKey !== filterKey, response };
};
