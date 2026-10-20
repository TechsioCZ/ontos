// Siampark provoz seed: writes every agenda's demo state for the Siampark company (legal entity …0021).
//   pnpm demo:seed:siampark-ops            (root)   — or —   node verticals/siampark-ops/scripts/reset-demo.mts --sales-demo
// Lanes enrich ONLY their own file: verticals/siampark-ops/scripts/seed/<agenda>.mts (export `seed<Agenda>State`).
// Each agenda row is upserted to revision 0, so a reseed resets that agenda. --validate-only touches no database.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Command, Flag } from 'effect/unstable/cli';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { rentalDemoCompany } from '@app/core-runtime/demo-company-profiles';
import { agendaDefinitions, agendaIds } from '../shared/agendas.ts';
import type { AgendaId } from '../shared/domain/common.ts';
import { sql } from 'drizzle-orm';
import { agendaStates, files, siamparkOpsRelations } from '../src/database/schema.ts';
import { seedAgendaState } from './seed/agenda.mts';
import { seedAssetsState } from './seed/assets.mts';
import { seedDocumentFiles, seedDocumentsState } from './seed/documents.mts';
import { seedMetersState } from './seed/meters.mts';
import { seedPurchasingState } from './seed/purchasing.mts';
import { seedSecurityState } from './seed/security.mts';

class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}

const demoTenantId = '70000000-0000-4000-8000-000000000020';
const siamparkLegalEntityId = rentalDemoCompany.legalEntityId;

/** Encoded seed state per agenda; each comes from the lane-owned scripts/seed/<agenda>.mts. */
const seeds: Readonly<Record<AgendaId, () => unknown>> = {
  agenda: seedAgendaState,
  assets: seedAssetsState,
  documents: seedDocumentsState,
  meters: seedMetersState,
  purchasing: seedPurchasingState,
  security: seedSecurityState,
};

/** Decodes then re-encodes every seed through the agenda schema (fails fast on a bad seed). */
const buildStates = Effect.forEach(agendaIds, (agenda) =>
  Effect.gen(function* buildState() {
    const schema = agendaDefinitions[agenda].stateSchema;
    const decoded: unknown = yield* Schema.decodeUnknownEffect(schema)(seeds[agenda]());
    const encoded: unknown = yield* Schema.encodeUnknownEffect(schema)(decoded);
    return { agenda, encoded };
  }),
);

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

const writeStates = Effect.fn('SiamparkOps.writeDemoStates')(function* writeDemoStates(
  states: ReadonlyArray<{ readonly agenda: AgendaId; readonly encoded: unknown }>,
) {
  const db = yield* makeWithDefaults({ relations: siamparkOpsRelations });
  const now = DateTime.toDateUtc(yield* DateTime.now);
  // Optional SIAMPARK_OPS_SEED_ONLY=documents,meters reseeds only those agendas (lane-local reseed; default: all).
  const only = (yield* Config.String('SIAMPARK_OPS_SEED_ONLY').pipe(Config.withDefault('')))
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const selected = states.filter((entry) => only.length === 0 || only.includes(entry.agenda));
  for (const { agenda, encoded } of selected) {
    yield* db
      .insert(agendaStates)
      .values({
        agenda,
        legalEntityId: siamparkLegalEntityId,
        revision: 0,
        state: encoded,
        tenantId: demoTenantId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: { revision: 0, state: encoded, updatedAt: now },
        target: [agendaStates.tenantId, agendaStates.legalEntityId, agendaStates.agenda],
      });
  }
  // documents lane: real seed files (PDF/PNG) referenced by the documents seed state, upserted by id.
  const seedFiles = seedDocumentFiles();
  for (const file of seedFiles) {
    const values = {
      bytes: sql`decode(${file.bytes.toString('base64')}, 'base64')`,
      createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(file.createdAt)),
      createdBy: file.createdBy,
      id: file.id,
      legalEntityId: siamparkLegalEntityId,
      mime: file.mime,
      name: file.name,
      size: file.bytes.length,
      tenantId: demoTenantId,
    };
    yield* db
      .insert(files)
      .values(values)
      .onConflictDoUpdate({
        set: { bytes: values.bytes, mime: file.mime, name: file.name, size: values.size },
        target: [files.tenantId, files.legalEntityId, files.id],
      });
  }
  yield* Console.log(`siampark-ops demo state reset for ${selected.length} agendas (legal entity ${siamparkLegalEntityId})`);
});

const command = Command.make(
  'siampark-ops-reset',
  {
    salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  ({ salesDemo, validateOnly }) =>
    Effect.gen(function* resetSiamparkOpsDemo() {
      if (!salesDemo) {
        return yield* new ResetInputError({ reason: '--sales-demo is required' });
      }
      const states = yield* buildStates;
      if (validateOnly) {
        return yield* Console.log(`siampark-ops seed validated (${states.length} agendas); no data changed`);
      }
      return yield* Layer.build(Layer.effectDiscard(writeStates(states)).pipe(Layer.provide(AdminDatabaseLive))).pipe(
        Effect.scoped,
      );
    }),
);

const resetProgram = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
NodeRuntime.runMain(Layer.build(resetProgram).pipe(Effect.scoped));
