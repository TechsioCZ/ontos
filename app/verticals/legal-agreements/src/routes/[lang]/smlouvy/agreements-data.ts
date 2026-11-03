import { definePageData, modulePagePreload, pageDataPending, pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext, ModulePageProps, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { executeCounterpartyRead, listCustomers } from '@app/party-registry/api/client';
import { executeRecords as executePropertyRecords } from '@app/property-portfolio/clients/records';
import { executeRecords as executeOccupancyRecords } from '@app/property-leasing/clients/records';
import { Data, Effect, Match, Option, Result, Schema } from 'effect';
import { failureFeedback } from '../../../../shared/actions/apply-command.ts';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Contract } from '../../../../shared/apis/records.ts';
import { ContractRefSchema } from '../../../../shared/resources/contract.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { executeRecords } from '../../../api/records-client.ts';
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';
import { rentalReferenceAccess } from './rental-reference-access.ts';

/** The agreements a page shows: the person's legal entity and the optional contract opened from the query. */
export interface AgreementsInput {
  readonly context?: ModulePageContext | undefined;
  readonly legalEntityId: string;
  readonly resourceId?: string | undefined;
}

const RecordsSearchSchema = Schema.Struct({ resourceId: Schema.optional(ContractRefSchema.fields.resourceId) });

/** Decodes a raw query string (`?resourceId=…`, the shape the Shell passes as `search`). */
const searchCodec = Schema.toCodecJson(Schema.fromURLSearchParams(RecordsSearchSchema));

export const resourceIdOf = (search: string): string | undefined =>
  Option.getOrUndefined(Schema.decodeOption(searchCodec)(search))?.resourceId;

export const agreementsInputOf = (props: Partial<ModulePageProps>, routerSearch: string): AgreementsInput => ({
  context: props.context,
  legalEntityId: props.context?.legalEntityId ?? '',
  resourceId: resourceIdOf(props.search ?? routerSearch),
});

export type Properties = Effect.Success<ReturnType<typeof executePropertyRecords>>;
export type Occupancies = Effect.Success<ReturnType<typeof executeOccupancyRecords>>;
export interface RentalReferences {
  readonly occupancies: Occupancies;
  readonly properties: Properties;
}

export const loadRentalReferences = Effect.all(
  {
    occupancies: executeOccupancyRecords({}, 'legal-agreements.occupancies'),
    properties: executePropertyRecords({}, 'legal-agreements.units'),
  },
  { concurrency: 2 },
);

/** A secondary read that failed leaves its feedback next to the primary data instead of failing the page. */
const settledRead = <A, E extends { readonly _tag: string; readonly status?: number }, R>(
  read: Effect.Effect<A, E, R>,
): Effect.Effect<Result.Result<A, Feedback>, never, R> => read.pipe(Effect.mapError(failureFeedback), Effect.result);

interface LoadedAgreements {
  readonly customers: Result.Result<Effect.Success<ReturnType<typeof listCustomers>>, Feedback>;
  readonly records: Effect.Success<ReturnType<typeof executeRecords>>;
  readonly rental: Option.Option<Result.Result<RentalReferences, Feedback>>;
}
class AgreementsSectionsIncomplete extends Data.TaggedError('AgreementsSectionsIncomplete')<{
  readonly value: LoadedAgreements;
}> {}

/**
 * Everything the list and the detail render on their first commit: contracts, counterparty names, the rental
 * reference access check and, when it allows it, the unit names used in contract titles.
 */
const loadAgreements = (_input: AgreementsInput) =>
  Effect.all(
    {
      customers: settledRead(listCustomers({ includeArchived: false })),
      records: executeRecords({}, 'legal-agreements.records'),
      rental: rentalReferenceAccess.pipe(
        Effect.flatMap((readable) =>
          readable ? settledRead(loadRentalReferences).pipe(Effect.asSome) : Effect.succeedNone,
        ),
      ),
    },
    { concurrency: 3 },
  ).pipe(
    Effect.flatMap((value) =>
      Result.isFailure(value.customers) || (Option.isSome(value.rental) && Result.isFailure(value.rental.value))
        ? Effect.fail(new AgreementsSectionsIncomplete({ value }))
        : Effect.succeed(Option.some(value)),
    ),
  );

