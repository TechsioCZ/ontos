// Records that hang off one business case (opportunity): its tasks, contracts and orders/offers in the owning modules.
import { documentNavigationModules } from '@app/shared-contracts';
import { RecordsRequestSchema as MerchandiseRecordsRequestSchema } from '@app/merchandise/apis/records';
import { executeRecords as executeMerchandiseRecords } from '@app/merchandise/apis/records/client';
import { executeRecords as executeAgreementsRecords } from '@app/legal-agreements/clients/records';
import { executeRecords as executeTaskRecords } from '@app/work-tasks/clients/records';
import { useHeldSnapshot } from '@app/admin-ui';
import { Data, Effect, Random, Result, Schema } from 'effect';
import { definePageData, pageDataPending, pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';
import type { TanstackTable } from '@techsio/ui-kit/organisms/data-table';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

/** Work Tasks records for this view, each read under its own correlation. */
const listTasks = (filters: Parameters<typeof executeTaskRecords>[0] = {}) =>
  Random.nextInt.pipe(Effect.flatMap((id) => executeTaskRecords(filters, `work-tasks:list:${id}`)));

/** One related list: hidden when the module is not part of this company, `unavailable` when its read failed. */
export type RelatedSection<Item> =
  | { readonly status: 'loading' }
  | { readonly status: 'absent' }
  | { readonly status: 'unavailable' }
  | { readonly items: readonly Item[]; readonly status: 'ready' };

export interface RelatedTask {
  readonly assignedToCase: boolean;
  readonly dueDate: Effect.Success<ReturnType<typeof listTasks>>['items'][number]['dueDate'];
  readonly id: string;
  readonly state: 'CANCELLED' | 'DONE' | 'IN_PROGRESS' | 'NEW' | 'WAITING';
  readonly title: string;
}

export interface RelatedContract {
  readonly id: string;
  readonly kind: 'LEASE' | 'OTHER';
  readonly lifecycleState: 'ACTIVE' | 'DRAFT' | 'EXPIRED' | 'TERMINATED';
  readonly startDate: Effect.Success<ReturnType<typeof executeAgreementsRecords>>['contracts'][number]['startDate'];
  readonly subject: string | undefined;
}

export interface RelatedOrder {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly totalMinor: number;
}

export interface OpportunityRelated {
  readonly contracts: RelatedSection<RelatedContract>;
  readonly orders: RelatedSection<RelatedOrder>;
  readonly tasks: RelatedSection<RelatedTask>;
}

/** Modules the shell pinned on the document for the selected company; `undefined` when it pinned none. */
const publishedModules = Effect.sync(documentNavigationModules);

const section = <Item, Failure>(
  published: ReadonlySet<string> | undefined,
  moduleId: string,
  read: Effect.Effect<readonly Item[], Failure>,
): Effect.Effect<RelatedSection<Item>> =>
  published !== undefined && !published.has(moduleId)
    ? Effect.succeed({ status: 'absent' })
    : read.pipe(
        Effect.map((items): RelatedSection<Item> => ({ items, status: 'ready' })),
        Effect.orElseSucceed((): RelatedSection<Item> => ({ status: 'unavailable' })),
      );

const correlation = (name: string) =>
  Random.nextInt.pipe(Effect.map((nonce) => `sales-pipeline:related-${name}:${nonce}`));

const taskRank = (task: RelatedTask) =>
  (task.assignedToCase ? 0 : 2) + (task.state === 'DONE' || task.state === 'CANCELLED' ? 1 : 0);

/**
 * Tasks linked to the case come first, then open tasks of the same customer. Contracts are the customer's
 * (counterparty's) contracts; orders are the ones created from this case.
 */
export const loadOpportunityRelated = (
  opportunity: Pick<Opportunity, 'id' | 'partyId'>,
  counterpartyId: string | undefined,
) =>
  publishedModules.pipe(
    Effect.flatMap((published) =>
      Effect.all(
        {
          contracts:
            counterpartyId === undefined
              ? Effect.succeed<RelatedSection<RelatedContract>>({
                  status: published !== undefined && !published.has('legal.agreements') ? 'absent' : 'unavailable',
                })
              : section(
                  published,
                  'legal.agreements',
                  correlation('contracts').pipe(
                    Effect.flatMap((id) => executeAgreementsRecords({}, id)),
                    Effect.map((records) =>
                      records.contracts.flatMap((contract): RelatedContract[] => {
                        if (contract.counterpartyRef.resourceId !== counterpartyId) {
                          return [];
                        }
                        return [
                          {
                            id: contract.contractRef.resourceId,
                            kind: contract.kind,
                            lifecycleState: contract.lifecycleState,
                            startDate: contract.startDate,
                            subject: contract.subject,
                          },
                        ];
                      }),
                    ),
                  ),
                ),
          orders: section(
            published,
            'demo.merchandise',
            correlation('orders').pipe(
              Effect.flatMap((id) =>
                Schema.decodeEffect(MerchandiseRecordsRequestSchema)({
                  view: { limit: 0, orderOpportunityId: opportunity.id, ordersLimit: 250 },
                }).pipe(Effect.flatMap((request) => executeMerchandiseRecords(request, id))),
              ),
              Effect.map(({ orders }) =>
                orders.map((order): RelatedOrder => ({
                  id: order.id,
                  number: order.number,
                  status: order.status,
                  totalMinor: order.totalMinor,
                })),
              ),
            ),
          ),
          tasks: section(
            published,
            'work.tasks',
            Effect.all([listTasks({ opportunityId: opportunity.id }), listTasks({ partyId: opportunity.partyId })], {
              concurrency: 2,
            }).pipe(
              Effect.map(([linked, customer]) => {
                const byId = new Map<string, RelatedTask>();
                for (const task of [...linked.items, ...customer.items]) {
                  const { resourceId } = task.ref;
                  if (!byId.has(resourceId)) {
                    byId.set(resourceId, {
                      assignedToCase: task.opportunityId === opportunity.id,
                      dueDate: task.dueDate,
                      id: resourceId,
                      state: task.state,
                      title: task.title,
                    });
                  }
                }
                return [...byId.values()].toSorted((a, b) => taskRank(a) - taskRank(b));
              }),
            ),
          ),
        },
        { concurrency: 1 },
      ),
    ),
  );

const moduleId = 'demo.sales-pipeline';

const loading: OpportunityRelated = {
  contracts: { status: 'loading' },
  orders: { status: 'loading' },
  tasks: { status: 'loading' },
};

class RelatedSectionsIncomplete extends Data.TaggedError('RelatedSectionsIncomplete')<{
  readonly value: OpportunityRelated;
}> {}

export interface OpportunityRelatedInput {
  readonly counterpartyId: string | undefined;
  readonly opportunity: Pick<Opportunity, 'id' | 'partyId'>;
  readonly revision: number;
  readonly scope: string;
}
const RelatedKeySchema = Schema.fromJsonString(Schema.Array(Schema.String));
const relatedKey = ({ counterpartyId, opportunity, revision, scope }: OpportunityRelatedInput): string =>
  Result.getOrThrow(
    Schema.encodeResult(RelatedKeySchema)([
      scope,
      opportunity.id,
      opportunity.partyId,
      counterpartyId ?? '',
      String(revision),
    ]),
  );

/** A refusal is renderable for this opening, never a cached successful authorization decision. */
export const opportunityRelatedData = definePageData({
  cancelWhenUnused: true,
  changesFrom: ['legal-agreements', 'merchandise', 'sales-pipeline', 'work-tasks'],
  key: relatedKey,
  load: ({ counterpartyId, opportunity }: OpportunityRelatedInput) =>
    loadOpportunityRelated(opportunity, counterpartyId).pipe(
      Effect.flatMap((value) =>
        [value.tasks, value.contracts, value.orders].every((item) => item.status === 'ready')
          ? Effect.succeed(value)
          : Effect.fail(new RelatedSectionsIncomplete({ value })),
      ),
    ),
  maxEntries: 256,
  retainStale: false,
  runtime: browserRuntime,
});

export interface VisibleOpportunityRelated {
  readonly counterpartyId: string | undefined;
  readonly opportunity: Opportunity;
}

/** Only the final sorted/paginated row model belongs here, never the unfiltered population. */
export const preloadOpportunityDetails = (
  context: ModulePageContext | undefined,
  rows: readonly VisibleOpportunityRelated[],
  revision: number,
): Effect.Effect<void> => {
  const scope = pageDataScopeKey(context, moduleId);
  return scope === undefined
    ? Effect.void
    : Effect.forEach(
        rows.slice(0, 200),
        ({ counterpartyId, opportunity }) =>
          opportunityRelatedData.read({ counterpartyId, opportunity, revision, scope }).pipe(Effect.ignore),
        { concurrency: 2, discard: true },
      );
};

/** Observe the kit's live final row model, including its sort, page and clamped page index. */
export const useVisibleOpportunityRows = (table: TanstackTable<Opportunity> | undefined): readonly Opportunity[] => {
  const model = useSyncExternalStore(
    (listener) => {
      const sorting = table?.atoms.sorting.subscribe(listener);
      const pagination = table?.atoms.pagination.subscribe(listener);
      const options = table?.optionsStore?.subscribe(listener);
      return () => {
        sorting?.unsubscribe();
        pagination?.unsubscribe();
        options?.unsubscribe();
      };
    },
    () => table?.getRowModel(),
    (): undefined => undefined,
  );
  return model?.rows.map((row) => row.original) ?? [];
};

export const usePrefetchOpportunityDetails = (
  context: ModulePageContext | undefined,
  rows: readonly VisibleOpportunityRelated[],
  revision: number,
): void => {
  const scope = pageDataScopeKey(context, moduleId);
  const selection = Result.getOrThrow(
    Schema.encodeResult(RelatedKeySchema)(
      rows
        .slice(0, 200)
        .map(({ counterpartyId, opportunity }) =>
          relatedKey({ counterpartyId, opportunity, revision, scope: scope ?? '' }),
        ),
    ),
  );
  const pending = useSyncExternalStore(
    opportunityRelatedData.subscribe,
    () =>
      scope !== undefined &&
      rows
        .slice(0, 200)
        .some(
          ({ counterpartyId, opportunity }) =>
            opportunityRelatedData.snapshot({ counterpartyId, opportunity, revision, scope }).state === 'pending',
        ),
    () => false,
  );
  const preload = useEffectEvent((_selection: string) => preloadOpportunityDetails(context, rows, revision));
  useEffect(() => {
    const fiber = pending && scope !== undefined ? browserRuntime.runFork(preload(selection)) : undefined;
    return () => fiber?.interruptUnsafe();
  }, [pending, scope, selection]);
};

/** A warm opening reads synchronously. A cold/missing-scope opening owns cancellable foreground work. */
export const useOpportunityRelated = (
  opportunity: Opportunity | undefined,
  counterpartyId: string | undefined,
  context?: ModulePageContext,
  revision = 0,
): OpportunityRelated => {
  const scope = pageDataScopeKey(context, moduleId);
  const input =
    opportunity === undefined || scope === undefined ? undefined : { counterpartyId, opportunity, revision, scope };
  const requestScope =
    scope ??
    Result.getOrThrow(
      Schema.encodeResult(RelatedKeySchema)([
        context?.tenantId ?? '',
        context?.principalId ?? '',
        context?.legalEntityId ?? '',
      ]),
    );
  const key =
    opportunity === undefined ? '' : relatedKey({ counterpartyId, opportunity, revision, scope: requestScope });
  const stored = useSyncExternalStore(
    (listener) => opportunityRelatedData.subscribe(listener, input),
    () => (input === undefined ? pageDataPending : opportunityRelatedData.snapshot(input)),
    () => pageDataPending,
  );
  // The strict store reads as pending while it reloads this same business case; its lists stay until it settles.
  const cached = useHeldSnapshot(key, stored);
  const [local, setLocal] = useState<{ readonly key: string; readonly value: OpportunityRelated }>();
  const read = useEffectEvent((selection: string) => {
    if (opportunity === undefined) {
      return Effect.void;
    }
    if (input !== undefined) {
      return opportunityRelatedData.read(input).pipe(Effect.ignore);
    }
    return loadOpportunityRelated(opportunity, counterpartyId).pipe(
      Effect.tap((value) => Effect.sync(() => setLocal({ key: selection, value }))),
    );
  });
  const enabled = opportunity !== undefined;
  useEffect(() => {
    const fiber = enabled ? browserRuntime.runFork(read(key)) : undefined;
    return () => {
      fiber?.interruptUnsafe();
      setLocal(undefined);
    };
  }, [key, enabled]);
  if (input !== undefined) {
    if (cached.state === 'ready') {
      return cached.value;
    }
    return cached.state === 'failed' ? cached.error.value : loading;
  }
  return local?.key === key ? local.value : loading;
};
