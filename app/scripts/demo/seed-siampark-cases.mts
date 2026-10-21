#!/usr/bin/env node
/**
 * LOCAL ONLY. Siampark (0021) business cases (obchodní případy) for S00 "Externí obchodník smí číst jen svěřené
 * kontakty a případy". Idempotent; runs through the public governed APIs as Vedení (management@siampark.demo):
 *
 *   1. creates the four prospect cases below when a case with the same title is absent (three owned by the
 *      external salesperson's employee record, one by Vedení) with the sales-pipeline `CreateOpportunity` Action;
 *   2. entrusts to external@siampark.demo exactly the cases whose owner is his employee record: one SpiceDB
 *      `resource#reader` grant per case, and removes the grant from cases no longer owned by him.
 *
 * external@ opens `demo.sales-pipeline` read-only WITHOUT `demo.sales_pipeline.read_all` (permissions.mts), so the
 * owner's governed records read returns only the granted cases; he holds no sales-pipeline Action at all.
 * Vedení entrusts a further case by assigning it to „Externí obchodník“ and re-running this script.
 *
 *   node scripts/demo/seed-siampark-cases.mts
 *
 * Environment: ONTOS_DEMO_SEED_URL (default http://localhost:3020), ONTOS_DEMO_PASSWORD (password1234),
 * ONTOS_DEMO_ENV_FILE (the running runtime's .env when its SpiceDB TLS certificate differs from app/.env; do not
 * also pass --env-file=.env, process variables win over the file).
 */
import { v1 } from '@authzed/authzed-node';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { bootstrapRelationshipRequest } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { toModuleAccessObjectId, toResourceAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { CreateOpportunityCommandSchema } from '../../verticals/sales-pipeline/shared/actions/apply-command.ts';
import { demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';
import type { DemoRelationship } from './permissions.mts';
import { siamparkRentalPersonas } from './permissions.mts';
import { connectSeedClient, DemoSeedError } from './seed-client.mts';

const moduleId = 'demo.sales-pipeline';
const resourceType = 'demo.sales-pipeline.opportunity';
const externalEmail = 'external@siampark.demo';
const managementEmail = 'management@siampark.demo';

const externalPrincipalId = siamparkRentalPersonas.find(({ email }) => email === externalEmail)?.principalId ?? '';

interface CaseSeed {
  /** Calendar date the case is expected to close. */
  readonly close: string;
  /** CRM client / registry customer the case belongs to. */
  readonly customer: string;
  readonly monthlyRentCzk: number;
  readonly note: string;
  readonly owner: 'external' | 'management';
  readonly premises: string;
  readonly stage: 'LEAD' | 'NEGOTIATION' | 'PROPOSAL' | 'QUALIFIED';
  readonly title: string;
}

const cases: readonly CaseSeed[] = [
  {
    close: '2026-12-15',
    customer: 'Kavárna Na Nábřeží s.r.o.',
    monthlyRentCzk: 38_500,
    note: 'Prohlídka R101 proběhla; čeká se na půdorys a podmínky nájmu (odvětrání, sklad).',
    owner: 'external',
    premises: 'Nájem obchodního prostoru R101 v přízemí, měsíční nájemné',
    stage: 'QUALIFIED',
    title: 'Pronájem R101 – Kavárna Na Nábřeží',
  },
  {
    close: '2027-01-31',
    customer: 'Advokátní kancelář Horák & partneři',
    monthlyRentCzk: 52_000,
    note: 'Nabídka kanceláří ve 2. patře odeslána; klient chce zasedačku a dvě parkovací místa.',
    owner: 'external',
    premises: 'Nájem kanceláří ve 2. patře Riverside Office Park, měsíční nájemné',
    stage: 'PROPOSAL',
    title: 'Kanceláře Riverside – Horák & partneři',
  },
  {
    close: '2027-02-26',
    customer: 'Ing. Pavel Šťastný',
    monthlyRentCzk: 14_500,
    note: 'První kontakt; hledá menší ateliér s denním světlem.',
    owner: 'external',
    premises: 'Nájem ateliéru ve 3. patře, měsíční nájemné',
    stage: 'LEAD',
    title: 'Ateliér Riverside – Ing. Pavel Šťastný',
  },
  {
    close: '2026-12-31',
    customer: 'Fyzioterapie Pohyb s.r.o.',
    monthlyRentCzk: 41_000,
    note: 'Jedná Vedení; řeší stavební úpravy ordinace.',
    owner: 'management',
    premises: 'Nájem prostoru pro ordinaci v přízemí, měsíční nájemné',
    stage: 'NEGOTIATION',
    title: 'Ordinace v přízemí – Fyzioterapie Pohyb',
  },
];

const Empty = Schema.Struct({});
const Opportunity = Schema.Struct({
  id: Schema.String,
  ownerEmployeeId: Schema.optionalKey(Schema.String),
  title: Schema.String,
});
const Pipeline = Schema.Struct({ items: Schema.Array(Opportunity), revision: Schema.Int });
const Employees = Schema.Struct({
  items: Schema.Array(Schema.Struct({ active: Schema.Boolean, email: Schema.optionalKey(Schema.String), id: Schema.String })),
});
const CrmRecords = Schema.Struct({
  state: Schema.Struct({
    clients: Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          partyRef: Schema.optionalKey(Schema.Struct({ partyId: Schema.optionalKey(Schema.String) })),
        }),
      ),
    }),
  }),
});
const Customers = Schema.Struct({
  items: Schema.Array(Schema.Struct({ displayName: Schema.NullOr(Schema.String), partyId: Schema.String })),
});
const ListRequest = Schema.Struct({ includeArchived: Schema.Boolean, limit: Schema.Int });
const ApplyPayload = Schema.Struct({ command: CreateOpportunityCommandSchema, expectedRevision: Schema.Int });
const Revision = Schema.Struct({ revision: Schema.Int });

