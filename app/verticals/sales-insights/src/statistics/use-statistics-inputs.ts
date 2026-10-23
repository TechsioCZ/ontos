import { listCustomers } from '@app/party-registry/api/client';
import { listMovements, listOrders, listProducts } from '@app/merchandise/clients/records';
import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { listInvoices } from '@app/finance-billing/clients/records';
import { listTasks } from '@app/work-tasks/clients/records';
import { assignmentsForSubjects, listTags } from '@app/tagging/clients/records';
import { listEmployees } from '@app/workforce/clients/records';
import { definePageData } from '@app/shared-contracts/page-data';
import type { PageData, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { Effect, Random, Ref, Schema } from 'effect';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type {
  EmployeeInput,
  InvoiceInput,
  MetricInputs,
  MovementInput,
  NamedInput,
  OpportunityInput,
  OrderInput,
  ProductInput,
  TagAssignmentInput,
  TaskInput,
} from '../../shared/metrics.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { unreadableSources } from './readable-sources.ts';

export const StatisticsSourceSchema = Schema.Literals([
  'customers',
  'employees',
  'invoices',
  'movements',
  'opportunities',
  'orders',
  'products',
  'tags',
  'tasks',
]);
export type StatisticsSource = typeof StatisticsSourceSchema.Type;

export type StatisticsData =
  | { readonly status: 'loading' }
  | {
      readonly failed: readonly StatisticsSource[];
      /** Sources the producer refused with 403: this role may not read them, so they are a permission state. */
      readonly forbidden: readonly StatisticsSource[];
      readonly inputs: MetricInputs;
      readonly status: 'ready';
    };

/** Tag assignments are a second read: they wait for the subject ids, so they are kept apart from the tag names. */
type SourceKey = StatisticsSource | 'tagAssignments';

interface SourceValues {
  readonly customers: readonly NamedInput[];
  readonly employees: readonly EmployeeInput[];
  readonly invoices: readonly InvoiceInput[];
  readonly movements: readonly MovementInput[];
  readonly opportunities: readonly OpportunityInput[];
  readonly orders: readonly OrderInput[];
  readonly products: readonly ProductInput[];
  readonly tagAssignments: readonly TagAssignmentInput[];
  readonly tags: readonly NamedInput[];
  readonly tasks: readonly TaskInput[];
}

/** Why a source contributes no rows: the role may not read it, or its producer read failed. */
export interface SourceProblem {
  readonly reason: 'failed' | 'forbidden';
  readonly source: StatisticsSource;
}

/** The page datasets are kept per legal entity; a role only changes with a sign-out, which reloads the document. */
export interface StatisticsPageInput {
  readonly legalEntityId: string;
}

const isForbiddenProblem = Schema.is(Schema.Struct({ status: Schema.Literal(403) }));

/**
 * Sources refused with 403 while this module is loaded. A role does not change without a sign-out, which reloads
 * the document, so a refused source is not read again: a revisit fires no request the producer would refuse.
 */
const refusedSources = browserRuntime.runSync(Ref.make<ReadonlySet<StatisticsSource>>(new Set()));

const withSource =
  (source: StatisticsSource) =>
  (current: ReadonlySet<StatisticsSource>): ReadonlySet<StatisticsSource> =>
    new Set([...current, source]);

/**
 * One producer read. A failing read must not blank the page: it fails with a typed problem the page shows as a
 * warning, and the next visit reads again. A 403 is a permission state, and later loads skip that read. A source
 * whose module the shell composition leaves out gets the same permission state without being read.
 */
const sourceRead = <A, E>(source: StatisticsSource, read: Effect.Effect<A, E>): Effect.Effect<A, SourceProblem> =>
  Effect.all([Ref.get(refusedSources), unreadableSources], { concurrency: 1 }).pipe(
    Effect.flatMap(([refused, unreadable]) =>
      // A module the role cannot access is refused without a read, so its producer never answers 403.
      refused.has(source) || unreadable.has(source)
        ? Effect.fail<SourceProblem>({ reason: 'forbidden', source })
        : read.pipe(
            Effect.matchEffect({
              onFailure: (cause): Effect.Effect<A, SourceProblem> =>
                isForbiddenProblem(cause)
                  ? Ref.update(refusedSources, withSource(source)).pipe(
                      Effect.andThen(Effect.fail<SourceProblem>({ reason: 'forbidden', source })),
                    )
                  : Effect.fail<SourceProblem>({ reason: 'failed', source }),
              onSuccess: Effect.succeed,
            }),
          ),
    ),
  );

const requestId = (operation: string) =>
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
    Effect.map(([first, second]) => `sales-insights:${operation}:${first}:${second}`),
  );

