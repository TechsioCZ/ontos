#!/usr/bin/env node
/** Stage-only repair of the four Nájempark case fixtures. Records and exact resource grants are reviewed separately. */
import { createHash } from 'node:crypto';

import { toModuleAccessObjectId, toResourceAccessObjectId } from '@app/core-runtime';
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';
import { readMissingServiceGrants } from './reconcile-stage-service-grants.mts';
import { seedSiamparkCaseRecords } from './seed-siampark-cases.mts';
import { connectSeedClient, DemoSeedError } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';
import { EmployeeIdSchema } from '../../verticals/workforce/shared/resources/employee.ts';
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';

const origin = 'https://ontos-stage.web-revolution.cz';
const target = { legalEntityId: rentalDemoLegalEntityId, shellUrl: origin, tenantId: demoTenantId };
const externalPrincipalId = '72000000-0000-4000-8000-000000000024';
const pipelineAudience = 'sales-pipeline';
const moduleId = 'demo.sales-pipeline';
const resourceType = 'demo.sales-pipeline.opportunity';
export const stageCaseSpecs = [
  { owner: 'external', title: 'Pronájem R101 – Kavárna Na Nábřeží' },
  { owner: 'external', title: 'Kanceláře Riverside – Horák & partneři' },
  { owner: 'external', title: 'Ateliér Riverside – Ing. Pavel Šťastný' },
  { owner: 'management', title: 'Ordinace v přízemí – Fyzioterapie Pohyb' },
] as const;
const Opportunity = Schema.Struct({
  id: Schema.String,
  ownerEmployeeId: Schema.optionalKey(Schema.toEncoded(EmployeeIdSchema)),
  title: Schema.String,
});
const Pipeline = Schema.Struct({ items: Schema.Array(Opportunity), revision: Schema.Int });
type CaseRecord = typeof Opportunity.Type;
const Employees = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ active: Schema.Boolean, email: Schema.optionalKey(Schema.String), id: Schema.String }),
  ),
});
const Crm = Schema.Struct({
  revision: Schema.Int,
  state: Schema.Struct({
    clients: Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })) }),
  }),
});
const PlanSchema = Schema.Struct({
  company: Schema.Literal(rentalDemoLegalEntityId),
  crmRevision: Schema.Int,
  externalEmployeeId: Schema.toEncoded(EmployeeIdSchema),
  managementEmployeeId: Schema.toEncoded(EmployeeIdSchema),
  missing: Schema.Array(Schema.String),
  records: Schema.Array(Opportunity),
  revision: Schema.Int,
  seedDigest: Schema.String,
  step: Schema.Literals(['records', 'grants']),
  tenant: Schema.Literal(demoTenantId),
  tuples: Schema.Array(Schema.String),
});
type Plan = typeof PlanSchema.Type;
export const stageCaseFingerprint = (plan: Plan) =>
  Schema.encodeEffect(Schema.fromJsonString(PlanSchema))(plan).pipe(
    Effect.map((encoded) => createHash('sha256').update(encoded).digest('hex')),
  );
const sameStrings = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const fail = (reason: string) => new DemoSeedError({ reason });
const matching = (records: readonly CaseRecord[], title: string) => records.filter((record) => record.title === title);
export const validateStageCases = (
  records: readonly CaseRecord[],
  owners: Readonly<Record<'external' | 'management', string>>,
  complete: boolean,
) =>
  Effect.gen(function* validateCases() {
    for (const spec of stageCaseSpecs) {
      const found = matching(records, spec.title);
      if (found.length > 1 || (complete && found.length !== 1)) {
        return yield* fail(`Missing or duplicated case: ${spec.title}`);
      }
      if (found[0] !== undefined && found[0].ownerEmployeeId !== owners[spec.owner]) {
        return yield* fail(`Case assignment differs: ${spec.title}`);
      }
    }
    return yield* Effect.void;
  });