export type Agreements = Option.Option<LoadedAgreements>;

const moduleId = 'legal.agreements';

/** Selection is not a dataset identity. Opening another contract never rereads all records. */
const makeAgreementsData = () =>
  definePageData({
    key: (input: AgreementsInput) => pageDataScopeKey(input.context, moduleId) ?? input.legalEntityId,
    load: loadAgreements,
    maxEntries: 8,
    retainStale: false,
    runtime: browserRuntime,
  });
export const agreements = makeAgreementsData();

/** Standalone pages do not share data across mounts without a complete trusted identity. */
export const useAgreementsDataset = (input: AgreementsInput) => {
  const [standalone, setStandalone] = useState(() => ({ data: makeAgreementsData(), key: input.legalEntityId }));
  if (standalone.key !== input.legalEntityId) {
    setStandalone({ data: makeAgreementsData(), key: input.legalEntityId });
  }
  const data = pageDataScopeKey(input.context, moduleId) === undefined ? standalone.data : agreements;
  const { legalEntityId } = input;
  const tenantId = input.context?.tenantId;
  const principalId = input.context?.principalId;
  const companyId = input.context?.legalEntityId;
  useEffect(() => {
    const context =
      tenantId === undefined || principalId === undefined || companyId === undefined
        ? undefined
        : { legalEntityId: companyId, principalId, tenantId };
    data.ensure({ context, legalEntityId });
  }, [data, legalEntityId, tenantId, principalId, companyId]);
  return data;
};

export interface AgreementCustomerInput {
  readonly contract: Contract;
  readonly revision: number;
  readonly scope: string;
}
const CustomerKeySchema = Schema.fromJsonString(Schema.Array(Schema.String));
const customerKey = ({ contract, revision, scope }: AgreementCustomerInput): string =>
  Result.getOrThrow(
    Schema.encodeResult(CustomerKeySchema)([
      scope,
      contract.contractRef.tenantId,
      contract.contractRef.resourceId,
      contract.counterpartyRef.tenantId,
      contract.counterpartyRef.resourceId,
      String(revision),
    ]),
  );
const loadAgreementCustomer = (contract: Contract) =>
  executeCounterpartyRead({ counterpartyRef: contract.counterpartyRef }, 'legal-agreements.customer-detail').pipe(
    Effect.map((customer) => customer.party.displayName ?? undefined),
    Effect.mapError(failureFeedback),
  );

export const agreementCustomerData = definePageData({
  cancelWhenUnused: true,
  key: customerKey,
  load: ({ contract }: AgreementCustomerInput) => loadAgreementCustomer(contract),
  maxEntries: 256,
  retainStale: false,
  runtime: browserRuntime,
});

export const preloadAgreementCustomers = (
  context: ModulePageContext | undefined,
  contracts: readonly Contract[],
  revision: number,
): Effect.Effect<void> => {
  const scope = pageDataScopeKey(context, moduleId);
  return scope === undefined
    ? Effect.void
    : Effect.forEach(
        contracts.slice(0, 200),
        (contract) => agreementCustomerData.read({ contract, revision, scope }).pipe(Effect.ignore),
        { concurrency: 2, discard: true },
      );
};

