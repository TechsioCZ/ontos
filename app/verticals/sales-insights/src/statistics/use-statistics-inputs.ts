import { listCustomers } from '@app/party-registry/api/client';
import { listMovements, listOrders, listProducts } from '@app/merchandise/clients/records';
import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { listInvoices } from '@app/siampark-billing-finance/clients/records';
import { listTasks } from '@app/siampark-work/clients/records';
import { assignmentsForSubjects, listTags } from '@app/tagging/clients/records';
import { listEmployees } from '@app/workforce/clients/records';
import { Effect, Option, Random, Ref, Schema } from 'effect';
import { useEffect, useRef, useState } from 'react';
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

/** Tag assignments are a second read: they wait for the subject ids, so they are keyed apart from the tag names. */
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

type Loaded = { readonly [K in SourceKey]?: Sourced<SourceValues[K]> | undefined };

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
/** The entity reads whose ids address the tag assignments: one per subject kind. */
const subjectSourceKeys = ['customers', 'employees', 'opportunities', 'orders', 'products'] as const;

/** A read the view does not need yields `none`, so it is never issued. */
const whenMissing = <A, R>(
  missing: ReadonlySet<SourceKey>,
  key: SourceKey,
  read: Effect.Effect<A, never, R>,
): Effect.Effect<Option.Option<A>, never, R> =>
  missing.has(key) ? read.pipe(Effect.asSome) : Effect.succeed(Option.none<A>());

/** Result of one `readEntities` pass: the sources read in it, `undefined` for the ones it skipped. */
interface FreshReads {
  readonly customers: Option.Option<Sourced<readonly NamedInput[]>>;
  readonly employees: Option.Option<Sourced<readonly EmployeeInput[]>>;
  readonly invoices: Option.Option<Sourced<readonly InvoiceInput[]>>;
  readonly movements: Option.Option<Sourced<readonly MovementInput[]>>;
  readonly opportunities: Option.Option<Sourced<readonly OpportunityInput[]>>;
  readonly orders: Option.Option<Sourced<readonly OrderInput[]>>;
  readonly products: Option.Option<Sourced<readonly ProductInput[]>>;
  readonly tags: Option.Option<Sourced<readonly NamedInput[]>>;
  readonly tasks: Option.Option<Sourced<readonly TaskInput[]>>;
}

type MutableLoaded = { -readonly [K in SourceKey]?: Sourced<SourceValues[K]> | undefined };

/** A skipped source stays absent, so merging a pass never erases what the cache already holds. */
const takeRead = <K extends SourceKey>(
  target: MutableLoaded,
  key: K,
  read: Option.Option<Sourced<SourceValues[K]>>,
): void => {
  if (Option.isSome(read)) {
    Object.assign(target, { [key]: read.value });
  }
};

const loadedFrom = (fresh: FreshReads): Loaded => {
  const loaded: MutableLoaded = {};
  takeRead(loaded, 'customers', fresh.customers);
  takeRead(loaded, 'employees', fresh.employees);
  takeRead(loaded, 'invoices', fresh.invoices);
  takeRead(loaded, 'movements', fresh.movements);
  takeRead(loaded, 'opportunities', fresh.opportunities);
  takeRead(loaded, 'orders', fresh.orders);
  takeRead(loaded, 'products', fresh.products);
  takeRead(loaded, 'tags', fresh.tags);
  takeRead(loaded, 'tasks', fresh.tasks);
  return loaded;
};