const moduleAccess = toModuleAccessObjectId(demoTenantId, rentalDemoLegalEntityId, moduleId) ?? '';
/** The two relationships that make one case readable by the external salesperson (schema: resource.read). */
const caseGrant = (opportunityId: string): readonly DemoRelationship[] => {
  const resourceId =
    toResourceAccessObjectId(demoTenantId, rentalDemoLegalEntityId, {
      moduleId,
      resourceId: opportunityId,
      resourceType,
    }) ?? '';
  return [
    { relation: 'module', resourceId, resourceType: 'resource', subjectId: moduleAccess, subjectType: 'module_access' },
    { relation: 'reader', resourceId, resourceType: 'resource', subjectId: externalPrincipalId, subjectType: 'principal' },
  ];
};

const writeGrants = (granted: readonly string[], revoked: readonly string[]) =>
  Effect.gen(function* write() {
    const configuration = yield* loadSpiceDbConfig({
      envPath: process.env.ONTOS_DEMO_ENV_FILE ?? new URL('../../.env', import.meta.url).pathname,
    });
    if (
      configuration.deploymentEnvironment !== 'development' ||
      !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/u.test(configuration.endpoint)
    ) {
      return yield* new DemoSeedError({ reason: 'This demo grant helper requires local development SpiceDB.' });
    }
    const client = yield* Effect.acquireRelease(
      Effect.try(() => openSpiceDbGrpcRpc(configuration, 5000)),
      (value) => Effect.sync(() => value.close()),
    );
    const touch = bootstrapRelationshipRequest(granted.flatMap(caseGrant));
    // Revoking removes only the reader relation; the case object keeps its module link.
    const revoke = bootstrapRelationshipRequest(
      revoked.flatMap((id) => caseGrant(id).filter(({ relation }) => relation === 'reader')),
    ).updates.map((update) =>
      v1.RelationshipUpdate.create({ ...update, operation: v1.RelationshipUpdate_Operation.DELETE }),
    );
    yield* client.writeRelationships(v1.WriteRelationshipsRequest.create({ updates: [...touch.updates, ...revoke] }));
  }).pipe(Effect.scoped);

