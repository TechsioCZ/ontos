#!/usr/bin/env node
/**
 * Additive Štítky and Úkoly for the Nájempark (0021) and Velkoobchod Hanák (0022) demo companies
 * (content: `company-content.mts`). Runs through the public tagging and work-tasks reads and Actions as each
 * company's administrator, so audit trails, history and revisions stay native:
 *
 *   1. creates every catalogue tag whose name is missing and assigns it to the named customers, employees and
 *      business cases that do not carry it yet;
 *   2. creates every task whose title is missing, assigned to its responsible person, then moves it along the legal
 *      state path to its demo state.
 *
 * Nothing is updated or removed; a re-run adds only what is missing. Without `--apply` it only reports the plan.
 *
 *   node scripts/demo/seed-company-content.mts [--apply]
 *
 * Environment: ONTOS_DEMO_SEED_URL (default http://localhost:3020), ONTOS_DEMO_PASSWORD (default password1234).
 */
import { NodeServices } from '@effect/platform-node';
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { SingleWorkCommandSchema } from '@app/work-tasks/contracts/apply-command';
import { TaskRefSchema } from '@app/work-tasks/resources/task';
import { Config, Console, DateTime, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { TaggingCommandSchema } from '../../verticals/tagging/shared/actions/apply-command.ts';
import { SubjectSchema, TagIdSchema } from '../../verticals/tagging/shared/apis/records.ts';
import {
  companyContent,
  dueDate,
  existingTag,
  missingTags,
  missingTasks,
  personaPrincipalIds,
  statePath,
} from './company-content.mts';
import type { CompanyContent, SubjectSpec, TagSpec, TaskSpec } from './company-content.mts';
import { demoTenantId } from './fixture-ids.mts';
import { seedCustomerList } from './rental-seed-customer.mts';
import { connectSeedClient, DemoSeedError } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';

const taggingAudience = 'tagging';
const workAudience = 'work-tasks';

// Bounded operator projections of the public records contracts.
const TaggingRecords = Schema.Struct({
  assignments: Schema.Array(Schema.Struct({ subject: SubjectSchema, tagId: TagIdSchema })),
  canWrite: Schema.Boolean,
  revision: Schema.Int,
  tags: Schema.Array(
    Schema.Struct({ id: TagIdSchema, name: Schema.String, subjectKinds: Schema.Array(Schema.String) }),
  ),
});
const WorkRecords = Schema.Struct({
  assignablePrincipals: Schema.Array(Schema.Struct({ principalRef: PrincipalRefSchema })),
  canWrite: Schema.Boolean,
  items: Schema.Array(Schema.Struct({ title: Schema.String })),
  revision: Schema.Int,
});
const WorkRecordsRequest = Schema.Struct({ includeArchived: Schema.Boolean });
const Employees = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, principalRef: Schema.optionalKey(PrincipalRefSchema) })),
});
const Opportunities = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
});

const TaggingPayload = Schema.Struct({ command: Schema.toEncoded(TaggingCommandSchema), expectedRevision: Schema.Int });
const TaggingResult = Schema.Struct({ revision: Schema.Int, tagId: TagIdSchema });
const WorkPayload = Schema.Struct({ command: Schema.toEncoded(SingleWorkCommandSchema), expectedRevision: Schema.Int });
const WorkResult = Schema.Struct({
  revision: Schema.Int,
  task: Schema.optionalKey(Schema.Struct({ ref: TaskRefSchema })),
});

type TaggingCommand = (typeof TaggingPayload.Type)['command'];
type WorkCommand = (typeof WorkPayload.Type)['command'];
type CreateTaskCommand = Extract<WorkCommand, { readonly _tag: 'CreateTask' }>;

const applyTagging = (client: SeedClient, command: TaggingCommand, expectedRevision: number) =>
  client.call(
    taggingAudience,
    `/${taggingAudience}/actions/apply-command`,
    TaggingPayload,
    { command, expectedRevision },
    TaggingResult,
    true,
  );
const applyWork = (client: SeedClient, command: WorkCommand, expectedRevision: number) =>
  client.call(
    workAudience,
    `/${workAudience}/actions/apply-command`,
    WorkPayload,
    { command, expectedRevision },
    WorkResult,
    true,
  );

const tagNeeds = (content: CompanyContent, kind: SubjectSpec['kind']) =>
  content.tags.some((tag) => tag.subjects.some((subject) => subject.kind === kind));