const toOpportunity = (item: {
  readonly amountMinor: number;
  readonly closedAt?: OpportunityInput['closedAt'];
  readonly createdAt: OpportunityInput['createdAt'];
  readonly expectedCloseDate: OpportunityInput['expectedCloseDate'];
  readonly id: string;
  readonly ownerEmployeeId?: string | undefined;
  readonly partyId: string;
  readonly probability: number;
  readonly stage: OpportunityInput['stage'];
}): OpportunityInput => ({
  amountMinor: item.amountMinor,
  closedAt: item.closedAt,
  createdAt: item.createdAt,
  expectedCloseDate: item.expectedCloseDate,
  id: item.id,
  ownerEmployeeId: item.ownerEmployeeId,
  partyId: item.partyId,
  probability: item.probability,
  stage: item.stage,
});

const toInvoice = (item: {
  readonly businessState: InvoiceInput['businessState'];
  readonly direction?: InvoiceInput['direction'];
  readonly issueDate: InvoiceInput['issueDate'];
  readonly opportunityId?: string | undefined;
  readonly paidMinor: number;
  readonly partyId?: string | undefined;
  readonly paymentState: InvoiceInput['paymentState'];
  readonly totalMinor: number;
}): InvoiceInput => ({
  businessState: item.businessState,
  direction: item.direction,
  issueDate: item.issueDate,
  opportunityId: item.opportunityId,
  paidMinor: item.paidMinor,
  partyId: item.partyId,
  paymentState: item.paymentState,
  totalMinor: item.totalMinor,
});

const toOrder = (item: {
  readonly createdAt: OrderInput['createdAt'];
  readonly id: string;
  readonly lines: readonly { readonly productId: string; readonly quantity: number }[];
  readonly opportunityId?: string | undefined;
  readonly partyId: string;
  readonly status: OrderInput['status'];
}): OrderInput => ({
  createdAt: item.createdAt,
  id: item.id,
  lines: item.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
  opportunityId: item.opportunityId,
  partyId: item.partyId,
  status: item.status,
});

const toTask = (item: {
  readonly assigneeEmployeeId?: string | undefined;
  readonly dueDate?: TaskInput['dueDate'];
  readonly partyId?: string | undefined;
  readonly state: TaskInput['state'];
  readonly updatedAt: TaskInput['updatedAt'];
}): TaskInput => ({
  assigneeEmployeeId: item.assigneeEmployeeId,
  dueDate: item.dueDate,
  partyId: item.partyId,
  state: item.state,
  updatedAt: item.updatedAt,
});

const toProduct = (item: {
  readonly currentPriceMinor: number;
  readonly id: string;
  readonly name: string;
}): ProductInput => ({
  currentPriceMinor: item.currentPriceMinor,
  id: item.id,
  name: item.name,
});

const toMovement = (item: { readonly delta: number; readonly productId: string }): MovementInput => ({
  delta: item.delta,
  productId: item.productId,
});

const toEmployee = (item: { readonly fullName: string; readonly id: string }): EmployeeInput => ({
  fullName: item.fullName,
  id: item.id,
});

const subjectKinds = ['customer', 'employee', 'opportunity', 'order', 'product'] as const;
/** The entity reads whose ids address the tag assignments: one per subject kind. */
const subjectSourceKeys = ['customers', 'employees', 'opportunities', 'orders', 'products'] as const;

type SourceData<K extends SourceKey> = PageData<StatisticsPageInput, SourceValues[K], SourceProblem>;

/** At most this many producer reads of one page run at once (the view needs up to ten sources). */
const SOURCE_READ_CONCURRENCY = 6;

const inputKey = (input: StatisticsPageInput): string => input.legalEntityId;

/** One producer source as a page dataset, so the Shell can prepare it before it reveals the page. */
const sourceData = <A, E>(
  source: StatisticsSource,
  read: Effect.Effect<readonly A[], E>,
): PageData<StatisticsPageInput, readonly A[], SourceProblem> =>
  definePageData({
    key: inputKey,
    load: (_input: StatisticsPageInput) => sourceRead(source, read),
    runtime: browserRuntime,
  });

