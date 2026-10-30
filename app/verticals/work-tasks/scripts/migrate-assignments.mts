import { createHash, randomUUID } from 'node:crypto';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, ConfigProvider, Console, Effect, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { executeRecordsWithAuthorization } from '@app/workforce/clients/records';
import { WorkStateSchema } from '../shared/apis/records.ts';
import {
  AssignmentOverrideSchema,
  EmployeeAssignmentMigrationInputSchema,
  EmployeeIdSchema,
  prepareEmployeeAssignmentMigration,
} from '../src/services/migrate-employee-assignments.ts';

const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('AssignmentMigrationLegalEntityId'));
const MappingSchema = Schema.Struct({
  employees: Schema.Array(
    Schema.Struct({
      displayName: Schema.String,
      employeeId: EmployeeIdSchema,
      principalRef: Schema.OptionFromNullOr(PrincipalRefSchema),
    }),
  ),
  legalEntityId: LegalEntityIdSchema,
  reviewed: Schema.Boolean,
  tenantId: PrincipalRefSchema.fields.tenantId,
  version: Schema.Literal(1),
  workforceRevision: Schema.Int,
});
const PlanSchema = Schema.Struct({
  afterHash: Schema.String,
  assignmentOverrides: Schema.Array(AssignmentOverrideSchema),
  beforeHash: Schema.String,
  changed: Schema.Boolean,
  changedExistingOwners: Schema.Int,
  clearedExistingOwners: Schema.Int,
  legalEntityId: LegalEntityIdSchema,
  mappingHash: Schema.String,
  projectsNeedingReassignment: Schema.Int,
  revision: Schema.Int,
  tasksNeedingReassignment: Schema.Int,
  tenantId: PrincipalRefSchema.fields.tenantId,
  version: Schema.Literal(1),
});
type Mapping = typeof MappingSchema.Type;
type Plan = typeof PlanSchema.Type;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
class AssignmentMigrationInvalid extends Schema.TaggedError<AssignmentMigrationInvalid>()(
  'AssignmentMigrationInvalid',
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
const invalid = (reason: string) => new AssignmentMigrationInvalid({ reason });
const output = Effect.fn('AssignmentMigration.output')(function* output(path: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path, `${text}\n`, { flag: 'wx', mode: 0o600 });
});
const readMapping = Effect.fn('AssignmentMigration.readMapping')(function* readMapping(path: string) {
  const fs = yield* FileSystem.FileSystem;
  const mapping = yield* Schema.decodeEffect(Schema.fromJsonString(MappingSchema))(yield* fs.readFileString(path));
  if (!mapping.reviewed) {
    return yield* invalid('Review the owner-read mapping and explicitly set reviewed=true before planning/applying');
  }
  if (new Set(mapping.employees.map((employee) => employee.employeeId)).size !== mapping.employees.length) {
    return yield* invalid('Duplicate employee mapping');
  }
  return mapping;
});
const mappingHash = (mapping: Mapping) =>
  Schema.encodeEffect(Schema.fromJsonString(MappingSchema))(mapping).pipe(Effect.map(hash));
const readPlan = Effect.fn('AssignmentMigration.readPlan')(function* readPlan(path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Schema.decodeEffect(Schema.fromJsonString(PlanSchema))(yield* fs.readFileString(path));
});
const pgLive = PgClient.layerFrom(
  Effect.gen(function* pgLive() {
    const url = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'WORK_TASKS_DATABASE_URL',
    );
    return yield* PgClient.makeClient({ url });
  }),
);