/** Exactly three reader edges and their module containment, never a role, module reader or fourth case grant. */
export const stageCaseGrants = (records: readonly CaseRecord[], externalEmployeeId: string) =>
  Effect.gen(function* buildGrants() {
    const moduleObject = toModuleAccessObjectId(demoTenantId, rentalDemoLegalEntityId, moduleId);
    if (moduleObject === undefined) {
      return yield* fail('Invalid pinned case module scope');
    }
    const relationships: v1.Relationship[] = [];
    for (const spec of stageCaseSpecs.filter((item) => item.owner === 'external')) {
      const found = matching(records, spec.title);
      const [record] = found;
      if (found.length !== 1 || record?.ownerEmployeeId !== externalEmployeeId) {
        return yield* fail(`Expected one assigned case: ${spec.title}`);
      }
      const resourceId = toResourceAccessObjectId(demoTenantId, rentalDemoLegalEntityId, {
        moduleId,
        resourceId: record.id,
        resourceType,
      });
      if (resourceId === undefined) {
        return yield* fail('Invalid case resource reference');
      }
      for (const edge of [
        { objectId: moduleObject, objectType: 'module_access', relation: 'module' },
        { objectId: externalPrincipalId, objectType: 'principal', relation: 'reader' },
      ]) {
        relationships.push(
          v1.Relationship.create({
            relation: edge.relation,
            resource: { objectId: resourceId, objectType: 'resource' },
            subject: { object: { objectId: edge.objectId, objectType: edge.objectType } },
          }),
        );
      }
    }
    return relationships;
  });

const requireComplete = (step: 'records' | 'grants', mode: 'plan' | 'apply' | 'verify') =>
  step === 'grants' || mode === 'verify';