export const usePrefetchAgreementCustomers = (
  context: ModulePageContext | undefined,
  contracts: readonly Contract[],
  revision: number,
): void => {
  const scope = pageDataScopeKey(context, moduleId);
  const selection = Result.getOrThrow(
    Schema.encodeResult(CustomerKeySchema)(
      contracts.slice(0, 200).map((contract) => customerKey({ contract, revision, scope: scope ?? '' })),
    ),
  );
  const pending = useSyncExternalStore(
    agreementCustomerData.subscribe,
    () =>
      scope !== undefined &&
      contracts
        .slice(0, 200)
        .some((contract) => agreementCustomerData.snapshot({ contract, revision, scope }).state === 'pending'),
    () => false,
  );
  const preload = useEffectEvent((_selection: string) => preloadAgreementCustomers(context, contracts, revision));
  useEffect(() => {
    const fiber = pending && scope !== undefined ? browserRuntime.runFork(preload(selection)) : undefined;
    return () => fiber?.interruptUnsafe();
  }, [pending, scope, selection]);
};

export const useAgreementCustomer = (
  context: ModulePageContext | undefined,
  contract: Contract | undefined,
  revision: number,
) => {
  const scope = pageDataScopeKey(context, moduleId);
  const input = contract === undefined || scope === undefined ? undefined : { contract, revision, scope };
  const requestScope =
    scope ??
    Result.getOrThrow(
      Schema.encodeResult(CustomerKeySchema)([
        context?.tenantId ?? '',
        context?.principalId ?? '',
        context?.legalEntityId ?? '',
      ]),
    );
  const key = contract === undefined ? '' : customerKey({ contract, revision, scope: requestScope });
  const cached = useSyncExternalStore(
    (listener) => agreementCustomerData.subscribe(listener, input),
    () => (input === undefined ? pageDataPending : agreementCustomerData.snapshot(input)),
    () => pageDataPending,
  );
  const [local, setLocal] = useState<{
    readonly key: string;
    readonly result: Result.Result<string | undefined, Feedback>;
  }>();
  const read = useEffectEvent((selection: string) => {
    if (contract === undefined) {
      return Effect.void;
    }
    if (input !== undefined) {
      return agreementCustomerData.read(input).pipe(Effect.ignore);
    }
    return loadAgreementCustomer(contract).pipe(
      Effect.result,
      Effect.tap((result) => Effect.sync(() => setLocal({ key: selection, result }))),
    );
  });
  const enabled = contract !== undefined;
  useEffect(() => {
    const fiber = enabled ? browserRuntime.runFork(read(key)) : undefined;
    return () => {
      fiber?.interruptUnsafe();
      setLocal(undefined);
    };
  }, [key, enabled]);
  const selectedResult = (): Result.Result<string | undefined, Feedback> | undefined => {
    if (input === undefined) {
      return local?.key === key ? local.result : undefined;
    }
    if (cached.state === 'ready') {
      return Result.succeed(cached.value);
    }
    return cached.state === 'failed' ? Result.fail(cached.error) : undefined;
  };
  const result = selectedResult();
  return {
    customerName: result === undefined ? undefined : Result.getSuccess(result).pipe(Option.getOrUndefined),
    customerNameFeedback: result === undefined ? undefined : Result.getFailure(result).pipe(Option.getOrUndefined),
  };
};

export const useAgreementDetails = (
  input: AgreementsInput,
  contract: Contract | undefined,
  visible: readonly Contract[],
  records: { readonly revision: number } | undefined,
) => {
  const revision = records?.revision ?? 0;
  usePrefetchAgreementCustomers(input.context, input.resourceId === undefined ? visible : [], revision);
  return useAgreementCustomer(input.context, contract, revision);
};

/** Exact cold URL selection is prepared after its authorized base read, without a second records request. */
export const preloadPage = modulePagePreload((props) => {
  const input = agreementsInputOf(props, props.search);
  return pageDataScopeKey(input.context, moduleId) === undefined
    ? Effect.void
    : agreements.read(input).pipe(
        Effect.catchTag('AgreementsSectionsIncomplete', ({ value }) => Effect.succeedSome(value)),
        Effect.flatMap((value) => {
          const contract = Option.getOrUndefined(value)?.records.contracts.find(
            (item) => item.contractRef.resourceId === input.resourceId,
          );
          return contract === undefined
            ? Effect.void
            : preloadAgreementCustomers(input.context, [contract], Option.getOrUndefined(value)?.records.revision ?? 0);
        }),
        Effect.ignore,
      );
});

