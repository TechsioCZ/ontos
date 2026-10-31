import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, ConfigProvider, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { EmployeeAssignmentMigrationInputSchema } from '../../src/services/migrate-employee-assignments.ts';

const script = new URL('../../scripts/migrate-assignments.mts', import.meta.url).pathname;
const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const principalRef = { principalId: '40000000-0000-4000-8000-000000000001', tenantId };
const linkedId = '50000000-0000-4000-8000-000000000001';
const unlinkedId = '50000000-0000-4000-8000-000000000002';
const at = '2026-10-01T10:00:00Z';
const collectionRef = {
  moduleId: 'work.tasks',
  resourceId: 'default',
  resourceType: 'work.tasks.task-collection',
  tenantId,
};
const task = {
  collectionRef,
  contextRefs: [],
  createdAt: at,
  priority: 'NORMAL',
  ref: { moduleId: 'work.tasks', resourceId: 'task-a', resourceType: 'work.tasks.task', tenantId },
  state: 'NEW',
  title: 'Assigned work',
  updatedAt: at,
};
const fixture = {
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: collectionRef,
    title: 'Tasks',
  },
  projects: [
    {
      createdAt: at,
      id: 'project-a',
      milestones: [],
      plannedEnd: '2026-10-31',
      plannedStart: '2026-10-01',
      responsibleEmployeeId: linkedId,
      state: 'ACTIVE',
      title: 'Project',
      updatedAt: at,
    },
  ],
  tasks: [
    { ...task, assigneeEmployeeId: linkedId, ownerPrincipalRef: { ...principalRef, principalId: legalEntityId } },
    {
      ...task,
      assigneeEmployeeId: unlinkedId,
      ownerPrincipalRef: { ...principalRef, principalId: legalEntityId },
      ref: { ...task.ref, resourceId: 'task-unlinked' },
    },
  ],
};
const mapping = {
  employees: [
    { displayName: 'Human', employeeId: linkedId, principalRef },
    { displayName: 'Unlinked', employeeId: unlinkedId, principalRef: null },
  ],
  legalEntityId,
  reviewed: true,
  tenantId,
  version: 1,
  workforceRevision: 4,
};
const ReportSchema = Schema.Struct({
  alreadyApplied: Schema.optionalKey(Schema.Boolean),
  assignmentOverrides: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  changed: Schema.optionalKey(Schema.Boolean),
  changedExistingOwners: Schema.optionalKey(Schema.Int),
  clearedExistingOwners: Schema.optionalKey(Schema.Int),
  tasksNeedingReassignment: Schema.optionalKey(Schema.Int),
  verified: Schema.optionalKey(Schema.Boolean),
});
const StoredRowSchema = Schema.Struct({
  revision: Schema.Int,
  state: Schema.fromJsonString(EmployeeAssignmentMigrationInputSchema),
});
const databaseUrl = Config.schema(Schema.Redacted(Schema.String), 'WORK_TASKS_MIGRATION_TEST_DATABASE_URL');
const postgres = PgClient.layerFrom(
  Effect.gen(function* migrationTestPostgres() {
    return yield* PgClient.makeClient({ url: yield* databaseUrl });
  }),
);
const layers = Layer.mergeAll(NodeServices.layer, postgres).pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
);