const map = Command.make(
  'map',
  {
    compositionRevision: Flag.String('composition-revision').pipe(Flag.optional),
    legalEntityId: Flag.String('legal-entity-id'),
    output: Flag.String('output'),
    tenantId: Flag.String('tenant-id'),
    workforceUrl: Flag.String('workforce-url'),
  },
  Effect.fn('AssignmentMigration.map')(function* map(args) {
    const tenantId = yield* Schema.decodeUnknownEffect(PrincipalRefSchema.fields.tenantId)(args.tenantId);
    const legalEntityId = yield* Schema.decodeUnknownEffect(LegalEntityIdSchema)(args.legalEntityId);
    const credential = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'WORKFORCE_AUTHORIZATION',
    );
    const options = Option.match(args.compositionRevision, {
      onNone: () => ({ baseUrl: args.workforceUrl }),
      onSome: (compositionRevision) => ({ baseUrl: args.workforceUrl, compositionRevision }),
    });
    const records = yield* executeRecordsWithAuthorization(
      {},
      Redacted.value(credential),
      `work-assignment-map:${randomUUID()}`,
      options,
    );
    if (
      records.actorPrincipalRef.tenantId !== tenantId ||
      records.items.some(
        (employee) => employee.principalRef !== undefined && employee.principalRef.tenantId !== tenantId,
      )
    ) {
      return yield* invalid('Workforce linked login tenant mismatch');
    }
    // Workforce authorizes the exact company credential. Review confirms that scope before any owner-state write.
    const encoded = {
      employees: records.items.map((employee) => ({
        displayName: employee.fullName,
        employeeId: employee.id,
        principalRef: employee.principalRef ?? null,
      })),
      legalEntityId,
      reviewed: false,
      tenantId,
      version: 1 as const,
      workforceRevision: records.revision,
    };
    const mapping = yield* Schema.decodeUnknownEffect(MappingSchema)(encoded);
    yield* output(args.output, yield* Schema.encodeEffect(Schema.fromJsonString(MappingSchema))(mapping));
    return yield* Console.log(
      yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ employees: Schema.Int, reviewed: Schema.Boolean, unlinked: Schema.Int })),
      )({
        employees: mapping.employees.length,
        reviewed: false,
        unlinked: mapping.employees.filter((employee) => Option.isNone(employee.principalRef)).length,
      }),
    );
  }),
);

