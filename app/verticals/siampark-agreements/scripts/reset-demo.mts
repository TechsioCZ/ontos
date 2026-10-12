/// <reference types="node" />
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { defineRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, ConfigProvider, Console, Effect, Exit, FileSystem, Layer, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Reactivity } from 'effect/unstable/reactivity';
import { AgreementsStateSchema } from '../shared/apis/records.ts';
import { agreementsState } from '../src/database/schema.ts';

const PayloadSchema = Schema.Struct({
  legalEntityId: Schema.Literal('71000000-0000-4000-8000-000000000020'),
  state: AgreementsStateSchema,
  tenantId: Schema.Literal('70000000-0000-4000-8000-000000000020'),
});
class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}
const cli = Command.make(
  'reset-siampark-agreements-demo',
  { fixture: Flag.String('fixture') },
  Effect.fn('siampark-agreements.resetDemo')(function* cli({ fixture }) {
    const path = yield* Path.Path;
    if (!path.isAbsolute(fixture) || !fixture.endsWith('.json')) {
      return yield* new ResetInputError({ reason: 'Use --fixture /absolute/file.json' });
    }
    const fs = yield* FileSystem.FileSystem;
    const input = yield* Schema.decodeEffect(Schema.fromJsonString(PayloadSchema))(yield* fs.readFileString(fixture));
    const refs: readonly ({ readonly tenantId: string } | null)[] = [
      ...input.state.contracts.flatMap((row) => [
        row.contractRef,
        row.counterpartyRef,
        row.occupancyRef,
        row.propertyRef,
        row.unitRef,
        row.supersedesContractRef,
      ]),
      ...input.state.documents.flatMap((row) => [row.documentRef, row.contractRef]),
      ...input.state.signatureObservations.flatMap((row) => [
        row.contractRef,
        row.documentRef,
        row.ownerResourceRef,
        row.signer.counterpartyRef,
        row.signer.partyRef,
      ]),
    ];
    if (refs.some((ref) => ref !== null && ref.tenantId !== input.tenantId)) {
      return yield* new ResetInputError({ reason: 'All fixture references must match the fixed demo tenant' });
    }
    const snapshot = yield* Schema.encodeEffect(AgreementsStateSchema)(input.state);
    const db = yield* makeWithDefaults({ relations: defineRelations({ agreementsState }) });
    yield* db
      .insert(agreementsState)
      .values({ legalEntityId: input.legalEntityId, revision: 0, snapshot, tenantId: input.tenantId })
      .onConflictDoUpdate({
        set: { revision: 0, snapshot },
        target: [agreementsState.tenantId, agreementsState.legalEntityId],
      });
    return yield* Console.log('siampark-agreements fixture reset to revision 0');
  }),
);
const resetPg = Config.schema(Schema.RedactedFromValue(Schema.NonEmptyString), 'DATABASE_ADMIN_URL').pipe(
  Effect.flatMap((url) => PgClient.makeClient({ url })),
);
const mainLive = Layer.effectDiscard(
  Command.run(cli.pipe(Command.provideEffect(PgClient.PgClient, resetPg)), { version: '1.0.0' }),
).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
const result = await Effect.runPromiseExit(
  Effect.scoped(Layer.build(mainLive)).pipe(
    Effect.tapCause((cause) =>
      Console.error(
        'Owner fixture reset failed',
        cause.reasons.map((reason) => reason._tag),
      ),
    ),
  ),
);
if (Exit.isFailure(result)) {
  process.exitCode = 1;
}