/** Reads the entity and tag-name sources that are missing. Each read is independent; a failed read is a warning. */
const readEntities = (missing: ReadonlySet<SourceKey>): Effect.Effect<Loaded> =>
  Effect.all(
    {
      customers: whenMissing(
        missing,
        'customers',
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
      ),
      employees: whenMissing(
        missing,
        'employees',
        sourced<readonly EmployeeInput[]>(
          'employees',
          [],
        )(listEmployees().pipe(Effect.map((items) => items.map(toEmployee)))),
      ),
      invoices: whenMissing(
        missing,
        'invoices',
        sourced<readonly InvoiceInput[]>(
          'invoices',
          [],
        )(
          requestId('invoices').pipe(
            Effect.flatMap((id) => listInvoices({}, id)),
            Effect.map((items) => items.map(toInvoice)),
          ),
        ),
      ),
      movements: whenMissing(
        missing,
        'movements',
        sourced<readonly MovementInput[]>(
          'movements',
          [],
        )(
          requestId('movements').pipe(
            Effect.flatMap((id) => listMovements(id)),
            Effect.map((items) => items.map(toMovement)),
          ),
        ),
      ),
      opportunities: whenMissing(
        missing,
        'opportunities',
        sourced<readonly OpportunityInput[]>(
          'opportunities',
          [],
        )(
          requestId('opportunities').pipe(
            Effect.flatMap((id) => listOpportunities({}, id)),
            Effect.map((response) => response.items.map(toOpportunity)),
          ),
        ),
      ),
      orders: whenMissing(
        missing,
        'orders',
        sourced<readonly OrderInput[]>(
          'orders',
          [],
        )(
          requestId('orders').pipe(
            Effect.flatMap((id) => listOrders(id)),
            Effect.map((items) => items.map(toOrder)),
          ),
        ),
      ),
      products: whenMissing(
        missing,
        'products',
        sourced<readonly ProductInput[]>(
          'products',
          [],
        )(
          requestId('products').pipe(
            Effect.flatMap((id) => listProducts(id)),
            Effect.map((items) => items.map(toProduct)),
          ),
        ),
      ),
      tags: whenMissing(
        missing,
        'tags',
        sourced<readonly NamedInput[]>(
          'tags',
          [],
        )(listTags.pipe(Effect.map((items) => items.map((item): NamedInput => ({ id: item.id, name: item.name }))))),
      ),
      tasks: whenMissing(
        missing,
        'tasks',
        sourced<readonly TaskInput[]>(
          'tasks',
          [],
        )(listTasks({}).pipe(Effect.map((response) => response.items.map(toTask)))),
      ),
    },
    { concurrency: 6 },
  ).pipe(Effect.map(loadedFrom));

const idsOf = <T extends { readonly id: string }>(source: Sourced<readonly T[]> | undefined): readonly string[] =>
  (source?.value ?? []).map((item) => item.id);