const succeededRead = <A>(read: Option.Option<Result.Result<A, Feedback>>): A | undefined =>
  read.pipe(Option.flatMap(Result.getSuccess), Option.getOrUndefined);

const failedRead = <A>(read: Option.Option<Result.Result<A, Feedback>>): Feedback | undefined =>
  read.pipe(Option.flatMap(Result.getFailure), Option.getOrUndefined);

const loadFeedbackOf = (page: AgreementsSnapshot): Feedback =>
  Match.value(page).pipe(
    Match.when({ state: 'pending' }, () => 'loading' as const),
    Match.when({ state: 'failed' }, ({ error }) =>
      Match.value(error).pipe(
        Match.tag('AgreementsSectionsIncomplete', () => 'ready' as const),
        Match.orElse(failureFeedback),
      ),
    ),
    Match.orElse(({ value }) => (Option.isNone(value) ? ('forbidden' as const) : ('ready' as const))),
  );

type AgreementsSnapshot = PageDataSnapshot<Agreements, Effect.Error<ReturnType<typeof loadAgreements>>>;

/** Page-local state that refines the dataset: the last action's outcome and the draft form's choices. */
export interface AgreementsLocalState {
  readonly actionFeedback: Feedback | undefined;
  readonly chosenContractKind: Contract['kind'] | undefined;
  /** Set after a denied or unavailable command: nothing read under the earlier access stays on screen. */
  readonly hidden: boolean;
  readonly requestedRental: RentalReferences | undefined;
  readonly requestedRentalFeedback: Feedback | undefined;
}

/** The prepared rental read's failure, shown until the person picks a contract kind. */
const preparedRentalFeedback = (
  local: AgreementsLocalState,
  loaded: Option.Option.Value<Agreements> | undefined,
): Feedback | undefined =>
  local.chosenContractKind === undefined && loaded !== undefined ? failedRead(loaded.rental) : undefined;

const preparedAgreements = (page: AgreementsSnapshot): LoadedAgreements | undefined =>
  Match.value(page).pipe(
    Match.when({ state: 'ready' }, ({ value }) => Option.getOrUndefined(value)),
    Match.when({ state: 'failed' }, ({ error }) =>
      Match.value(error).pipe(
        Match.tag('AgreementsSectionsIncomplete', ({ value }) => value),
        Match.orElse((): undefined => undefined),
      ),
    ),
    Match.orElse((): undefined => undefined),
  );

/** What the page renders from its dataset and its local state. */
export const agreementsView = (page: AgreementsSnapshot, local: AgreementsLocalState) => {
  const loaded = local.hidden ? undefined : preparedAgreements(page);
  const preparedRental = loaded === undefined ? undefined : succeededRead(loaded.rental);
  const rental = local.hidden ? undefined : (preparedRental ?? local.requestedRental);
  const records = loaded?.records;
  const preparedLeases =
    preparedRental !== undefined && records?.contracts.some((record) => record.kind === 'LEASE') === true;
  return {
    /** A lease when rental references were prepared for lease contracts, until the person picks a kind. */
    contractKind: local.chosenContractKind ?? (preparedLeases ? ('LEASE' as const) : ('OTHER' as const)),
    customers: loaded === undefined ? [] : Option.getOrElse(Result.getSuccess(loaded.customers), () => []),
    customersFeedback: loaded === undefined ? undefined : Option.getOrUndefined(Result.getFailure(loaded.customers)),
    feedback: local.actionFeedback ?? loadFeedbackOf(page),
    occupancies: rental?.occupancies,
    properties: rental?.properties,
    records,
    rental,
    rentalFeedback: local.requestedRentalFeedback ?? preparedRentalFeedback(local, loaded),
  };
};
