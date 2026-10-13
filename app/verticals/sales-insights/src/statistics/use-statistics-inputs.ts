import { listCustomers } from '@app/party-registry/api/client';
import { listMovements, listOrders, listProducts } from '@app/merchandise/clients/records';
import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { listInvoices } from '@app/siampark-billing-finance/clients/records';
import { listTasks } from '@app/siampark-work/clients/records';
import { assignmentsFor, listTags } from '@app/tagging/clients/records';
import { listEmployees } from '@app/workforce/clients/records';
import { Effect, Random, Schema } from 'effect';
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
  | { readonly failed: readonly StatisticsSource[]; readonly inputs: MetricInputs; readonly status: 'ready' };

interface Sourced<A> {
  readonly cause?: unknown;
  readonly failed?: StatisticsSource;
  readonly value: A;
}

/** One failing producer read must not blank the page: it becomes an empty list plus a warning. */
const sourced =
  <A>(source: StatisticsSource, fallback: A) =>
  <E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Sourced<A>, never, R> =>
    effect.pipe(
      Effect.match({
        onFailure: (cause) => ({ cause, failed: source, value: fallback }),
        onSuccess: (value) => ({ value }),
      }),
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
  const customers = yield* sourced<readonly NamedInput[]>(
    'customers',
    [],
  )(
    listCustomers({}).pipe(
      Effect.map((items) =>
        items.map((item): NamedInput => ({ id: item.partyId, name: item.displayName ?? item.partyId })),
      ),
    ),
  );
  const [employees, invoices, movements, opportunities, orders, products, tags, tasks] = yield* Effect.all(
    [
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
    { concurrency: 4 },
  );

  const idsByKind = {
    customer: customers.value.map((customer) => customer.id),
    employee: employees.value.map((employee) => employee.id),
    opportunity: opportunities.value.map((opportunity) => opportunity.id),
    order: orders.value.map((order) => order.id),
    product: products.value.map((product) => product.id),
  } satisfies Record<(typeof subjectKinds)[number], readonly string[]>;
  const assignments = yield* Effect.all(
    subjectKinds.map((kind) =>
      sourced<readonly TagAssignmentInput[]>(
        'tags',
        [],
      )(
        assignmentsFor(kind, idsByKind[kind]).pipe(
          Effect.map((items) =>
            items.map((item): TagAssignmentInput => ({
              subject: { id: item.subject.id, kind: item.subject.kind },
              tagId: item.tagId,
            })),
          ),
        ),
      ),
    ),
    { concurrency: 5 },
  );

  const all = [customers, employees, invoices, movements, opportunities, orders, products, tags, tasks, ...assignments];
  const failed = [...new Set(all.flatMap((source) => (source.failed === undefined ? [] : [source.failed])))];
  return {
    failed,
    inputs: {
      customers: customers.value,
      employees: employees.value,
      invoices: invoices.value,
      movements: movements.value,
      opportunities: opportunities.value,
      orders: orders.value,
      products: products.value,
      tagAssignments: assignments.flatMap((source) => source.value),
      tags: tags.value,
      tasks: tasks.value,
    } satisfies MetricInputs,
  };
});

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
        onFailure: (cause) => ({ cause, failed: StatisticsSourceSchema.literals, inputs: EMPTY_INPUTS }),
        onSuccess: (result) => ({ failed: result.failed, inputs: result.inputs }),
      }),
      Effect.flatMap(({ failed, inputs }) => publish({ failed, inputs, status: 'ready' })),
    );
    void browserRuntime.runPromise(program);
    return () => {
      active = false;
    };
  }, []);
  return data;
};
