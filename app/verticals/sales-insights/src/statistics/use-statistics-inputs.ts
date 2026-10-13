import { listCustomers } from '@app/party-registry/api/client';
import { listMovements, listOrders, listProducts } from '@app/merchandise/clients/records';
import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { listInvoices } from '@app/siampark-billing-finance/clients/records';
import { listTasks } from '@app/siampark-work/clients/records';
import { assignmentsForSubjects, listTags } from '@app/tagging/clients/records';
import { listEmployees } from '@app/workforce/clients/records';
import { Effect, Random, Ref, Schema } from 'effect';
import { useEffect, useState } from 'react';
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

interface Sourced<A> {
  readonly cause?: unknown;
  readonly failed?: StatisticsSource;
  readonly forbidden?: StatisticsSource;
  readonly value: A;
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
 * One failing producer read must not blank the page: it becomes an empty list plus a warning. A 403 becomes an
 * empty list plus a permission state, and later loads skip that read.
 */
const sourced =
  <A>(source: StatisticsSource, fallback: A) =>
  <E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Sourced<A>, never, R> =>
    Ref.get(refusedSources).pipe(
      Effect.flatMap((refused) =>
        refused.has(source)
          ? Effect.succeed<Sourced<A>>({ forbidden: source, value: fallback })
          : effect.pipe(
              Effect.matchEffect({
                onFailure: (cause): Effect.Effect<Sourced<A>> =>
                  isForbiddenProblem(cause)
                    ? Ref.update(refusedSources, withSource(source)).pipe(
                        Effect.as({ cause, forbidden: source, value: fallback }),
                      )
                    : Effect.succeed({ cause, failed: source, value: fallback }),
                onSuccess: (value): Effect.Effect<Sourced<A>> => Effect.succeed({ value }),
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
  readonly expectedCloseDate: OpportunityInput['expectedCloseDate'];
  readonly id: string;
  readonly ownerEmployeeId?: string | undefined;
  readonly partyId: string;
  readonly probability: number;
  readonly stage: OpportunityInput['stage'];
}): OpportunityInput => ({
  amountMinor: item.amountMinor,
  closedAt: item.closedAt,
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

/** Reads every producer once. Each read is independent; a failed read is reported in `failed`. */
const loadStatisticsInputs = Effect.gen(function* statisticsInputs() {
  // The entity reads are independent and start together; only the tag assignments wait for the entity ids.
  const [customers, employees, invoices, movements, opportunities, orders, products, tags, tasks] = yield* Effect.all(
    [
      sourced<readonly NamedInput[]>(
        'customers',
        [],
      )(
        listCustomers({}).pipe(
          Effect.map((items) =>
            items.map((item): NamedInput => ({ id: item.partyId, name: item.displayName ?? item.partyId })),
          ),
        ),
      ),
      sourced<readonly EmployeeInput[]>(
        'employees',
        [],
      )(listEmployees().pipe(Effect.map((items) => items.map(toEmployee)))),
      sourced<readonly InvoiceInput[]>(
        'invoices',
        [],
      )(
        requestId('invoices').pipe(
          Effect.flatMap((id) => listInvoices({}, id)),
          Effect.map((items) => items.map(toInvoice)),
        ),
      ),
      sourced<readonly MovementInput[]>(
        'movements',
        [],
      )(
        requestId('movements').pipe(
          Effect.flatMap((id) => listMovements(id)),
          Effect.map((items) => items.map(toMovement)),
        ),
      ),
      sourced<readonly OpportunityInput[]>(
        'opportunities',
        [],
      )(
        requestId('opportunities').pipe(
          Effect.flatMap((id) => listOpportunities({}, id)),
          Effect.map((response) => response.items.map(toOpportunity)),
        ),
      ),
      sourced<readonly OrderInput[]>(
        'orders',
        [],
      )(
        requestId('orders').pipe(
          Effect.flatMap((id) => listOrders(id)),
          Effect.map((items) => items.map(toOrder)),
        ),
      ),
      sourced<readonly ProductInput[]>(
        'products',
        [],
      )(
        requestId('products').pipe(
          Effect.flatMap((id) => listProducts(id)),
          Effect.map((items) => items.map(toProduct)),
        ),
      ),
      sourced<readonly NamedInput[]>(
        'tags',
        [],
      )(listTags.pipe(Effect.map((items) => items.map((item): NamedInput => ({ id: item.id, name: item.name }))))),
      sourced<readonly TaskInput[]>(
        'tasks',
        [],
      )(listTasks({}).pipe(Effect.map((response) => response.items.map(toTask)))),
    ],
    { concurrency: 6 },
  );

  const idsByKind = {
    customer: customers.value.map((customer) => customer.id),
    employee: employees.value.map((employee) => employee.id),
    opportunity: opportunities.value.map((opportunity) => opportunity.id),
    order: orders.value.map((order) => order.id),
    product: products.value.map((product) => product.id),
  } satisfies Record<(typeof subjectKinds)[number], readonly string[]>;
  // One tagging read covers all five subject kinds.
  const assignments = yield* sourced<readonly TagAssignmentInput[]>(
    'tags',
    [],
  )(
    assignmentsForSubjects(subjectKinds.flatMap((kind) => idsByKind[kind].map((id) => ({ id, kind })))).pipe(
      Effect.map((items) =>
        items.map((item): TagAssignmentInput => ({
          subject: { id: item.subject.id, kind: item.subject.kind },
          tagId: item.tagId,
        })),
      ),
    ),
  );

  const all = [customers, employees, invoices, movements, opportunities, orders, products, tags, tasks, assignments];
  const failed = [...new Set(all.flatMap((source) => (source.failed === undefined ? [] : [source.failed])))];
  const forbidden = [...new Set(all.flatMap((source) => (source.forbidden === undefined ? [] : [source.forbidden])))];
  return {
    failed,
    forbidden,
    inputs: {
      customers: customers.value,
      employees: employees.value,
      invoices: invoices.value,
      movements: movements.value,
      opportunities: opportunities.value,
      orders: orders.value,
      products: products.value,
      tagAssignments: assignments.value,
      tags: tags.value,
      tasks: tasks.value,
    } satisfies MetricInputs,
  };
});

const noSources: readonly StatisticsSource[] = [];

const EMPTY_INPUTS: MetricInputs = {
  employees: [],
  invoices: [],
  movements: [],
  opportunities: [],
  orders: [],
  products: [],
  tasks: [],
};

/** Loads all producer reads once on mount. Stays `loading` during SSR and the first client render. */
export const useStatisticsInputs = (): StatisticsData => {
  const [data, setData] = useState<StatisticsData>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    const publish = (next: StatisticsData) =>
      Effect.sync(() => {
        if (active) {
          setData(next);
        }
      });
    const program = loadStatisticsInputs.pipe(
      Effect.match({
        onFailure: (cause) => ({
          cause,
          failed: StatisticsSourceSchema.literals,
          forbidden: noSources,
          inputs: EMPTY_INPUTS,
        }),
        onSuccess: (result) => ({ failed: result.failed, forbidden: result.forbidden, inputs: result.inputs }),
      }),
      Effect.flatMap(({ failed, forbidden, inputs }) => publish({ failed, forbidden, inputs, status: 'ready' })),
    );
    void browserRuntime.runPromise(program);
    return () => {
      active = false;
    };
  }, []);
  return data;
};
