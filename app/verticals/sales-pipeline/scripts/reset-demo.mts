// Sales-demo owner seed for demo.sales-pipeline.
// Contract: app/scripts/demo/reset-demo.mts spawns this script with `--sales-demo`, DATABASE_ADMIN_URL
// and DEMO_RESET_PROFILE=sales in the environment, in a fixed owner order. Opportunities come from the shared
// plan in app/scripts/demo/sales-plan.mts; IDs come from demoId() in app/scripts/demo/fixture-ids.mts. This script
// writes only the sales-pipeline state row of the demo tenant (revision 0).
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Command, Flag } from 'effect/cli';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { demoId, demoLegalEntityId, demoTenantId } from '../../../scripts/demo/fixture-ids.mts';
import type { PlannedOpportunity } from '../../../scripts/demo/sales-plan.mts';
import { opportunities, productByKey, snapshotPriceMinor } from '../../../scripts/demo/sales-plan.mts';
import { SalesPipelineStateSchema } from '../shared/apis/records.ts';
import type { SalesPipelineState } from '../shared/apis/records.ts';
import {
  defaultProbabilityByStage,
  OpportunityLinesSchema,
  opportunityAmountMinor,
} from '../shared/model/opportunity.ts';
import type { OpportunitySchema, OpportunityStage } from '../shared/model/opportunity.ts';
import { salesPipelineRelations, salesPipelineStates } from '../src/database/schema.ts';

class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}

type OpportunityRecord = typeof OpportunitySchema.Encoded;

const openStagePath: readonly OpportunityStage[] = ['LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION'];

/** Stages an opportunity passed through, ending in its current stage. */
const stagePathOf = (stage: OpportunityStage): readonly OpportunityStage[] => {
  if (stage === 'WON') {
    return [...openStagePath, 'WON'];
  }
  if (stage === 'LOST') {
    return [...openStagePath.slice(0, 3), 'LOST'];
  }
  return openStagePath.slice(0, openStagePath.indexOf(stage) + 1);
};

/**
 * Encoded opportunity record (the wire shape of OpportunitySchema). Dates are days before `now`; the first
 * stage entry is the creation, the last one the close (or, for open opportunities, the current stage entry).
 */
const opportunityRecord = Effect.fn('SalesPipeline.opportunityRecord')(function* opportunityRecord(
  planned: PlannedOpportunity,
  now: DateTime.Utc,
) {
  const { closedDaysAgo, createdDaysAgo, customerKey, expectedCloseInDays, key, ownerKey, stage, title } = planned;
  const at = (daysAgo: number) => DateTime.formatIso(DateTime.subtract(now, { days: daysAgo }));
  const path = stagePathOf(stage);
  const lastStageDaysAgo = path.length === 1 ? createdDaysAgo : (closedDaysAgo ?? Math.floor(createdDaysAgo / 4));
  const stageHistory = path.map((pathStage, index) => ({
    at: at(Math.round(createdDaysAgo + ((lastStageDaysAgo - createdDaysAgo) * index) / Math.max(path.length - 1, 1))),
    stage: pathStage,
  }));
  const lines = yield* Effect.all(
    planned.lines.map((line) =>
      Effect.gen(function* plannedLine() {
        const product = yield* productByKey(line.productKey);
        return {
          productId: demoId('product', line.productKey),
          productName: product.name,
          quantity: line.quantity,
          unitPriceMinor: snapshotPriceMinor(product, closedDaysAgo ?? 0),
          vatRate: product.vatRate,
        };
      }),
    ),
  );
  const decodedLines = yield* Schema.decodeUnknownEffect(OpportunityLinesSchema)(lines);
  const expectedCloseDate =
    closedDaysAgo === null
      ? DateTime.formatIsoDateUtc(DateTime.add(now, { days: expectedCloseInDays }))
      : DateTime.formatIsoDateUtc(DateTime.subtract(now, { days: closedDaysAgo }));
  // Optional keys are omitted, not set to undefined: the state schema rejects undefined values.
  const record: OpportunityRecord = {
    amountMinor: opportunityAmountMinor(decodedLines),
    createdAt: at(createdDaysAgo),
    currency: 'CZK',
    expectedCloseDate,
    id: demoId('opportunity', key),
    lines,
    partyId: demoId('customer', customerKey),
    probability: defaultProbabilityByStage[stage],
    stage,
    stageHistory,
    title,
    updatedAt: at(lastStageDaysAgo),
  };
  if (closedDaysAgo !== null) {
    Object.assign(record, { closedAt: at(closedDaysAgo) });
  }
  if (ownerKey !== null) {
    Object.assign(record, { ownerEmployeeId: demoId('employee', ownerKey) });
  }
  return record;
});

/** Builds the sales-pipeline state from the shared plan and decodes it through the vertical's state schema. */
const buildDemoState = Effect.fn('SalesPipeline.buildDemoState')(function* buildDemoState(now: DateTime.Utc) {
  const records = yield* Effect.all(opportunities.map((planned) => opportunityRecord(planned, now)));
  return yield* Schema.decodeUnknownEffect(SalesPipelineStateSchema)({ opportunities: records });
});

const summarize = (state: SalesPipelineState) => {
  const count = (stage: OpportunityStage) => state.opportunities.filter((item) => item.stage === stage).length;
  const won = count('WON');
  const lost = count('LOST');
  return `${state.opportunities.length} opportunities (open ${state.opportunities.length - won - lost}, won ${won}, lost ${lost})`;
};

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

const writeState = Effect.fn('SalesPipeline.writeDemoState')(function* writeDemoState(state: SalesPipelineState) {
  const encoded = yield* Schema.encodeEffect(SalesPipelineStateSchema)(state);
  const db = yield* makeWithDefaults({ relations: salesPipelineRelations });
  const now = yield* DateTime.now;
  yield* db
    .insert(salesPipelineStates)
    .values({
      legalEntityId: demoLegalEntityId,
      revision: 0,
      state: encoded,
      tenantId: demoTenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoUpdate({
      set: { revision: 0, state: encoded, updatedAt: DateTime.toDateUtc(now) },
      target: [salesPipelineStates.tenantId, salesPipelineStates.legalEntityId],
    });
  yield* Console.log(`sales-pipeline demo state reset to revision 0: ${summarize(state)}`);
});

const writeDemoState = (state: SalesPipelineState) =>
  Layer.build(Layer.effectDiscard(writeState(state)).pipe(Layer.provide(AdminDatabaseLive))).pipe(Effect.scoped);

// `--validate-only` builds and encodes the state without touching the database, so DATABASE_ADMIN_URL is only
// read on the write path.
const validateDemoState = Effect.fn('SalesPipeline.validateDemoState')(function* validateDemoState(now: DateTime.Utc) {
  const state = yield* buildDemoState(now);
  yield* Schema.encodeEffect(SalesPipelineStateSchema)(state);
  yield* Console.log(`sales-pipeline sales-demo state validated: ${summarize(state)}; no data changed`);
});

const command = Command.make(
  'sales-pipeline-reset',
  {
    salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  ({ salesDemo, validateOnly }) =>
    Effect.gen(function* resetSalesPipelineDemo() {
      if (!salesDemo) {
        return yield* new ResetInputError({ reason: '--sales-demo is required' });
      }
      // One reference instant for the whole run: every relative date is computed from it.
      const now = yield* DateTime.now;
      if (validateOnly) {
        return yield* validateDemoState(now);
      }
      return yield* buildDemoState(now).pipe(Effect.flatMap(writeDemoState));
    }),
);

const resetProgram = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
NodeRuntime.runMain(Layer.build(resetProgram).pipe(Effect.scoped));