const entityData = {
  customers: sourceData(
    'customers',
    listCustomers({}).pipe(
      Effect.map((items) =>
        items.map((item): NamedInput => ({ id: item.partyId, name: item.displayName ?? item.partyId })),
      ),
    ),
  ),
  employees: sourceData('employees', listEmployees().pipe(Effect.map((items) => items.map(toEmployee)))),
  invoices: sourceData(
    'invoices',
    requestId('invoices').pipe(
      Effect.flatMap((id) => listInvoices({}, id)),
      Effect.map((items) => items.map(toInvoice)),
    ),
  ),
  movements: sourceData(
    'movements',
    requestId('movements').pipe(
      Effect.flatMap((id) => listMovements(id)),
      Effect.map((items) => items.map(toMovement)),
    ),
  ),
  opportunities: sourceData(
    'opportunities',
    requestId('opportunities').pipe(
      Effect.flatMap((id) => listOpportunities({}, id)),
      Effect.map((response) => response.items.map(toOpportunity)),
    ),
  ),
  orders: sourceData(
    'orders',
    requestId('orders').pipe(
      Effect.flatMap((id) => listOrders(id)),
      Effect.map((items) => items.map(toOrder)),
    ),
  ),
  products: sourceData(
    'products',
    requestId('products').pipe(
      Effect.flatMap((id) => listProducts(id)),
      Effect.map((items) => items.map(toProduct)),
    ),
  ),
  tags: sourceData(
    'tags',
    listTags.pipe(Effect.map((items) => items.map((item): NamedInput => ({ id: item.id, name: item.name })))),
  ),
  tasks: sourceData('tasks', listTasks({}).pipe(Effect.map((response) => response.items.map(toTask)))),
} satisfies { readonly [K in StatisticsSource]: SourceData<K> };

/** A source not read yet, or read without a value, contributes no rows. */
const valuesOf = <A>(snapshot: PageDataSnapshot<readonly A[], SourceProblem>): readonly A[] =>
  snapshot.state === 'ready' ? snapshot.value : [];

const idsOf = <T extends { readonly id: string }>(
  data: PageData<StatisticsPageInput, readonly T[], SourceProblem>,
  input: StatisticsPageInput,
): readonly string[] => valuesOf(data.snapshot(input)).map((item) => item.id);

/** One tagging read covers all five subject kinds, so it waits until every subject entity has settled. */
const tagAssignmentsData = definePageData({
  key: inputKey,
  load: (input: StatisticsPageInput): Effect.Effect<readonly TagAssignmentInput[], SourceProblem> =>
    Effect.forEach(subjectSourceKeys, (key) => entityData[key].preload(input), {
      concurrency: SOURCE_READ_CONCURRENCY,
      discard: true,
    }).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const idsByKind = {
            customer: idsOf(entityData.customers, input),
            employee: idsOf(entityData.employees, input),
            opportunity: idsOf(entityData.opportunities, input),
            order: idsOf(entityData.orders, input),
            product: idsOf(entityData.products, input),
          } satisfies Record<(typeof subjectKinds)[number], readonly string[]>;
          return sourceRead(
            'tags',
            assignmentsForSubjects(subjectKinds.flatMap((kind) => idsByKind[kind].map((id) => ({ id, kind })))).pipe(
              Effect.map((items) =>
                items.map((item): TagAssignmentInput => ({
                  subject: { id: item.subject.id, kind: item.subject.kind },
                  tagId: item.tagId,
                })),
              ),
            ),
          );
        }),
      ),
    ),
  runtime: browserRuntime,
});

const statisticsData = { ...entityData, tagAssignments: tagAssignmentsData } satisfies {
  readonly [K in SourceKey]: SourceData<K>;
};

const sourceKeys: readonly SourceKey[] = [
  'customers',
  'employees',
  'invoices',
  'movements',
  'opportunities',
  'orders',
  'products',
  'tagAssignments',
  'tags',
  'tasks',
];

/** The sources a view reads. Tag assignments travel with the tag names. */
const requestedKeysOf = (sources: readonly StatisticsSource[]): readonly SourceKey[] =>
  sources.includes('tags') ? [...sources, 'tagAssignments'] : sources;

const uniqueSources = (sources: readonly StatisticsSource[]): readonly StatisticsSource[] => [...new Set(sources)];

