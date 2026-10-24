import { Command, Flag } from 'effect/unstable/cli';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, ConfigProvider, Console, DateTime, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { WorkStateSchema } from '../shared/apis/records.ts';
import type { TaskState, WorkState } from '../shared/apis/records.ts';
import { workStates, workRelations } from '../src/database/schema.ts';
import { demoId, demoLegalEntityId, demoTenantId } from '../../../scripts/demo/fixture-ids.mts';
import { opportunities as plannedOpportunities } from '../../../scripts/demo/sales-plan.mts';

const FixtureSchema = Schema.Struct({
  legalEntityId: Schema.Literal('71000000-0000-4000-8000-000000000020'),
  state: WorkStateSchema,
  tenantId: Schema.Literal('70000000-0000-4000-8000-000000000020'),
});
class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}

const writeWorkState = Effect.fn('ResetDemo.writeWorkState')(function* writeWorkState(
  legalEntityId: string,
  tenantId: string,
  workState: WorkState,
) {
  const state = yield* Schema.encodeEffect(WorkStateSchema)(workState);
  const db = yield* makeWithDefaults({ relations: workRelations });
  const now = yield* DateTime.now;
  yield* db
    .insert(workStates)
    .values({
      legalEntityId,
      revision: 0,
      state,
      tenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoUpdate({
      set: { revision: 0, state, updatedAt: DateTime.toDateUtc(now) },
      target: [workStates.tenantId, workStates.legalEntityId],
    });
});

const reset = Effect.fn('ResetDemo.reset')(function* resetDemo(fixturePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const data = yield* fs.readFileString(fixturePath);
  const input = yield* Schema.decodeEffect(Schema.fromJsonString(FixtureSchema))(data);
  if (
    input.state.collection.ref.tenantId !== input.tenantId ||
    input.state.tasks.some(
      (task) =>
        task.ref.tenantId !== input.tenantId ||
        task.collectionRef.resourceId !== input.state.collection.ref.resourceId ||
        task.collectionRef.tenantId !== input.tenantId ||
        task.contextRefs.some((ref) => ref.tenantId !== input.tenantId) ||
        (task.ownerPrincipalRef !== undefined && task.ownerPrincipalRef.tenantId !== input.tenantId),
    )
  ) {
    return yield* new ResetInputError({ reason: 'Fixture references must match the fixed demo tenant and collection' });
  }
  yield* writeWorkState(input.legalEntityId, input.tenantId, input.state);
  return yield* Console.log('Siampark work demo state reset to revision 0');
});

// --- Sales demo (`--sales-demo`, called by app/scripts/demo/reset-demo.mts) -----------------------------------
// Deterministic: the same 80 tasks on every run, so a re-run replaces the row at revision 0.

const salesDemoModuleId = 'work.tasks';
const salesDemoCollectionType = 'work.tasks.task-collection';
const salesDemoTaskType = 'work.tasks.task';
const salesDemoTaskCount = 80;
// Due dates spread -20..+30 days around this anchor. The UI marks overdue against the real current date.
const salesDemoAnchor = DateTime.makeUnsafe('2026-10-13T12:00:00.000Z');
const salesDemoAnchorDate = DateTime.formatIsoDateUtc(salesDemoAnchor);
// Owner principal: the Siampark management demo account, the same principal the Siampark seed uses.
const salesDemoOwnerPrincipalRef = {
  principalId: '72000000-0000-4000-8000-000000000021',
  tenantId: demoTenantId,
};
const salesDemoCollectionRef = {
  moduleId: salesDemoModuleId,
  resourceId: demoId(salesDemoCollectionType, 'sales-demo'),
  resourceType: salesDemoCollectionType,
  tenantId: demoTenantId,
};
const salesDemoPriorities = ['NORMAL', 'HIGH', 'NORMAL', 'LOW', 'HIGH', 'NORMAL'] as const;
const salesDemoTitles = {
  accountant: [
    'Ověřit platbu faktury',
    'Vystavit fakturu za objednávku',
    'Odeslat zálohovou fakturu',
    'Spárovat platbu s fakturou',
    'Upomenout splatnou fakturu',
    'Doplnit IČO a DIČ na fakturu',
    'Zkontrolovat splatnost pohledávek',
    'Připravit podklady pro účetní uzávěrku',
    'Vystavit dobropis k reklamaci',
  ],
  sales: [
    'Zavolat zákazníkovi ohledně nabídky',
    'Připravit cenovou nabídku',
    'Schůzka – prezentace řešení',
    'Poslat smlouvu k podpisu',
    'Navázání kontaktu po veletrhu',
    'Zaslat vzorek produktu',
    'Naplánovat demo pro vedení zákazníka',
    'Vyhodnotit konkurenční nabídku',
    'Aktualizovat kontaktní údaje zákazníka',
    'Zavolat po odeslání nabídky',
    'Sjednat termín dodání',
    'Zpracovat slevový požadavek',
    'Připravit podklady pro jednání',
    'Ověřit rozpočet zákazníka',
    'Obnovit smlouvu o spolupráci',
    'Domluvit zkušební provoz',
    'Zaslat referenční případy',
    'Schůzka s technickým týmem zákazníka',
  ],
  warehouse: [
    'Naskladnit zboží',
    'Inventura skladu',
    'Ověřit dostupnost zboží',
    'Objednat doplnění zásob',
    'Předat objednávku k expedici',
    'Zkontrolovat poškozené zásilky',
    'Přepočítat minimální stav zásob',
    'Vyřídit reklamaci zboží',
  ],
} as const;
const repeatState = (state: TaskState, count: number): TaskState[] => Array.from({ length: count }, () => state);
// Exact mix from the sales-demo plan: NEW 25, IN_PROGRESS 20, WAITING 8, DONE 22, CANCELLED 5.
const salesDemoStateMix: readonly TaskState[] = [
  ...repeatState('NEW', 25),
  ...repeatState('IN_PROGRESS', 20),
  ...repeatState('WAITING', 8),
  ...repeatState('DONE', 22),
  ...repeatState('CANCELLED', 5),
];

const pad2 = (n: number) => String(n).padStart(2, '0');

const salesDemoRoleFor = (i: number): keyof typeof salesDemoTitles => {
  const slot = i % 10;
  if (slot < 5) {
    return 'sales';
  }
  return slot < 8 ? 'accountant' : 'warehouse';
};

const salesDemoHasOpportunity = (i: number) => i % 8 === 1 || i % 8 === 3 || i % 8 === 6;

// Every tenth task is unassigned; other tasks belong to the known demo principal.
const salesDemoAssigneeFields = (i: number) => (i % 10 === 9 ? {} : { ownerPrincipalRef: salesDemoOwnerPrincipalRef });
const salesDemoOpportunityKey = (i: number) => `o${pad2(((i * 3) % 30) + 1)}`;
// Every 4th task has no customer (60 with a customer). A task linked to an opportunity takes that opportunity's
// customer from the shared sales plan, so the pair stays consistent (the task form rejects a mismatched pair).
const salesDemoCustomerKey = (i: number) => {
  const opportunityKey = salesDemoHasOpportunity(i) ? salesDemoOpportunityKey(i) : undefined;
  const planned = plannedOpportunities.find((opportunity) => opportunity.key === opportunityKey);
  return planned?.customerKey ?? `c${pad2(((i * 7) % 40) + 1)}`;
};
const salesDemoPartyFields = (i: number) =>
  i % 4 === 0 ? undefined : { partyId: demoId('customer', salesDemoCustomerKey(i)) };
const salesDemoOpportunityFields = (i: number) =>
  salesDemoHasOpportunity(i) ? { opportunityId: demoId('opportunity', salesDemoOpportunityKey(i)) } : undefined;

/** Task `t01`..`t80` (index `i`, zero-based), encoded as the work-state wire shape. */
const salesDemoTask = (i: number) => {
  const titles = salesDemoTitles[salesDemoRoleFor(i)];
  const createdAt = DateTime.add(salesDemoAnchor, { days: -(1 + ((i * 17) % 60)), hours: -(i % 8) });
  const updatedAt = DateTime.add(createdAt, { hours: ((i * 3) % 5) * 6 });
  const dueDate = DateTime.add(salesDemoAnchor, { days: ((i * 13) % 51) - 20 });
  return {
    collectionRef: salesDemoCollectionRef,
    contextRefs: [],
    createdAt: DateTime.formatIso(createdAt),
    dueDate: DateTime.formatIsoDateUtc(dueDate),
    priority: salesDemoPriorities[i % salesDemoPriorities.length],
    ref: {
      moduleId: salesDemoModuleId,
      resourceId: demoId(salesDemoTaskType, `t${pad2(i + 1)}`),
      resourceType: salesDemoTaskType,
      tenantId: demoTenantId,
    },
    state: salesDemoStateMix[(i * 37) % salesDemoStateMix.length],
    title: titles[i % titles.length],
    updatedAt: DateTime.formatIso(updatedAt),
    ...salesDemoAssigneeFields(i),
    ...salesDemoPartyFields(i),
    ...salesDemoOpportunityFields(i),
  };
};

const salesDemoRawState = {
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: salesDemoCollectionRef,
    title: 'Obchodní úkoly',
  },
  tasks: Array.from({ length: salesDemoTaskCount }, (_, i) => salesDemoTask(i)),
};

const summarizeSalesDemo = (state: WorkState) => {
  const open = state.tasks.filter((task) => task.state !== 'DONE' && task.state !== 'CANCELLED');
  const overdue = open.filter((task) => task.dueDate !== undefined && task.dueDate < salesDemoAnchorDate);
  const unassigned = state.tasks.filter((task) => task.ownerPrincipalRef === undefined).length;
  const withParty = state.tasks.filter((task) => task.partyId !== undefined).length;
  const withOpportunity = state.tasks.filter((task) => task.opportunityId !== undefined).length;
  return `${state.tasks.length} tasks (open ${open.length}, overdue ${overdue.length} vs ${salesDemoAnchorDate}, unassigned ${unassigned}, with customer ${withParty}, with opportunity ${withOpportunity})`;
};

const seedSalesDemo = Effect.fn('ResetDemo.seedSalesDemo')(function* seedSalesDemo(validateOnly: boolean) {
  const state = yield* Schema.decodeUnknownEffect(WorkStateSchema)(salesDemoRawState);
  if (validateOnly) {
    return yield* Console.log(`work-tasks sales-demo validated: ${summarizeSalesDemo(state)}; no data changed.`);
  }
  yield* writeWorkState(demoLegalEntityId, demoTenantId, state);
  return yield* Console.log(`work-tasks sales-demo seeded: ${summarizeSalesDemo(state)}`);
});

// `--sales-demo` (scripts/demo/reset-demo.mts) seeds the tasks; `--validate-only` builds and checks them without writing.
// As for every owner script, DATABASE_ADMIN_URL must be configured because the database layer is built at startup.
const resetPgLive = PgClient.layerFrom(
  Effect.gen(function* resetPool() {
    const connection = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'DATABASE_ADMIN_URL',
    );
    return yield* PgClient.makeClient({ url: connection });
  }),
);
const cli = Command.make(
  'reset-siampark-demo',
  {
    fixture: Flag.String('fixture').pipe(Flag.optional),
    salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  ({ fixture, salesDemo, validateOnly }) =>
    salesDemo
      ? seedSalesDemo(validateOnly)
      : Option.match(fixture, {
          onNone: () => Effect.fail(new ResetInputError({ reason: '--fixture is required' })),
          onSome: reset,
        }),
);
const mainLive = Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(
  Layer.provide(resetPgLive),
  Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
NodeRuntime.runMain(Effect.scoped(Layer.build(mainLive)));
