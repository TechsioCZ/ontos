import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Command, Flag } from 'effect/unstable/cli';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { demoId, demoLegalEntityId, demoTenantId } from '../../../scripts/demo/fixture-ids.mts';
import { EmployeeIdSchema } from '../shared/resources/employee.ts';
import { WorkforceStateSchema } from '../shared/apis/records.ts';
import type { EmployeeRole, WorkforceState } from '../shared/apis/records.ts';
import { workforceRelations, workforceStates } from '../src/database/schema.ts';

interface DemoEmployee {
  readonly active: boolean;
  readonly department: string;
  readonly email: string;
  readonly fullName: string;
  readonly key: string;
  readonly phone: string;
  readonly role: EmployeeRole;
}

/** Fixed seed instant so repeated resets write byte-identical state. */
const SEED_INSTANT = '2026-10-13T08:00:00Z';
const B2B_DEPARTMENT = 'Obchod B2B';

/** Keys feed demoId('employee', key); never change them once seeds exist. */
const DEMO_EMPLOYEES: readonly DemoEmployee[] = [
  {
    active: true,
    department: 'Obchod',
    email: 'obchod@demo.ontos',
    fullName: 'Jana Nováková',
    key: 'obchod',
    phone: '+420 777 000 001',
    role: 'SALES_HEAD',
  },
  {
    active: true,
    department: B2B_DEPARTMENT,
    email: 'obchodnik@demo.ontos',
    fullName: 'Petr Svoboda',
    key: 'obchodnik',
    phone: '+420 777 000 002',
    role: 'SALES_REP',
  },
  {
    active: true,
    department: B2B_DEPARTMENT,
    email: 'lucie.dvorakova@demo.ontos',
    fullName: 'Lucie Dvořáková',
    key: 'lucie-dvorakova',
    phone: '+420 777 000 003',
    role: 'SALES_REP',
  },
  {
    active: true,
    department: 'Obchod Retail',
    email: 'tomas.cerny@demo.ontos',
    fullName: 'Tomáš Černý',
    key: 'tomas-cerny',
    phone: '+420 777 000 004',
    role: 'SALES_REP',
  },
  {
    active: true,
    department: 'Obchod Retail',
    email: 'katerina.prochazkova@demo.ontos',
    fullName: 'Kateřina Procházková',
    key: 'katerina-prochazkova',
    phone: '+420 777 000 005',
    role: 'SALES_REP',
  },
  {
    active: true,
    department: 'Klíčoví zákazníci',
    email: 'martin.kucera@demo.ontos',
    fullName: 'Martin Kučera',
    key: 'martin-kucera',
    phone: '+420 777 000 006',
    role: 'SALES_REP',
  },
  {
    active: true,
    department: 'Finance',
    email: 'ucetni@demo.ontos',
    fullName: 'Eva Veselá',
    key: 'ucetni',
    phone: '+420 777 000 007',
    role: 'ACCOUNTANT',
  },
  {
    active: true,
    department: 'Finance',
    email: 'jiri.horak@demo.ontos',
    fullName: 'Jiří Horák',
    key: 'jiri-horak',
    phone: '+420 777 000 008',
    role: 'ACCOUNTANT',
  },
  {
    active: true,
    department: 'Sklad',
    email: 'sklad@demo.ontos',
    fullName: 'Pavel Němec',
    key: 'sklad',
    phone: '+420 777 000 009',
    role: 'WAREHOUSE',
  },
  {
    active: true,
    department: 'Sklad',
    email: 'michal.marek@demo.ontos',
    fullName: 'Michal Marek',
    key: 'michal-marek',
    phone: '+420 777 000 010',
    role: 'WAREHOUSE',
  },
  {
    active: true,
    department: 'Zákaznická podpora',
    email: 'tereza.pokorna@demo.ontos',
    fullName: 'Tereza Pokorná',
    key: 'tereza-pokorna',
    phone: '+420 777 000 011',
    role: 'SUPPORT',
  },
  {
    active: false,
    department: B2B_DEPARTMENT,
    email: 'ondrej.pospisil@demo.ontos',
    fullName: 'Ondřej Pospíšil',
    key: 'ondrej-pospisil',
    phone: '+420 777 000 012',
    role: 'SALES_REP',
  },
];

class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}

/** Builds the Workforce state with deterministic employee IDs and no principal bindings. */
const buildDemoState = Effect.fn('Workforce.buildDemoState')(function* buildDemoState() {
  const instant = DateTime.makeUnsafe(SEED_INSTANT);
  const employees = yield* Effect.all(
    DEMO_EMPLOYEES.map((entry) =>
      Schema.decodeUnknownEffect(EmployeeIdSchema)(demoId('employee', entry.key)).pipe(
        Effect.map((id) => ({
          active: entry.active,
          createdAt: instant,
          department: entry.department,
          email: entry.email,
          fullName: entry.fullName,
          id,
          phone: entry.phone,
          role: entry.role,
          updatedAt: instant,
        })),
      ),
    ),
  );
  return { employees } satisfies WorkforceState;
});

const AdminDatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* adminClient() {
    const connection = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'DATABASE_ADMIN_URL',
    );
    return yield* PgClient.makeClient({ url: connection });
  }),
).pipe(Layer.provide(Reactivity.layer));

const writeState = Effect.fn('Workforce.writeDemoState')(function* writeDemoState(state: WorkforceState) {
  const encoded = yield* Schema.encodeEffect(WorkforceStateSchema)(state);
  const db = yield* makeWithDefaults({ relations: workforceRelations });
  const now = yield* DateTime.now;
  yield* db
    .insert(workforceStates)
    .values({
      legalEntityId: demoLegalEntityId,
      revision: 0,
      state: encoded,
      tenantId: demoTenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoUpdate({
      set: { revision: 0, state: encoded, updatedAt: DateTime.toDateUtc(now) },
      target: [workforceStates.tenantId, workforceStates.legalEntityId],
    });
  yield* Console.log(`workforce demo state reset to revision 0 (${state.employees.length} employees)`);
});

const writeDemoState = (state: WorkforceState) =>
  Layer.build(Layer.effectDiscard(writeState(state)).pipe(Layer.provide(AdminDatabaseLive))).pipe(Effect.scoped);

// `--sales-demo` is passed by scripts/demo/reset-demo.mts. `--validate-only` encodes the state (schema check)
// without touching the database.
const validateDemoState = Effect.fn('Workforce.validateDemoState')(function* validateDemoState() {
  const state = yield* buildDemoState();
  yield* Schema.encodeEffect(WorkforceStateSchema)(state);
  yield* Console.log(`workforce sales-demo state validated (${state.employees.length} employees); no data changed`);
});

const command = Command.make(
  'workforce-reset',
  {
    salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  ({ salesDemo, validateOnly }) =>
    Effect.gen(function* resetWorkforceDemo() {
      if (!salesDemo) {
        return yield* new ResetInputError({ reason: '--sales-demo is required' });
      }
      if (validateOnly) {
        return yield* validateDemoState();
      }
      return yield* buildDemoState().pipe(Effect.flatMap(writeDemoState));
    }),
);

// The admin database connects only inside the write path, so --validate-only and flag errors never touch Postgres.
const resetProgram = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
NodeRuntime.runMain(Layer.build(resetProgram).pipe(Effect.scoped));
