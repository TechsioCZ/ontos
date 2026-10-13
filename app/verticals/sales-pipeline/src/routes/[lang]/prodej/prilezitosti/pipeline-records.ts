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
 * a failed read keeps the last good response out of the way and reports why it failed.
 */
export const usePipelineRecords = (filters: PipelineFilterValues, reloadKey: number) => {
  const [response, setResponse] = useState<RecordsResponse>();
  const [loadError, setLoadError] = useState<RecordsLoadError>();
  const { customer, owner, stage } = filters;

  useEffect(() => {
    let current = true;
    void browserRuntime.runPromise(
      loadPipeline(recordsFilters({ customer, owner, stage }), `sales-pipeline:records:${reloadKey}`).pipe(
        Effect.match({
          onFailure: (error) => {
            if (current) {
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
  }, [customer, owner, reloadKey, stage]);

  return { loadError, response };
};
