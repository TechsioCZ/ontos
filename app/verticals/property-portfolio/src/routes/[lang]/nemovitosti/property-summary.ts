import { executeRecords as readAgreements } from '@app/legal-agreements/clients/records';
import { executeRecords as readOccupancy } from '@app/property-leasing/clients/records';
import { executeRecords as readFinance } from '@app/finance-billing/clients/records';
import { executeRecords as readWork } from '@app/work-tasks/clients/records';
import { listEmployees } from '@app/workforce/clients/records';
import {
  changeConcerns,
  definePageData,
  modulePagePreload,
  pageDataPending,
  pageDataScopeKey,
  moduleWriteEvent,
  moduleChangeEvent,
} from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Data, Effect, Random, Result, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import { executeRecords } from '../../../api/records-client';
import type { RecordsResponse } from '../../../../shared/apis/records';
import { browserRuntime } from '../../../runtime/browser-effect-runtime';
import { propertySelection, readPropertySearch, PropertySearchInputSchema } from './property-navigation.ts';

const keyOf = (parts: readonly string[]) =>
  Result.getOrThrow(Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String)))(parts));
const moduleId = 'property.portfolio';
const ownApp = 'property-portfolio';

export interface RecordsInput {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly reusable: boolean;
  readonly scope: string;
  readonly tenantId: string;
}
export const recordsInput = (context?: ModulePageProps['context'], standaloneScope = ''): RecordsInput => ({
  legalEntityId: context?.legalEntityId ?? '',
  principalId: context?.principalId ?? '',
  reusable: pageDataScopeKey(context, moduleId) !== undefined,
  scope:
    pageDataScopeKey(context, moduleId) ??
    keyOf([
      moduleId,
      'standalone',
      standaloneScope,
      context?.tenantId ?? '',
      context?.legalEntityId ?? '',
      context?.principalId ?? '',
    ]),
  tenantId: context?.tenantId ?? '',
});

export interface SummaryInput extends RecordsInput {
  readonly propertyId: string;
  readonly revision: number;
}
/** The register of buildings, units and assets (archived included); the selection only filters it. */
export const propertyRecords = definePageData({
  changesFrom: [ownApp, 'workforce'],
  key: (input: RecordsInput) => input.scope,
  load: () =>
    Effect.all(
      {
        employees: listEmployees().pipe(Effect.result),
        records: Random.nextInt.pipe(
          Effect.flatMap((id) => executeRecords({ includeArchived: true }, `property-records:${id}`)),
        ),
      },
      { concurrency: 2 },
    ),
  maxEntries: 8,
  retainStale: false,
  runtime: browserRuntime,
});

// Unfiltered published owner reads are shared within this scope/revision, not repeated for every property.
const ownerKey = (input: SummaryInput) => keyOf([input.scope, String(input.revision)]);
const ownerOptions = {
  cancelWhenUnused: true,
  key: ownerKey,
  maxEntries: 8,
  retainStale: false,
  runtime: browserRuntime,
};
const agreementsData = definePageData({
  ...ownerOptions,
  changesFrom: ['legal-agreements', ownApp],
  load: () => readAgreements({}, 'property-portfolio.summary.agreements'),
});
const occupancyData = definePageData({
  ...ownerOptions,
  changesFrom: ['property-leasing', ownApp],
  load: () => readOccupancy({}, 'property-portfolio.summary.occupancy'),
});
const workData = definePageData({
  ...ownerOptions,
  changesFrom: [ownApp, 'work-tasks'],
  load: () => readWork({}, 'property-portfolio.summary.work'),
});
const loadSummary = (input: SummaryInput) =>
  Effect.all(
    {
      agreements: agreementsData.read(input).pipe(Effect.result),
      finance: readFinance({ propertyId: input.propertyId }, 'property-portfolio.summary.finance').pipe(Effect.result),
      occupancy: occupancyData.read(input).pipe(Effect.result),
      work: workData.read(input).pipe(Effect.result),
    },
    { concurrency: 1 },
  );
class PropertySummaryIncomplete extends Data.TaggedError('PropertySummaryIncomplete')<{
  readonly value: Effect.Success<ReturnType<typeof loadSummary>>;
}> {}
/** Apps whose data a property summary shows: its own register and the four owners it summarizes. */
const summaryApps = ['finance-billing', 'legal-agreements', 'property-leasing', ownApp, 'work-tasks'];
export const propertySummary = definePageData({
  cancelWhenUnused: true,
  changesFrom: summaryApps,
  key: (input: SummaryInput) => keyOf([input.scope, input.tenantId, input.propertyId, String(input.revision)]),
  load: (input: SummaryInput) =>
    loadSummary(input).pipe(
      Effect.flatMap((value) =>
        Result.isSuccess(value.agreements) &&
        Result.isSuccess(value.finance) &&
        Result.isSuccess(value.occupancy) &&
        Result.isSuccess(value.work)
          ? Effect.succeed(value)
          : Effect.fail(new PropertySummaryIncomplete({ value })),
      ),
    ),
  maxEntries: 256,
  retainStale: false,
  runtime: browserRuntime,
});
const summaryInputs = (
  input: RecordsInput,
  rows: readonly RecordsResponse['properties'][number][],
  revision: number,
): readonly SummaryInput[] =>
  input.reusable
    ? rows
        .slice(0, 200)
        .flatMap((row) =>
          row.propertyRef.tenantId === input.tenantId &&
          row.legalEntityRef.tenantId === input.tenantId &&
          row.legalEntityRef.resourceId === input.legalEntityId
            ? [{ ...input, propertyId: row.propertyRef.resourceId, revision }]
            : [],
        )
    : [];