/** Natural key → record ID of every customer, employee and business case the content names, via public reads. */
const readDirectory = Effect.fn('CompanyContent.readDirectory')(function* readDirectory(
  client: SeedClient,
  content: CompanyContent,
) {
  const customers =
    tagNeeds(content, 'customer') || content.tasks.some((task) => task.customer !== undefined)
      ? yield* seedCustomerList(client)
      : [];
  const employees = tagNeeds(content, 'employee') ? (yield* client.read('workforce', Employees)).items : [];
  const cases =
    tagNeeds(content, 'opportunity') || content.tasks.some((task) => task.opportunity !== undefined)
      ? (yield* client.read('sales-pipeline', Opportunities)).items
      : [];
  const caseId = (title: string) => cases.find((item) => item.title === title)?.id;
  const customerId = (name: string) => customers.find((item) => item.displayName === name)?.partyRef.resourceId;
  const employeeId = (email: string) => {
    const principalId = personaPrincipalIds.get(email);
    return employees.find((item) => principalId !== undefined && item.principalRef?.principalId === principalId)?.id;
  };
  const subjectId = (spec: SubjectSpec) => {
    if (spec.kind === 'customer') {
      return customerId(spec.name);
    }
    return spec.kind === 'employee' ? employeeId(spec.email) : caseId(spec.title);
  };
  return { caseId, customerId, subjectId };
});
type Directory = Effect.Success<ReturnType<typeof readDirectory>>;

const describe = (spec: SubjectSpec) => {
  if (spec.kind === 'customer') {
    return `customer „${spec.name}“`;
  }
  return spec.kind === 'employee' ? `employee ${spec.email}` : `business case „${spec.title}“`;
};

const resolved = <A extends string>(label: string, value: A | undefined): Effect.Effect<A, DemoSeedError> =>
  value === undefined
    ? Effect.fail(new DemoSeedError({ reason: `${label} was not found; run the company's base seed first.` }))
    : Effect.succeed(value);

const seedTags = Effect.fn('CompanyContent.seedTags')(function* seedTags(
  client: SeedClient,
  content: CompanyContent,
  directory: Directory,
  apply: boolean,
) {
  let records = yield* client.read(taggingAudience, TaggingRecords);
  if (apply && !records.canWrite) {
    return yield* new DemoSeedError({ reason: `${content.writerEmail} cannot write Štítky in ${content.label}.` });
  }
  const created = missingTags(content.tags, records.tags);
  let { revision } = records;
  for (const spec of apply ? created : []) {
    const createTag = {
      _tag: 'CreateTag',
      color: spec.color,
      description: spec.description,
      name: spec.name,
      subjectKinds: [...spec.subjectKinds],
    } as const;
    ({ revision } = yield* applyTagging(client, createTag, revision));
  }
  if (apply && created.length > 0) {
    records = yield* client.read(taggingAudience, TaggingRecords);
    ({ revision } = records);
  }
  let assigned = 0;
  const unresolved: string[] = [];
  for (const spec of content.tags) {
    const tag = existingTag(spec, records.tags);
    // A record whose base seed has not run yet is reported and assigned on a later run; the tag is still created.
    const subjects = spec.subjects.flatMap((subject) => {
      const id = directory.subjectId(subject);
      if (id === undefined) {
        unresolved.push(describe(subject));
        return [];
      }
      return [{ id, kind: subject.kind }];
    });
    const missing = subjects.filter(
      (subject) =>
        !records.assignments.some(
          (assignment) =>
            assignment.tagId === tag?.id &&
            assignment.subject.id === subject.id &&
            assignment.subject.kind === subject.kind,
        ),
    );
    if (tag !== undefined && missing.some((subject) => !tag.subjectKinds.includes(subject.kind))) {
      return yield* new DemoSeedError({
        reason: `Existing tag „${spec.name}“ in ${content.label} does not apply to every seeded subject kind; review it first.`,
      });
    }
    assigned += missing.length;
    if (apply && tag !== undefined && missing.length > 0) {
      ({ revision } = yield* applyTagging(client, { _tag: 'AssignTag', subjects: missing, tagId: tag.id }, revision));
    }
  }
  return { assigned, created: created.map((spec: TagSpec) => spec.name), unresolved };
});

