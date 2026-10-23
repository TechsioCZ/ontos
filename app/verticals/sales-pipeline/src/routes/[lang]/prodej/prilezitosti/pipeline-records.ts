import { definePageData, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { defaultParseSearch } from '@tanstack/react-router';
import { Effect, Match, Option, Random, Schema } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { PartyIdSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { loadPipeline, recordsFilters } from './pipeline-api.ts';
import type { PipelineFilterValues } from './pipeline-api.ts';

export const RecordsLoadErrorSchema = Schema.Literals(['forbidden', 'unavailable']);
export type RecordsLoadError = typeof RecordsLoadErrorSchema.Type;

/** The server filters of one records read, scoped to the legal entity the person works in. */
export interface PipelineRecordsInput extends PipelineFilterValues {
  readonly legalEntityId: string;
}

/** Only the filters the read sends make up the key; no filter at all is the shared `all` read. */
const recordsKey = ({ customer, legalEntityId, owner, stage }: PipelineRecordsInput): string =>
  customer === '' && owner === '' && stage === ''
    ? `${legalEntityId}|all`
    : `${legalEntityId}|${customer}|${owner}|${stage}`;

const loadRecords = ({ customer, owner, stage }: PipelineRecordsInput) =>
  Random.nextInt.pipe(
    Effect.flatMap((nonce) =>
      loadPipeline(recordsFilters({ customer, owner, stage }), `sales-pipeline:records:${nonce}`),
    ),
    Effect.mapError((problem): RecordsLoadError =>
      Match.value(problem).pipe(
        Match.tag('RecordsForbiddenProblem', () => 'forbidden' as const),
        Match.orElse(() => 'unavailable' as const),
      ),
    ),
  );

/** Visible opportunities per server filter set, shared by the records page and the AI approvals page. */
export const pipelineRecords = definePageData({ key: recordsKey, load: loadRecords, runtime: browserRuntime });

/** The customer the records page query filters by. */
const customerQuerySchema = Schema.Struct({ partyId: Schema.optional(PartyIdSchema) });

/** The read the records page opens with: no filters, or the customer the URL asks for; none for an invalid query. */
export const initialRecordsInput = (props: ModulePageProps): Option.Option<PipelineRecordsInput> =>
  Schema.decodeOption(customerQuerySchema)(defaultParseSearch(props.search)).pipe(
    Option.map(({ partyId }) => ({
      customer: partyId ?? '',
      legalEntityId: props.context?.legalEntityId ?? '',
      owner: '',
      stage: '',
    })),
  );

/** The unfiltered read of a legal entity. */
export const allRecordsInput = (legalEntityId: string): PipelineRecordsInput => ({
  customer: '',
  legalEntityId,
  owner: '',
  stage: '',
});

/** Reads one records entry; a disabled read stays pending and loads nothing. */
export const usePipelineRecordsSnapshot = (
  input: PipelineRecordsInput,
  enabled = true,
): PageDataSnapshot<RecordsResponse, RecordsLoadError> => {
  const { customer, legalEntityId, owner, stage } = input;
  const snapshot = useSyncExternalStore(
    pipelineRecords.subscribe,
    () => (enabled ? pipelineRecords.snapshot(input) : pageDataPending),
    () => pageDataPending,
  );
  useEffect(() => {
    if (enabled) {
      pipelineRecords.ensure({ customer, legalEntityId, owner, stage });
    }
  }, [customer, enabled, legalEntityId, owner, stage]);
  return snapshot;
};

/**
 * Visible opportunities for the server filters, ready in the first render when the Shell prepared the page.
 * A filter change keeps the last rows on screen with `pending` true until the new read settles, so the old rows are
 * not presented as the new result. A failed first read reports why; a failed revalidation keeps the current rows.
 */
export const usePipelineRecords = (input: PipelineRecordsInput, enabled = true) => {
  const snapshot = usePipelineRecordsSnapshot(input, enabled);
  const [lastShown, setLastShown] = useState<RecordsResponse>();
  if (snapshot.state === 'ready' && lastShown !== snapshot.value) {
    setLastShown(snapshot.value);
  }
  const reload = () => {
    void browserRuntime.runPromise(pipelineRecords.refresh(input));
  };
  return {
    loadError: Match.value(snapshot).pipe(
      Match.when({ refreshing: false, state: 'failed' }, ({ error }) => Option.some(error)),
      Match.orElse(() => Option.none<RecordsLoadError>()),
      Option.getOrUndefined,
    ),
    pending: snapshot.state === 'pending' || (snapshot.state === 'failed' && snapshot.refreshing),
    reload,
    response: Match.value(snapshot).pipe(
      Match.when({ state: 'ready' }, ({ value }) => Option.some(value)),
      Match.when({ state: 'failed' }, () => Option.none()),
      Match.orElse(() => Option.fromUndefinedOr(lastShown)),
      Option.getOrUndefined,
    ),
  };
};