const inputsOf = (input: StatisticsPageInput): MetricInputs =>
  ({
    customers: valuesOf(statisticsData.customers.snapshot(input)),
    employees: valuesOf(statisticsData.employees.snapshot(input)),
    invoices: valuesOf(statisticsData.invoices.snapshot(input)),
    movements: valuesOf(statisticsData.movements.snapshot(input)),
    opportunities: valuesOf(statisticsData.opportunities.snapshot(input)),
    orders: valuesOf(statisticsData.orders.snapshot(input)),
    products: valuesOf(statisticsData.products.snapshot(input)),
    tagAssignments: valuesOf(statisticsData.tagAssignments.snapshot(input)),
    tags: valuesOf(statisticsData.tags.snapshot(input)),
    tasks: valuesOf(statisticsData.tasks.snapshot(input)),
  }) satisfies MetricInputs;

const loadingData: StatisticsData = { status: 'loading' };

/** The ready state once every requested source settled: a source that failed or was refused raises its flag. */
const statisticsDataOf = (requested: readonly SourceKey[], input: StatisticsPageInput): StatisticsData => {
  const snapshots = requested.map((key) => statisticsData[key].snapshot(input));
  if (snapshots.some((snapshot) => snapshot.state === 'pending')) {
    return loadingData;
  }
  const failed: StatisticsSource[] = [];
  const forbidden: StatisticsSource[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.state === 'failed') {
      (snapshot.error.reason === 'failed' ? failed : forbidden).push(snapshot.error.source);
    }
  }
  return {
    failed: uniqueSources(failed),
    forbidden: uniqueSources(forbidden),
    inputs: inputsOf(input),
    status: 'ready',
  };
};

/**
 * Prepares the sources a view reads; the Shell runs it (through the page's `preloadPage`) before it reveals the
 * page, so KPIs, chart and pipeline summary render computed values in the first commit. Never fails.
 */
export const preloadStatisticsInputs = (
  sources: readonly StatisticsSource[],
  input: StatisticsPageInput,
): Effect.Effect<void> =>
  Effect.forEach(requestedKeysOf(sources), (key) => statisticsData[key].preload(input), {
    concurrency: SOURCE_READ_CONCURRENCY,
    discard: true,
  });

const subscribeAll = (listener: () => void): (() => void) => {
  const unsubscribes = sourceKeys.map((key) => statisticsData[key].subscribe(listener));
  return () => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  };
};

/** Requested keys travel through effect dependencies as one stable string, so a re-render starts no read. */
const keysOfId = (id: string): readonly SourceKey[] => {
  const ids = new Set(id.split(','));
  return sourceKeys.filter((key) => ids.has(key));
};

interface Memo {
  readonly data: StatisticsData;
  readonly id: string;
  readonly snapshots: readonly PageDataSnapshot<unknown, SourceProblem>[];
}

/**
 * The producers the view needs, from the page datasets: a source already read stays in its dataset, so switching
 * metric or grouping reads only what is new. A page the Shell prepared is ready in its first render.
 */
export const useStatisticsInputs = (
  sources: readonly StatisticsSource[],
  input: StatisticsPageInput,
): StatisticsData => {
  const requested = requestedKeysOf(sources);
  const requestedId = requested.join(',');
  const { legalEntityId } = input;
  const memo = useRef<Memo>({ data: loadingData, id: '', snapshots: [] });
  const getSnapshot = (): StatisticsData => {
    const id = `${legalEntityId}\n${requestedId}`;
    const snapshots = sourceKeys.map((key) => statisticsData[key].snapshot({ legalEntityId }));
    const previous = memo.current;
    if (
      previous.id === id &&
      previous.snapshots.length === snapshots.length &&
      previous.snapshots.every((snapshot, index) => snapshot === snapshots[index])
    ) {
      return previous.data;
    }
    const data = statisticsDataOf(keysOfId(requestedId), { legalEntityId });
    memo.current = { data, id, snapshots };
    return data;
  };
  const data = useSyncExternalStore(subscribeAll, getSnapshot, () => loadingData);
  // A cold mount the Shell did not prepare, a new view or a stale source loads here.
  useEffect(() => {
    for (const key of keysOfId(requestedId)) {
      statisticsData[key].ensure({ legalEntityId });
    }
  }, [legalEntityId, requestedId]);
  return data;
};