const prepare = Effect.fn('AssignmentMigration.prepare')(function* prepare(mapping: Mapping, lock: boolean) {
  const client = yield* PgClient.PgClient;
  yield* client`select set_config('ontos.tenant_id', ${mapping.tenantId}, true), set_config('ontos.legal_entity_id', ${mapping.legalEntityId}, true)`;
  const rows = lock
    ? yield* client<{
        revision: number;
        serialized: string;
      }>`select revision, state::text as serialized from work_tasks.work_states where tenant_id=${mapping.tenantId} and legal_entity_id=${mapping.legalEntityId} for update`
    : yield* client<{
        revision: number;
        serialized: string;
      }>`select revision, state::text as serialized from work_tasks.work_states where tenant_id=${mapping.tenantId} and legal_entity_id=${mapping.legalEntityId}`;
  const [row] = rows;
  if (row === undefined) {
    return yield* invalid('No work-tasks owner state exists for the reviewed scope');
  }
  const input = yield* Schema.decodeEffect(Schema.fromJsonString(EmployeeAssignmentMigrationInputSchema))(
    row.serialized,
  );
  const links = new Map(
    mapping.employees.flatMap((employee) =>
      Option.isSome(employee.principalRef) ? [[employee.employeeId, employee.principalRef.value] as const] : [],
    ),
  );
  const prepared = yield* Effect.fromResult(prepareEmployeeAssignmentMigration(input, links, mapping.tenantId));
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(WorkStateSchema))(prepared.state);
  const beforeHash = hash(row.serialized);
  const [canonical] = yield* client<{ serialized: string }>`select ${encoded}::jsonb::text as serialized`;
  if (canonical === undefined) {
    return yield* invalid('Cannot canonicalize owner state');
  }
  const afterHash = hash(canonical.serialized);
  const plan: Plan = {
    afterHash,
    assignmentOverrides: prepared.overrides,
    beforeHash,
    changed: beforeHash !== afterHash,
    changedExistingOwners: prepared.overrides.filter(
      (entry) =>
        Option.isSome(entry.before) &&
        Option.isSome(entry.after) &&
        (entry.before.value.principalId !== entry.after.value.principalId ||
          entry.before.value.tenantId !== entry.after.value.tenantId),
    ).length,
    clearedExistingOwners: prepared.overrides.filter(
      (entry) => Option.isSome(entry.before) && Option.isNone(entry.after),
    ).length,
    legalEntityId: mapping.legalEntityId,
    mappingHash: yield* mappingHash(mapping),
    projectsNeedingReassignment: (prepared.state.projects ?? []).filter(
      (project) => project.assignmentNeedsReassignment === true,
    ).length,
    revision: row.revision,
    tasksNeedingReassignment: prepared.state.tasks.filter((task) => task.assignmentNeedsReassignment === true).length,
    tenantId: mapping.tenantId,
    version: 1,
  };
  return { encoded, plan };
});
const dryRun = Command.make(
  'dry-run',
  { mapping: Flag.String('mapping'), output: Flag.String('output') },
  Effect.fn('AssignmentMigration.dryRun')(function* dryRun(args) {
    const client = yield* PgClient.PgClient;
    const mapping = yield* readMapping(args.mapping);
    const { plan } = yield* client.withTransaction(prepare(mapping, false));
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(PlanSchema))(plan);
    yield* output(args.output, text);
    yield* Console.log(text);
  }),
).pipe(Command.provide(pgLive));
const applyOrVerifyCommand = (mode: 'apply' | 'verify') =>
  Command.make(
    mode,
    { mapping: Flag.String('mapping'), plan: Flag.String('plan') },
    Effect.fn('AssignmentMigration.applyOrVerify')(function* applyOrVerify(args) {
      const mapping = yield* readMapping(args.mapping);
      const reviewedPlan = yield* readPlan(args.plan);
      if (
        reviewedPlan.mappingHash !== (yield* mappingHash(mapping)) ||
        reviewedPlan.tenantId !== mapping.tenantId ||
        reviewedPlan.legalEntityId !== mapping.legalEntityId
      ) {
        return yield* invalid('Plan/mapping scope or content mismatch');
      }
      const client = yield* PgClient.PgClient;
      return yield* client.withTransaction(
        Effect.gen(function* runOwnerTransaction() {
          const { encoded, plan } = yield* prepare(mapping, mode === 'apply');
          const completed =
            plan.beforeHash === reviewedPlan.afterHash &&
            plan.revision === reviewedPlan.revision + (reviewedPlan.changed ? 1 : 0);
          if (mode === 'verify' && (!completed || plan.beforeHash !== plan.afterHash)) {
            return yield* invalid('Owner state does not match the reviewed migration result');
          }
          if (mode === 'apply' && !completed) {
            if (
              plan.beforeHash !== reviewedPlan.beforeHash ||
              plan.afterHash !== reviewedPlan.afterHash ||
              plan.revision !== reviewedPlan.revision
            ) {
              return yield* invalid('Owner state changed since dry-run; review a new plan');
            }
            if (reviewedPlan.changed) {
              yield* client`update work_tasks.work_states set state=${encoded}::jsonb, revision=revision+1, updated_at=now() where tenant_id=${mapping.tenantId} and legal_entity_id=${mapping.legalEntityId} and revision=${reviewedPlan.revision}`;
            }
          }
          return yield* Console.log(
            yield* Schema.encodeEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  alreadyApplied: Schema.Boolean,
                  mode: Schema.Literals(['apply', 'verify']),
                  projectsNeedingReassignment: Schema.Int,
                  tasksNeedingReassignment: Schema.Int,
                  verified: Schema.Boolean,
                }),
              ),
            )({
              alreadyApplied: completed,
              mode,
              projectsNeedingReassignment: plan.projectsNeedingReassignment,
              tasksNeedingReassignment: plan.tasksNeedingReassignment,
              verified: true,
            }),
          );
        }),
      );
    }),
  ).pipe(Command.provide(pgLive));
const cli = Command.make('migrate-assignments').pipe(
  Command.withSubcommands([map, dryRun, applyOrVerifyCommand('apply'), applyOrVerifyCommand('verify')]),
);
const live = Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
NodeRuntime.runMain(Effect.scoped(Layer.build(live)));
