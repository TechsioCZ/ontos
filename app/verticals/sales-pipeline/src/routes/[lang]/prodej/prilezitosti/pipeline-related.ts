// Records that hang off one business case (opportunity): its tasks, contracts and orders/offers in the owning modules.
import { documentNavigationModules } from '@app/shared-contracts';
import { listOrders } from '@app/merchandise/clients/records';
import { executeRecords as executeAgreementsRecords } from '@app/legal-agreements/clients/records';
import { listTasks } from '@app/work-tasks/clients/records';
import { Effect, Random } from 'effect';
import { useEffect, useState } from 'react';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

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
          contracts: section(
            published,
            'legal.agreements',
            counterpartyId === undefined
              ? Effect.succeed<readonly RelatedContract[]>([])
              : correlation('contracts').pipe(
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
                listOrders(id, { limit: 0, orderOpportunityId: opportunity.id, ordersLimit: 250 }),
              ),
              Effect.map((orders) =>
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
        { concurrency: 3 },
      ),
    ),
  );

const loading: OpportunityRelated = {
  contracts: { status: 'loading' },
  orders: { status: 'loading' },
  tasks: { status: 'loading' },
};

/** Loads the related records whenever the open case (or its customer link) changes. */
export const useOpportunityRelated = (
  opportunity: Opportunity | undefined,
  counterpartyId: string | undefined,
): OpportunityRelated => {
  const opportunityId = opportunity?.id;
  const partyId = opportunity?.partyId;
  const key = opportunityId === undefined ? '' : `${opportunityId}:${partyId ?? ''}:${counterpartyId ?? ''}`;
  const [result, setResult] = useState<{ readonly key: string; readonly related: OpportunityRelated }>();
  useEffect((): (() => void) | undefined => {
    if (opportunityId === undefined || partyId === undefined) {
      return undefined;
    }
    let active = true;
    void browserRuntime.runPromise(
      loadOpportunityRelated({ id: opportunityId, partyId }, counterpartyId).pipe(
        Effect.tap((related) =>
          Effect.sync(() => {
            if (active) {
              setResult({ key, related });
            }
          }),
        ),
      ),
    );
    return () => {
      active = false;
    };
  }, [counterpartyId, key, opportunityId, partyId]);
  return result?.key === key ? result.related : loading;
};