it.effect(
  'owner migration dry-run → apply → verify is scoped, reviewed, optimistic and idempotent',
  () =>
    Effect.gen(function* nativeOwnerMigration() {
      const url = yield* databaseUrl;
      const scratch = yield* Config.String('WORK_TASKS_MIGRATION_TEST_SCRATCH');
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* PgClient.PgClient;
      const mappingPath = path.join(scratch, 'mapping.json');
      const planPath = path.join(scratch, 'plan.json');
      const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
      const run = (mode: string, extra: readonly string[] = []) =>
        Effect.sync(() =>
          spawnSync(process.execPath, [script, mode, '--mapping', mappingPath, ...extra], {
            encoding: 'utf-8',
            env: { TMPDIR: scratch, WORK_TASKS_DATABASE_URL: Redacted.value(url) },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60_000,
          }),
        );
      const successful = Effect.fn('AssignmentMigrationTest.successful')(function* successful(
        mode: string,
        extra: readonly string[],
      ) {
        const result = yield* run(mode, extra);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        return yield* Schema.decodeEffect(Schema.fromJsonString(ReportSchema))(result.stdout);
      });
      const load = Effect.fn('AssignmentMigrationTest.load')(function* load(companyId: string) {
        const rows = yield* sql<{
          revision: number;
          state: string;
        }>`select revision,state::text as state from work_tasks.work_states where legal_entity_id=${companyId}`;
        return yield* Schema.decodeUnknownEffect(Schema.Array(StoredRowSchema))(rows);
      });
      yield* sql`create schema work_tasks`;
      yield* sql`create table work_tasks.work_states (tenant_id uuid not null, legal_entity_id uuid not null, revision integer not null, state jsonb not null, updated_at timestamptz not null default now(), primary key(tenant_id, legal_entity_id))`;
      const stateJson = yield* encodeJson(fixture);
      yield* sql`insert into work_tasks.work_states(tenant_id, legal_entity_id, revision, state) values(${tenantId},${legalEntityId},9,${stateJson}::jsonb)`;
      yield* sql`insert into work_tasks.work_states(tenant_id, legal_entity_id, revision, state) values(${tenantId},${principalRef.principalId},10,${stateJson}::jsonb)`;
      yield* fs.writeFileString(mappingPath, yield* encodeJson({ ...mapping, reviewed: false }));
      const unreviewed = yield* run('dry-run', ['--output', planPath]);
      expect(unreviewed.status).not.toBe(0);
      expect(`${unreviewed.stdout}\n${unreviewed.stderr}`).toContain('Review the owner-read mapping');
      yield* fs.writeFileString(mappingPath, yield* encodeJson(mapping));
      const plan = yield* successful('dry-run', ['--output', planPath]);
      expect(plan.changed).toBe(true);
      expect(plan.tasksNeedingReassignment).toBe(1);
      expect(plan.changedExistingOwners).toBe(1);
      expect(plan.clearedExistingOwners).toBe(1);
      expect(plan.assignmentOverrides).toHaveLength(3);
      const [before] = yield* load(legalEntityId);
      expect(before?.revision).toBe(9);
      expect(before?.state.tasks[0]?.assigneeEmployeeId).toBe(linkedId);
      yield* sql`update work_tasks.work_states set revision=10 where legal_entity_id=${legalEntityId}`;
      const stale = yield* run('apply', ['--plan', planPath]);
      expect(stale.status).not.toBe(0);
      expect(`${stale.stdout}\n${stale.stderr}`).toContain('changed since dry-run');
      yield* sql`update work_tasks.work_states set revision=9 where legal_entity_id=${legalEntityId}`;
      expect((yield* successful('apply', ['--plan', planPath])).alreadyApplied).toBe(false);
      expect((yield* successful('apply', ['--plan', planPath])).alreadyApplied).toBe(true);
      expect((yield* successful('verify', ['--plan', planPath])).verified).toBe(true);
      const [after] = yield* load(legalEntityId);
      expect(after?.revision).toBe(10);
      expect(after?.state.tasks[0]?.ownerPrincipalRef).toEqual(principalRef);
      expect(after?.state.tasks[1]?.assignmentNeedsReassignment).toBe(true);
      expect(after?.state.tasks[0]).not.toHaveProperty('assigneeEmployeeId');
      expect(after?.state.projects?.[0]?.responsiblePrincipalRef).toEqual(principalRef);
      const [untouched] = yield* load(principalRef.principalId);
      expect(untouched?.state.tasks[0]?.assigneeEmployeeId).toBe(linkedId);
      expect(untouched?.revision).toBe(10);
      const savedPlan = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ mappingHash: Schema.String })),
      )(yield* fs.readFileString(planPath));
      expect(savedPlan.mappingHash).toHaveLength(64);
      yield* fs.writeFileString(mappingPath, yield* encodeJson({ ...mapping, workforceRevision: 5 }));
      const changedMapping = yield* run('verify', ['--plan', planPath]);
      expect(changedMapping.status).not.toBe(0);
      expect(`${changedMapping.stdout}\n${changedMapping.stderr}`).toContain('content mismatch');
    }).pipe(Effect.provide(layers), Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))),
  { timeout: 90_000 },
);