const run = (
  step: 'records' | 'grants',
  mode: 'plan' | 'apply' | 'verify',
  planPath: string,
  reviewed: Option.Option<string>,
) =>
  Effect.gen(function* repairStageCases() {
    const environment = yield* Config.all({
      ONTOS_PUBLIC_ORIGIN: Config.schema(Schema.Literal(origin), 'ONTOS_PUBLIC_ORIGIN'),
      SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
      SPICEDB_ENDPOINT: Config.schema(Schema.Literal('spicedb:50051'), 'SPICEDB_ENDPOINT'),
      SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    });
    const password = yield* Config.Redacted('ONTOS_AGENT_SETUP_PASSWORD');
    const fs = yield* FileSystem.FileSystem;
    const seedDigest = createHash('sha256')
      .update(yield* fs.readFileString(new URL('seed-siampark-cases.mts', import.meta.url).pathname))
      .digest('hex');
    const native = yield* connectSeedClient(target, 'management@najempark.demo', password);
    // Every invocation gets fresh single-use credentials for each reference owner.
    const client: SeedClient = {
      ...native,
      call: (audience, path, input, payload, output, write, references) =>
        native.call(
          audience,
          path,
          input,
          payload,
          output,
          write,
          audience === pipelineAudience && write === true ? ['party-registry', 'workforce'] : references,
        ),
    };
    const employees = yield* client.read('workforce', Employees);
    const employee = (email: string) => employees.items.filter((item) => item.active && item.email === email);
    const external = employee('external@najempark.demo');
    const management = employee('management@najempark.demo');
    if (external.length !== 1 || management.length !== 1 || external[0] === undefined || management[0] === undefined) {
      return yield* fail('Expected exact active Nájempark employees');
    }
    const owners = { external: external[0].id, management: management[0].id };
    const crm = yield* client.read('crm', Crm);
    const pipeline = yield* client.read(pipelineAudience, Pipeline);
    yield* validateStageCases(pipeline.items, owners, requireComplete(step, mode));
    const desired = step === 'grants' ? yield* stageCaseGrants(pipeline.items, owners.external) : [];
    const plan: Plan = {
      company: rentalDemoLegalEntityId,
      crmRevision: crm.revision,
      externalEmployeeId: owners.external,
      managementEmployeeId: owners.management,
      missing: stageCaseSpecs
        .filter((spec) => matching(pipeline.items, spec.title).length === 0)
        .map((spec) => spec.title),
      records: pipeline.items,
      revision: pipeline.revision,
      seedDigest,
      step,
      tenant: demoTenantId,
      tuples: desired.map((item) => v1.Relationship.toJsonString(item)),
    };
    const currentFingerprint = yield* stageCaseFingerprint(plan);
    if (mode === 'plan') {
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PlanSchema))(plan);
      yield* fs.writeFileString(planPath, encoded, { flag: 'wx', mode: 0o600 });
      return yield* Console.log({
        fingerprint: currentFingerprint,
        missing: plan.missing,
        mode,
        step,
        tuples: plan.tuples,
      });
    }
    const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PlanSchema))(
      yield* fs.readFileString(planPath),
    );
    const savedFingerprint = yield* stageCaseFingerprint(saved);
    if (
      Option.isNone(reviewed) ||
      reviewed.value !== savedFingerprint ||
      saved.step !== step ||
      saved.seedDigest !== seedDigest
    ) {
      return yield* fail('An exact reviewed stage plan and source fingerprint are required');
    }
    if (mode === 'apply' && currentFingerprint !== savedFingerprint) {
      return yield* fail('Stage data changed since review; create a fresh plan, no writes performed');
    }
    if (step === 'records') {
      if (mode === 'apply') {
        yield* seedSiamparkCaseRecords(client, target, owners, `${planPath}.checkpoints`);
      }
      const result = yield* client.read(pipelineAudience, Pipeline);
      yield* validateStageCases(result.items, owners, true);
      return yield* Console.log({
        fixtures: 4,
        mode,
        step,
        titles: result.items.map((item) => item.title),
        total: result.items.length,
      });
    }
    if (!sameStrings(saved.tuples, plan.tuples)) {
      return yield* fail('The exact three case resources no longer match the reviewed grant plan');
    }
    const config = yield* parseSpiceDbConfig({
      ...environment,
      SPICEDB_PRESHARED_KEY: Redacted.value(environment.SPICEDB_PRESHARED_KEY),
    });
    const rpc = yield* Effect.acquireRelease(
      Effect.try({
        catch: () => fail('Stage permission channel unavailable'),
        try: () => openSpiceDbGrpcRpc(config, 10_000),
      }),
      (channel) => Effect.sync(() => channel.close()),
    );
    if (mode === 'apply') {
      yield* rpc.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: desired.map((relationship) =>
            v1.RelationshipUpdate.create({
              operation: v1.RelationshipUpdate_Operation.TOUCH,
              relationship,
            }),
          ),
        }),
      );
    }
    if ((yield* readMissingServiceGrants(rpc, desired)).length !== 0) {
      return yield* fail('The reviewed case reader grants are incomplete');
    }
    const externalClient = yield* connectSeedClient(target, 'external@najempark.demo', password);
    const visible = yield* externalClient.read(pipelineAudience, Pipeline);
    const expected = stageCaseSpecs.filter((spec) => spec.owner === 'external').map((spec) => spec.title);
    if (
      visible.items.length !== expected.length ||
      !expected.every((title) => visible.items.some((item) => item.title === title))
    ) {
      return yield* fail('External must see exactly its three cases, and no other case');
    }
    return yield* Console.log({
      containmentEdges: 3,
      externalCount: visible.items.length,
      externalTitles: visible.items.map((item) => item.title),
      managementFixtures: 4,
      managementTotal: pipeline.items.length,
      mode,
      readerGrants: 3,
      roleChanges: 0,
      step,
    });
  }).pipe(Effect.scoped);

const command = Command.make(
  'siampark-cases-stage',
  {
    mode: Flag.Literals('mode', ['plan', 'apply', 'verify']),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
    step: Flag.Literals('step', ['records', 'grants']),
  },
  ({ mode, plan, reviewed, step }) =>
    run(step, mode, plan, reviewed).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DemoSeedError)(failure) ? failure.reason : 'Nájempark case repair stopped; credentials withheld',
        ),
      ),
    ),
);
if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(ProcessDatabasePoolsLive),
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