const preloadInputs = (inputs: readonly SummaryInput[]) =>
  Effect.forEach(inputs, (input) => propertySummary.read(input).pipe(Effect.ignore), { concurrency: 2, discard: true });
export const preloadPropertySummaries = (
  input: RecordsInput,
  rows: readonly RecordsResponse['properties'][number][],
  revision: number,
) => preloadInputs(summaryInputs(input, rows, revision));

/** A detail hierarchy renders only its current property, not the hidden portfolio cards. */
export const renderedPropertySummaryRows = (
  property: RecordsResponse['properties'][number] | undefined,
  visibleProperties: readonly RecordsResponse['properties'][number][],
) => (property === undefined ? visibleProperties : [property]);

/** The caller supplies exactly the filtered, ordered, rendered cards, never the whole register. */
export const usePrefetchPropertySummaries = (
  input: RecordsInput,
  rows: readonly RecordsResponse['properties'][number][],
  revision: number,
): void => {
  const selection = keyOf(summaryInputs(input, rows, revision).map(propertySummary.key));
  const { scope } = input;
  const preload = useEffectEvent((currentScope: string) =>
    preloadPropertySummaries({ ...input, scope: currentScope }, rows, revision),
  );
  useEffect(() => {
    if (selection === '[]') {
      return constVoid;
    }
    let fiber = browserRuntime.runFork(preload(scope));
    const restart = (event: Event) => {
      if (changeConcerns(event, summaryApps)) {
        fiber.interruptUnsafe();
        fiber = browserRuntime.runFork(preload(scope));
      }
    };
    globalThis.addEventListener(moduleWriteEvent, restart);
    globalThis.addEventListener(moduleChangeEvent, restart);
    return () => {
      globalThis.removeEventListener(moduleWriteEvent, restart);
      globalThis.removeEventListener(moduleChangeEvent, restart);
      fiber.interruptUnsafe();
    };
  }, [scope, selection]);
};
export const preloadPage = modulePagePreload((props) => {
  const input = recordsInput(props.context);
  if (!input.reusable) {
    return Effect.void;
  }
  return propertyRecords.read(input).pipe(
    Effect.flatMap(({ records }) => {
      const search = readPropertySearch(
        Result.getOrUndefined(
          Schema.decodeUnknownResult(Schema.toCodecJson(Schema.URLSearchParams))(props.search).pipe(
            Result.flatMap(Schema.decodeUnknownResult(Schema.fromURLSearchParams(PropertySearchInputSchema))),
          ),
        ) ?? null,
      );
      const { propertyId } = propertySelection(records, search.resourceId);
      return propertyId === ''
        ? Effect.void
        : propertySummary.preload({ ...input, propertyId, revision: records.revision });
    }),
    Effect.ignore,
  );
});
const summaryValue = (snapshot: ReturnType<typeof propertySummary.snapshot>) => {
  if (snapshot.state === 'failed') {
    return snapshot.error.value;
  }
  return snapshot.state === 'ready' ? snapshot.value : undefined;
};
export const usePropertySummary = (input: SummaryInput) => {
  const { propertyId } = input;
  const snapshot = useSyncExternalStore(
    (listener) => propertySummary.subscribe(listener, propertyId === '' ? undefined : input),
    () => (propertyId === '' ? pageDataPending : propertySummary.snapshot(input)),
    () => pageDataPending,
  );
  const { revision, scope } = input;
  const read = useEffectEvent((currentScope: string, currentPropertyId: string, currentRevision: number) =>
    propertySummary
      .read({ ...input, propertyId: currentPropertyId, revision: currentRevision, scope: currentScope })
      .pipe(Effect.ignore),
  );
  useEffect(() => {
    const fiber = propertyId === '' ? undefined : browserRuntime.runFork(read(scope, propertyId, revision));
    return () => fiber?.interruptUnsafe();
  }, [scope, propertyId, revision]);
  const summary = summaryValue(snapshot);
  const summaryFailures: string[] = [];
  if (summary !== undefined) {
    if (Result.isFailure(summary.agreements)) {
      summaryFailures.push('agreementsUnavailable');
    }
    if (Result.isFailure(summary.finance)) {
      summaryFailures.push('financeUnavailable');
    }
    if (Result.isFailure(summary.occupancy)) {
      summaryFailures.push('occupancyUnavailable');
    }
    if (Result.isFailure(summary.work)) {
      summaryFailures.push('tasksUnavailable');
    }
  }
  return {
    agreements: summary === undefined ? undefined : Result.getOrUndefined(summary.agreements),
    finance: summary === undefined ? undefined : Result.getOrUndefined(summary.finance),
    loadSummary: () => {
      if (propertyId !== '') {
        browserRuntime.runFork(propertySummary.refresh(input));
      }
    },
    occupancy: summary === undefined ? undefined : Result.getOrUndefined(summary.occupancy),
    summaryFailures,
    summaryPending: propertyId !== '' && (snapshot.state === 'pending' || snapshot.refreshing),
    work: summary === undefined ? undefined : Result.getOrUndefined(summary.work),
  };
};