/** One tagging read covers all five subject kinds; it needs the subject entities already loaded. */
const readTagAssignments = (loaded: Loaded) => {
  const idsByKind = {
    customer: idsOf(loaded.customers),
    employee: idsOf(loaded.employees),
    opportunity: idsOf(loaded.opportunities),
    order: idsOf(loaded.orders),
    product: idsOf(loaded.products),
  } satisfies Record<(typeof subjectKinds)[number], readonly string[]>;
  return sourced<readonly TagAssignmentInput[]>(
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
};

/** Reads the missing sources; tag assignments follow the entity reads they depend on. */
const loadMissing = (missing: ReadonlySet<SourceKey>, loaded: Loaded): Effect.Effect<Loaded> =>
  readEntities(missing).pipe(
    Effect.flatMap((fresh) =>
      missing.has('tagAssignments')
        ? readTagAssignments({ ...loaded, ...fresh }).pipe(
            Effect.map((tagAssignments): Loaded => ({ ...fresh, tagAssignments })),
          )
        : Effect.succeed<Loaded>(fresh),
    ),
  );

/** The sources a view reads. Tag assignments travel with the tag names. */
const requestedKeysOf = (sources: readonly StatisticsSource[]): readonly SourceKey[] =>
  sources.includes('tags') ? [...sources, 'tagAssignments'] : sources;

const uniqueSources = (sources: readonly StatisticsSource[]): readonly StatisticsSource[] => [...new Set(sources)];

const noSources: readonly StatisticsSource[] = [];

/**
 * The requested keys that must be read now: not cached, not in flight. Tag assignments wait until every subject
 * entity is cached or being read in this pass, so they never address an empty subject list.
 */
const keysToRead = (
  requested: readonly SourceKey[],
  cache: Loaded,
  pending: ReadonlySet<SourceKey>,
): ReadonlySet<SourceKey> => {
  const isMissing = (key: SourceKey) => cache[key] === undefined && !pending.has(key);
  const missing = new Set<SourceKey>(requested.filter(isMissing));
  const subjectsSettled = subjectSourceKeys.every((key) => cache[key] !== undefined || missing.has(key));
  if (requested.includes('tagAssignments') && isMissing('tagAssignments') && subjectsSettled) {
    missing.add('tagAssignments');
  }
  return missing;
};

/** A source not read yet, or read without a value, contributes no rows. */
const valuesOf = <A>(entry: Sourced<readonly A[]> | undefined): readonly A[] => entry?.value ?? [];

const inputsOf = (loaded: Loaded): MetricInputs =>
  ({
    customers: valuesOf(loaded.customers),
    employees: valuesOf(loaded.employees),
    invoices: valuesOf(loaded.invoices),
    movements: valuesOf(loaded.movements),
    opportunities: valuesOf(loaded.opportunities),
    orders: valuesOf(loaded.orders),
    products: valuesOf(loaded.products),
    tagAssignments: valuesOf(loaded.tagAssignments),
    tags: valuesOf(loaded.tags),
    tasks: valuesOf(loaded.tasks),
  }) satisfies MetricInputs;

/** The ready state over the requested keys: a source that failed or was refused raises its flag. */
const readyDataOf = (requested: readonly SourceKey[], loaded: Loaded): StatisticsData => {
  const outcomes = requested.flatMap((key) => {
    const entry = loaded[key];
    return entry === undefined ? [] : [entry];
  });
  return {
    failed: uniqueSources(outcomes.flatMap((entry) => (entry.failed === undefined ? noSources : [entry.failed]))),
    forbidden: uniqueSources(
      outcomes.flatMap((entry) => (entry.forbidden === undefined ? noSources : [entry.forbidden])),
    ),
    inputs: inputsOf(loaded),
    status: 'ready',
  };
};

/** Read state of one page visit, kept outside React so a finished read can start the next one. */
interface ReadState {
  cache: Loaded;
  pending: Set<SourceKey>;
  wanted: readonly SourceKey[];
}

/** Starts the reads the view wants that are neither cached nor in flight, then starts any it had to defer. */
const startMissingReads = (state: ReadState, publish: (loaded: Loaded) => void): void => {
  const missing = keysToRead(state.wanted, state.cache, state.pending);
  if (missing.size === 0) {
    return;
  }
  for (const key of missing) {
    state.pending.add(key);
  }
  const program = loadMissing(missing, state.cache).pipe(
    Effect.tap((patch) =>
      Effect.sync(() => {
        state.cache = { ...state.cache, ...patch };
        publish(state.cache);
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        for (const key of missing) {
          state.pending.delete(key);
        }
      }),
    ),
  );
  // A finished read can unblock a deferred one (tag assignments), so the wanted keys are checked again.
  void browserRuntime.runPromise(program.pipe(Effect.tap(() => Effect.sync(() => startMissingReads(state, publish)))));
};

/**
 * Reads the producers the view needs, once per page visit: a source already read stays in the cache, so switching
 * metric or grouping reads only what is new. Stays `loading` during SSR and the first client render.
 */
export const useStatisticsInputs = (sources: readonly StatisticsSource[]): StatisticsData => {
  const [loaded, setLoaded] = useState<Loaded>({});
  const reads = useRef<ReadState>({ cache: {}, pending: new Set(), wanted: [] });
  useEffect(() => {
    reads.current.wanted = requestedKeysOf(sources);
    startMissingReads(reads.current, setLoaded);
  }, [sources]);

  const requested = requestedKeysOf(sources);
  return requested.every((key) => loaded[key] !== undefined) ? readyDataOf(requested, loaded) : { status: 'loading' };
};