const main = Effect.gen(function* seedCases() {
  const shellUrl = yield* Config.String('ONTOS_DEMO_SEED_URL').pipe(Config.withDefault('http://localhost:3020'));
  const password = yield* Config.Redacted('ONTOS_DEMO_PASSWORD').pipe(
    Config.withDefault(Redacted.make('password1234')),
  );
  if (externalPrincipalId === '') {
    return yield* new DemoSeedError({ reason: `Siampark persona ${externalEmail} is missing.` });
  }
  const client = yield* connectSeedClient(
    { legalEntityId: rentalDemoLegalEntityId, shellUrl, tenantId: demoTenantId },
    managementEmail,
    password,
  );
  const employees = (yield* client.call('workforce', '/reads/records', Empty, {}, Employees)).items;
  const employeeOf = (email: string) => employees.find((entry) => entry.active && entry.email === email)?.id;
  const owners = { external: employeeOf(externalEmail), management: employeeOf(managementEmail) };
  if (owners.external === undefined) {
    return yield* new DemoSeedError({ reason: 'Siampark has no active employee record for external@siampark.demo.' });
  }
  const crmClients = (yield* client.call('crm', '/reads/records', Empty, {}, CrmRecords)).state.clients.items;
  const customers = (yield* client.call(
    'party-registry',
    '/reads/customer-list',
    ListRequest,
    { includeArchived: false, limit: 500 },
    Customers,
  )).items;
  const partyOf = (name: string) =>
    crmClients.find((entry) => entry.name === name)?.partyRef?.partyId ??
    customers.find((entry) => entry.displayName === name)?.partyId;

  let pipeline = yield* client.call('sales-pipeline', '/reads/records', Empty, {}, Pipeline);
  const titles = new Set(pipeline.items.map(({ title }) => title));
  for (const entry of cases) {
    if (titles.has(entry.title)) {
      continue;
    }
    const partyId = partyOf(entry.customer);
    if (partyId === undefined) {
      yield* Console.log(`- ${entry.title}: zákazník ${entry.customer} není v Party Registry, přeskočeno`);
      continue;
    }
    const owner = owners[entry.owner];
    const payload = yield* Schema.decodeUnknownEffect(ApplyPayload)({
      command: {
        _tag: 'CreateOpportunity',
        expectedCloseDate: entry.close,
        lines: [{ productName: entry.premises, quantity: 12, unitPriceMinor: entry.monthlyRentCzk * 100, vatRate: 21 }],
        note: entry.note,
        ...(owner === undefined ? {} : { ownerEmployeeId: owner }),
        partyId,
        stage: entry.stage,
        title: entry.title,
      },
      expectedRevision: pipeline.revision,
    });
    const result = yield* client.call(
      'sales-pipeline',
      '/sales-pipeline/actions/apply-command',
      ApplyPayload,
      payload,
      Revision,
      true,
    );
    pipeline = { ...pipeline, revision: result.revision };
    yield* Console.log(`+ ${entry.title} (${DateTime.formatIsoDateUtc(yield* DateTime.now)})`);
  }
  pipeline = yield* client.call('sales-pipeline', '/reads/records', Empty, {}, Pipeline);
  const entrusted = pipeline.items.filter(({ ownerEmployeeId }) => ownerEmployeeId === owners.external);
  const others = pipeline.items.filter(({ ownerEmployeeId }) => ownerEmployeeId !== owners.external);
  yield* writeGrants(
    entrusted.map(({ id }) => id),
    others.map(({ id }) => id),
  );
  yield* Console.log(
    `Siampark obchodní případy: ${pipeline.items.length}; svěřeno ${externalEmail}: ${entrusted.map(({ title }) => title).join(', ')}.`,
  );
});

NodeRuntime.runMain(
  main.pipe(
    Effect.catchTag('DemoSeedError', (error: DemoSeedError) => Console.error(`Chyba: ${error.reason}`)),
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, ConfigProvider.layer(ConfigProvider.fromEnv())),
    ),
  ),
);
