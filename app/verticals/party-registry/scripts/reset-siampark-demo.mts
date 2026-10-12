import { NodeServices } from '@effect/platform-node';
import { Config, Console, DateTime, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { DatabaseConfig, parseDatabaseConfig } from '@app/core-runtime';

import { PartyDatabase, PartyDatabaseLive } from '../src/db/client.ts';
import {
  parties,
  counterparties,
  counterpartyRolePeriods,
  counterpartyAdminReadModels,
  counterpartyRoleAdminReadModels,
} from '../src/db/schema.ts';

const Uuid = Schema.String.check(Schema.isUUID());
const PartyIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoPartyId')));
const InvocationIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoInvocationId')));
const PrincipalIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoPrincipalId')));
const FixtureSchema = Schema.Struct({
  counterparties: Schema.Array(
    Schema.Struct({ id: Uuid, partyId: PartyIdSchema, role: Schema.Literals(['CUSTOMER', 'SUPPLIER']) }),
  ),
  invocationId: InvocationIdSchema,
  legalEntityId: Schema.Literal('71000000-0000-4000-8000-000000000020'),
  parties: Schema.Array(
    Schema.Struct({ id: Uuid, name: Schema.NonEmptyString, type: Schema.Literals(['PERSON', 'ORGANIZATION']) }),
  ),
  principalId: PrincipalIdSchema,
  tenantId: Schema.Literal('70000000-0000-4000-8000-000000000020'),
});
class DemoFixtureError extends Schema.TaggedError<DemoFixtureError>()('DemoFixtureError', { reason: Schema.String }) {}
const main = (fixturePath: string) =>
  Effect.gen(function* resetCanonicalDemoParties() {
    yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const fs = yield* FileSystem.FileSystem;
    const input = yield* fs
      .readFileString(fixturePath)
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(FixtureSchema))));
    if (input.counterparties.some((row) => !input.parties.some((party) => party.id === row.partyId))) {
      return yield* new DemoFixtureError({ reason: 'Every Counterparty must have its canonical fixture Party' });
    }
    const { executor } = yield* PartyDatabase;
    const now = yield* DateTime.nowAsDate;
    const validFrom = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'));
    yield* executor.transaction((transaction) =>
      Effect.gen(function* restoreCanonicalParties() {
        for (const row of input.parties) {
          yield* transaction
            .insert(parties)
            .values({ currentDisplayName: row.name, currentType: row.type, partyId: row.id, tenantId: input.tenantId })
            .onConflictDoUpdate({
              set: { archivedAt: null, currentDisplayName: row.name, currentType: row.type, updatedAt: now },
              target: parties.partyId,
            });
        }
        const provenance = {
          acceptedByActionInvocationId: input.invocationId,
          acceptedByPrincipalId: input.principalId,
          policyVersion: 'siampark-demo-v1',
          provenanceMethod: 'DEVELOPMENT_SEED',
          provenanceSource: 'SIAMPARK_SYNTHETIC_FIXTURE',
        };
        for (const row of input.counterparties) {
          const evidence = [`fixture:${row.id}`];
          yield* transaction
            .insert(counterparties)
            .values({
              counterpartyId: row.id,
              creationReason: 'Deterministic synthetic demo identity',
              evidenceRefs: evidence,
              legalEntityId: input.legalEntityId,
              partyId: row.partyId,
              sourceRecordRefs: [],
              tenantId: input.tenantId,
              ...provenance,
            })
            .onConflictDoUpdate({ set: { archivedAt: null, updatedAt: now }, target: counterparties.counterpartyId });
          const rolePeriodId = row.id.replace(/^76000000/u, '77000000');
          const role = {
            addEvidenceRefs: evidence,
            addReason: 'Synthetic demo role',
            counterpartyId: row.id,
            isCurrent: true,
            legalEntityId: input.legalEntityId,
            rolePeriodId,
            roleType: row.role,
            state: 'ACTIVE',
            tenantId: input.tenantId,
            validFrom,
            ...provenance,
          };
          yield* transaction.insert(counterpartyRolePeriods).values(role).onConflictDoNothing();
          yield* transaction
            .insert(counterpartyAdminReadModels)
            .values({
              counterpartyId: row.id,
              createdAt: now,
              legalEntityId: input.legalEntityId,
              storedPartyId: row.partyId,
              tenantId: input.tenantId,
            })
            .onConflictDoNothing();
          yield* transaction
            .insert(counterpartyRoleAdminReadModels)
            .values({
              addEvidenceRefs: evidence,
              addReason: role.addReason,
              counterpartyId: row.id,
              provenanceMethod: provenance.provenanceMethod,
              provenanceSource: provenance.provenanceSource,
              recordedAt: now,
              rolePeriodId,
              roleType: row.role,
              state: 'ACTIVE',
              tenantId: input.tenantId,
              validFrom,
            })
            .onConflictDoNothing();
        }
      }),
    );
    return yield* Console.log('Six canonical synthetic Parties and five Counterparties initialized');
  });
const AdminDatabaseConfigLive = Layer.effect(
  DatabaseConfig,
  Effect.gen(function* adminDatabaseConfiguration() {
    yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const connection = yield* Config.Redacted('DATABASE_ADMIN_URL');
    const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(connection) });
    if (!['localhost', '127.0.0.1', '[::1]'].includes(configuration.host)) {
      return yield* new DemoFixtureError({ reason: 'Synthetic identities require local PostgreSQL' });
    }
    return configuration;
  }),
);
const command = Command.make('demo-fixture', { fixture: Flag.String('fixture') }, ({ fixture }) =>
  Layer.build(
    Layer.effectDiscard(main(fixture)).pipe(
      Layer.provide(PartyDatabaseLive.pipe(Layer.provide(AdminDatabaseConfigLive))),
    ),
  ).pipe(
    Effect.scoped,
    Effect.asVoid,
    Effect.tapError((failure) => Console.error(`Fixture port failed: ${failure._tag}`)),
  ),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(NodeServices.layer),
);
await Effect.runPromise(Effect.scoped(Layer.build(runtimeLive)));
