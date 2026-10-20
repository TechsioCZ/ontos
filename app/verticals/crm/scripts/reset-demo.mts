// Sales-demo owner seed for demo.crm.
// Contract: app/scripts/demo/reset-demo.mts spawns this script with `--sales-demo`, DATABASE_ADMIN_URL
// and DEMO_RESET_PROFILE=sales in the environment, in a fixed owner order. IDs come from demoId() in
// app/scripts/demo/fixture-ids.mts; this script writes only the crm state row of the demo tenant.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { demoId, demoTenantId } from '../../../scripts/demo/fixture-ids.mts';
import { CrmStateSchema } from '../shared/apis/records.ts';
import { crmRelations, crmStates } from '../src/database/schema.ts';
import { seedClients } from './seed/clients.mts';
import { seedVisits } from './seed/visits.mts';
import { seedImports } from '../shared/imports/demo-seed.ts';

class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}

/** CRM demo company "Velkoobchod Hanák s.r.o." (fixed identity, see BRIEF). */
export const crmLegalEntityId = '71000000-0000-4000-8000-000000000022';
const seedPrincipal = demoId('core.principal', 'hanak-spravce');

/** Salespeople; principal ids match the companies lane personas (scripts/demo/permissions.mts). */
const SALESPEOPLE = [
  {
    active: true,
    email: 'obchodnik.a@hanak.demo',
    id: demoId('crm.salesperson', 'a'),
    name: 'Jan Novák',
    phone: '+420 602 111 222',
    principalId: demoId('core.principal', 'hanak-obchodnik-a'),
  },
  {
    active: true,
    email: 'obchodnik.b@hanak.demo',
    id: demoId('crm.salesperson', 'b'),
    name: 'Petra Svobodová',
    phone: '+420 603 333 444',
    principalId: demoId('core.principal', 'hanak-obchodnik-b'),
  },
] as const;
const [repA, repB] = SALESPEOPLE;

/** Encoded CRM state, anchored at the reset time so repeated resets stay deterministic in ids. */
const seedState = (now: DateTime.Utc) => {
  // crm-clients: Moravian B2B clients with contacts, assignment history and change log (scripts/seed/clients.mts).
  const clients = seedClients({
    adminPrincipalId: seedPrincipal,
    leadPrincipalId: demoId('core.principal', 'hanak-vedouci'),
    now,
    repA,
    repB,
  });
  const visits = seedVisits({
    leadPrincipalId: demoId('core.principal', 'hanak-vedouci'),
    now,
    repA,
    repB,
  });
  return {
    clients,
    imports: { batches: [], customerLinks: [], orders: [], pairingHistory: [] },
    salespeople: SALESPEOPLE,
    visits,
  };
};

const writeState = Effect.fn('Crm.writeDemoState')(function* writeDemoState() {
  const now = yield* DateTime.now;
  const decoded = yield* Schema.decodeUnknownEffect(CrmStateSchema)(seedState(now));
  // crm-imports: approved customer links + one completed CSV import (demo-data/01-uvodni-import-objednavek.csv).
  const state = yield* seedImports(decoded, {
    by: demoId('core.principal', 'hanak-vedouci'),
    clientIdOf: (key) => demoId('crm.client', key),
    importedAt: DateTime.formatIso(DateTime.subtract(now, { days: 1, hours: 3 })),
    invocationId: demoId('crm.import', 'initial'),
    linkedAt: DateTime.formatIso(DateTime.subtract(now, { days: 170 })),
  });
  const encoded = yield* Schema.encodeEffect(CrmStateSchema)(state);
  const db = yield* makeWithDefaults({ relations: crmRelations });
  yield* db
    .insert(crmStates)
    .values({
      legalEntityId: crmLegalEntityId,
      revision: 1,
      state: encoded,
      tenantId: demoTenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoUpdate({
      set: { revision: 1, state: encoded, updatedAt: DateTime.toDateUtc(now) },
      target: [crmStates.tenantId, crmStates.legalEntityId],
    });
  return yield* Console.log(
    `CRM demo state reset: ${encoded.salespeople.length} salespeople, ${encoded.clients.items.length} clients, ${encoded.clients.contacts.length} contacts, ${encoded.visits.items.length} visits, ${encoded.imports.orders.length} imported orders`,
  );
});

const resetPgLive = PgClient.layerFrom(
  Effect.gen(function* resetPool() {
    const connection = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'DATABASE_ADMIN_URL',
    );
    return yield* PgClient.makeClient({ url: connection });
  }),
);

const resetDemo = Effect.fn('Crm.resetDemo')(function* resetDemo(options: {
  readonly salesDemo: boolean;
  readonly validateOnly: boolean;
}) {
  if (!options.salesDemo) {
    return yield* new ResetInputError({ reason: '--sales-demo is required' });
  }
  // Validate-only is a no-op: nothing is written.
  if (options.validateOnly) {
    return yield* Console.log('crm: sales-demo seed validated; no data changed');
  }
  return yield* writeState();
});

const cli = Command.make(
  'reset-crm-demo',
  {
    salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  resetDemo,
);

const mainLive = Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(
  Layer.provide(resetPgLive),
  Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
NodeRuntime.runMain(Effect.scoped(Layer.build(mainLive)));
