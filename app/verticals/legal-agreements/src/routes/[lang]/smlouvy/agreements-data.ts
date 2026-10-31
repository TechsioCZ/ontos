import { definePageData, modulePagePreload } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { executeCounterpartyRead, listCustomers } from '@app/party-registry/api/client';
import { executeRecords as executePropertyRecords } from '@app/property-portfolio/clients/records';
import { executeRecords as executeOccupancyRecords } from '@app/property-leasing/clients/records';
import { Effect, Match, Option, Result, Schema } from 'effect';
import { failureFeedback } from '../../../../shared/actions/apply-command.ts';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Contract } from '../../../../shared/apis/records.ts';
import { ContractRefSchema } from '../../../../shared/resources/contract.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { executeRecords } from '../../../api/records-client.ts';
import { rentalReferenceAccess } from './rental-reference-access.ts';

/** The agreements a page shows: the person's legal entity and the optional contract opened from the query. */
export interface AgreementsInput {
  readonly legalEntityId: string;
  readonly resourceId: string | undefined;
}

const RecordsSearchSchema = Schema.Struct({ resourceId: Schema.optional(ContractRefSchema.fields.resourceId) });

/** Decodes a raw query string (`?resourceId=…`, the shape the Shell passes as `search`). */
const searchCodec = Schema.toCodecJson(Schema.fromURLSearchParams(RecordsSearchSchema));

export const resourceIdOf = (search: string): string | undefined =>
  Option.getOrUndefined(Schema.decodeOption(searchCodec)(search))?.resourceId;

export const agreementsInputOf = (props: Partial<ModulePageProps>, routerSearch: string): AgreementsInput => ({
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

/**
 * Everything the list and the detail render on their first commit: contracts, counterparty names, the rental
 * reference access check and, when it allows it, the unit names used in contract titles.
 */
const loadAgreements = (input: AgreementsInput) =>
  Effect.all(
    {
      customers: listCustomers({ includeArchived: false }),
      records: executeRecords({}, 'legal-agreements.records'),
      rental: rentalReferenceAccess.pipe(
        Effect.flatMap((readable) =>
          readable ? settledRead(loadRentalReferences).pipe(Effect.asSome) : Effect.succeedNone,
        ),
      ),
    },
    { concurrency: 3 },
  ).pipe(
    Effect.flatMap(({ customers, records, rental }) => {
      const linked = records.contracts.find((record) => record.contractRef.resourceId === input.resourceId);
      const customerName =
        linked === undefined
          ? Effect.succeedNone
          : settledRead(
              executeCounterpartyRead(
                { counterpartyRef: linked.counterpartyRef },
                'legal-agreements.customer-detail',
              ).pipe(Effect.map((customer) => customer.party.displayName ?? undefined)),
            ).pipe(Effect.asSome);
      return customerName.pipe(Effect.map((name) => Option.some({ customerName: name, customers, records, rental })));
    }),
    // A denial replaces whatever was on screen: an earlier value must not outlive revoked access.
    Effect.catchIf(
      (failure) => failureFeedback(failure) === 'forbidden',
      () => Effect.succeedNone,
    ),
  );

export type Agreements = Effect.Success<ReturnType<typeof loadAgreements>>;

/** The page's primary data: loaded before the Shell reveals the page, kept per document, revalidated after writes. */
export const agreements = definePageData({
  key: (input: AgreementsInput) => `${input.legalEntityId}|${input.resourceId ?? ''}`,
  load: loadAgreements,
  runtime: browserRuntime,
});

export const preloadPage = modulePagePreload((props) => agreements.preload(agreementsInputOf(props, props.search)));

const succeededRead = <A>(read: Option.Option<Result.Result<A, Feedback>>): A | undefined =>
  read.pipe(Option.flatMap(Result.getSuccess), Option.getOrUndefined);

const failedRead = <A>(read: Option.Option<Result.Result<A, Feedback>>): Feedback | undefined =>
  read.pipe(Option.flatMap(Result.getFailure), Option.getOrUndefined);

const loadFeedbackOf = (page: AgreementsSnapshot): Feedback =>
  Match.value(page).pipe(
    Match.when({ state: 'pending' }, () => 'loading' as const),
    Match.when({ state: 'failed' }, ({ error }) => failureFeedback(error)),
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

/** What the page renders from its dataset and its local state. */
export const agreementsView = (page: AgreementsSnapshot, local: AgreementsLocalState) => {
  const loaded = !local.hidden && page.state === 'ready' ? Option.getOrUndefined(page.value) : undefined;
  const preparedRental = loaded === undefined ? undefined : succeededRead(loaded.rental);
  const rental = local.hidden ? undefined : (preparedRental ?? local.requestedRental);
  const records = loaded?.records;
  const preparedLeases =
    preparedRental !== undefined && records?.contracts.some((record) => record.kind === 'LEASE') === true;
  return {
    /** A lease when rental references were prepared for lease contracts, until the person picks a kind. */
    contractKind: local.chosenContractKind ?? (preparedLeases ? ('LEASE' as const) : ('OTHER' as const)),
    customerName: loaded === undefined ? undefined : succeededRead(loaded.customerName),
    customerNameFeedback: loaded === undefined ? undefined : failedRead(loaded.customerName),
    customers: loaded?.customers ?? [],
    feedback: local.actionFeedback ?? loadFeedbackOf(page),
    occupancies: rental?.occupancies,
    properties: rental?.properties,
    records,
    rental,
    rentalFeedback: local.requestedRentalFeedback ?? preparedRentalFeedback(local, loaded),
  };
};