const taskCommand = Effect.fn('CompanyContent.taskCommand')(function* taskCommand(
  spec: TaskSpec,
  assignable: (typeof WorkRecords.Type)['assignablePrincipals'],
  directory: Directory,
  today: DateTime.Utc,
  content: CompanyContent,
) {
  const principalId = yield* resolved(`Persona ${spec.assignee}`, personaPrincipalIds.get(spec.assignee));
  if (!assignable.some((item) => item.principalRef.principalId === principalId)) {
    return yield* new DemoSeedError({ reason: `${spec.assignee} is not an assignable member of ${content.label}.` });
  }
  const task: CreateTaskCommand = {
    _tag: 'CreateTask',
    description: spec.description,
    dueDate: dueDate(today, spec.dueInDays),
    ownerPrincipalRef: { principalId, tenantId: demoTenantId },
    priority: spec.priority,
    title: spec.title,
  };
  const withCustomer: CreateTaskCommand =
    spec.customer === undefined
      ? task
      : { ...task, partyId: yield* resolved(`customer „${spec.customer}“`, directory.customerId(spec.customer)) };
  return spec.opportunity === undefined
    ? withCustomer
    : {
        ...withCustomer,
        opportunityId: yield* resolved(`business case „${spec.opportunity}“`, directory.caseId(spec.opportunity)),
      };
});

const seedTasks = Effect.fn('CompanyContent.seedTasks')(function* seedTasks(
  client: SeedClient,
  content: CompanyContent,
  directory: Directory,
  apply: boolean,
) {
  const records = yield* client.call(
    workAudience,
    '/reads/records',
    WorkRecordsRequest,
    { includeArchived: true },
    WorkRecords,
  );
  if (apply && !records.canWrite) {
    return yield* new DemoSeedError({ reason: `${content.writerEmail} cannot write Úkoly in ${content.label}.` });
  }
  const today = yield* DateTime.now;
  const pending = missingTasks(
    content.tasks,
    records.items.map((item) => item.title),
  );
  // Every command is built (assignee and links resolved) before the first write, so a preflight run checks them too.
  const commands = yield* Effect.forEach(
    pending,
    (spec) =>
      taskCommand(spec, records.assignablePrincipals, directory, today, content).pipe(
        Effect.map((command) => ({ command, spec })),
      ),
    { concurrency: 1 },
  );
  let { revision } = records;
  for (const { command, spec } of apply ? commands : []) {
    const result = yield* applyWork(client, command, revision);
    ({ revision } = result);
    const { task } = result;
    if (task === undefined) {
      return yield* new DemoSeedError({ reason: `Creating „${spec.title}“ returned no task; rerun to resume.` });
    }
    for (const state of statePath(spec.state)) {
      ({ revision } = yield* applyWork(client, { _tag: 'ChangeTaskState', state, taskRef: task.ref }, revision));
    }
  }
  return pending.map((spec: TaskSpec) => spec.title);
});

const seedCompany = Effect.fn('CompanyContent.seedCompany')(function* seedCompany(
  content: CompanyContent,
  shellUrl: string,
  password: Redacted.Redacted,
  apply: boolean,
) {
  const client = yield* Effect.acquireRelease(
    connectSeedClient(
      { legalEntityId: content.legalEntityId, shellUrl, tenantId: demoTenantId },
      content.writerEmail,
      password,
    ),
    (connected) => Effect.ignore(connected.signOut),
  );
  const directory = yield* readDirectory(client, content);
  const tags = yield* seedTags(client, content, directory, apply);
  const tasks = yield* seedTasks(client, content, directory, apply);
  const verb = apply ? 'added' : 'missing';
  yield* Console.log(
    `${content.label}: tags ${verb} ${tags.created.length} [${tags.created.join(', ')}], assignments ${verb} ${tags.assigned}, tasks ${verb} ${tasks.length}`,
  );
  if (tags.unresolved.length > 0) {
    yield* Console.log(`${content.label}: not seeded yet, assign later: ${tags.unresolved.join('; ')}`);
  }
});

const main = (apply: boolean) =>
  Effect.gen(function* run() {
    const shellUrl = yield* Config.String('ONTOS_DEMO_SEED_URL').pipe(Config.withDefault('http://localhost:3020'));
    const password = yield* Config.Redacted('ONTOS_DEMO_PASSWORD').pipe(
      Config.withDefault(Redacted.make('password1234')),
    );
    yield* Effect.forEach(companyContent, (content) => Effect.scoped(seedCompany(content, shellUrl, password, apply)), {
      concurrency: 1,
      discard: true,
    });
    if (!apply) {
      yield* Console.log('No data changed. Run with --apply to add the missing content.');
    }
  });

const command = Command.make(
  'seed-company-content',
  { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)) },
  ({ apply }) =>
    main(apply).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DemoSeedError)(failure)
            ? failure.reason
            : `Seeder stopped (${failure._tag}); credentials and response bodies are not logged.`,
        ),
      ),
    ),
);

if (import.meta.main) {
  const runtime = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
  const result = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtime)));
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
