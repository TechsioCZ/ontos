import { definePageData, pageDataPending, pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext, ModulePageProps, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { defaultParseSearch } from '@tanstack/react-router';
import { Effect, Match, Option, Random, Schema } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { PartyIdSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { loadPipeline, recordsFilters } from './pipeline-api.ts';
import type { PipelineFilterValues } from './pipeline-api.ts';

const moduleId = 'demo.sales-pipeline';

export const RecordsLoadErrorSchema = Schema.Literals(['forbidden', 'unavailable']);
export type RecordsLoadError = typeof RecordsLoadErrorSchema.Type;

/** The server filters of one records read, scoped to the legal entity the person works in. */
export interface PipelineRecordsInput extends PipelineFilterValues {
  readonly context?: ModulePageContext | undefined;
  readonly legalEntityId: string;
}

/** Only the filters the read sends make up the key; no filter at all is the shared `all` read. */
const recordsKey = ({ context, customer, legalEntityId, owner, stage }: PipelineRecordsInput): string =>
  customer === '' && owner === '' && stage === ''
    ? `${pageDataScopeKey(context, moduleId) ?? legalEntityId}|all`
    : `${pageDataScopeKey(context, moduleId) ?? legalEntityId}|${customer}|${owner}|${stage}`;

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
const createPipelineRecords = () =>
  definePageData({
    key: recordsKey,
    load: loadRecords,
    maxEntries: 8,
    retainStale: false,
    runtime: browserRuntime,
  });

export const pipelineRecords = createPipelineRecords();

/** A missing trusted identity cannot reuse another mount's primary records either. */
const useRecordsDataset = (input: PipelineRecordsInput) => {
  const [localData, setLocalData] = useState(() => ({ data: createPipelineRecords(), key: input.legalEntityId }));
  if (localData.key !== input.legalEntityId) {
    setLocalData({ data: createPipelineRecords(), key: input.legalEntityId });
  }
  return pageDataScopeKey(input.context, moduleId) === undefined ? localData.data : pipelineRecords;
};

/** The customer the records page query filters by. */
const customerQuerySchema = Schema.Struct({ partyId: Schema.optional(PartyIdSchema) });

/** The read the records page opens with: no filters, or the customer the URL asks for; none for an invalid query. */
export const initialRecordsInput = (props: ModulePageProps): Option.Option<PipelineRecordsInput> =>
  Schema.decodeOption(customerQuerySchema)(defaultParseSearch(props.search)).pipe(
    Option.map(({ partyId }) => ({
      context: props.context,
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
const useRecordsSnapshot = (
  input: PipelineRecordsInput,
  enabled: boolean,
  data: typeof pipelineRecords,
): PageDataSnapshot<RecordsResponse, RecordsLoadError> => {
  const { context, customer, legalEntityId, owner, stage } = input;
  const tenantId = context?.tenantId;
  const principalId = context?.principalId;
  const companyId = context?.legalEntityId;
  const snapshot = useSyncExternalStore(
    (listener) => data.subscribe(listener, input),
    () => (enabled ? data.snapshot(input) : pageDataPending),
    () => pageDataPending,
  );
  useEffect(() => {
    if (enabled) {
      const trustedContext =
        tenantId === undefined || principalId === undefined || companyId === undefined
          ? undefined
          : { legalEntityId: companyId, principalId, tenantId };
      data.ensure({ context: trustedContext, customer, legalEntityId, owner, stage });
    }
  }, [companyId, customer, data, enabled, legalEntityId, owner, principalId, stage, tenantId]);
  return snapshot;
};

/** Legacy company-only approvals inputs keep their existing preload identity; scoped record-page inputs are separate. */
export const usePipelineRecordsSnapshot = (input: PipelineRecordsInput, enabled = true) =>
  useRecordsSnapshot(input, enabled, pipelineRecords);

/**
 * Visible opportunities for the server filters, ready in the first render when the Shell prepared the page.
 * A scope/filter change or invalidation hides earlier rows until the current authorized read settles.
 * A failed refresh reports its current failure rather than retaining rows from an earlier authorization.
 */
export const usePipelineRecords = (input: PipelineRecordsInput, enabled = true) => {
  const data = useRecordsDataset(input);
  const snapshot = useRecordsSnapshot(input, enabled, data);
  const reload = () => {
    void browserRuntime.runPromise(data.refresh(input));
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
      Match.orElse(() => Option.none()),
      Option.getOrUndefined,
    ),
  };
};
