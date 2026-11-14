#!/usr/bin/env node
/** Reviewed Nájempark opportunity data through public owner Reads/Actions. No authorization writes. */
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Console, DateTime, Effect, Exit, FileSystem, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';

import { ApplyCommandPayloadSchema } from '../../verticals/sales-pipeline/shared/actions/apply-command.ts';
import { PartyIdSchema } from '../../verticals/sales-pipeline/shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { EmployeeIdSchema } from '../../verticals/workforce/shared/resources/employee.ts';
import { demoId, demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';
import { siamparkRentalPersonas } from './permissions.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from './seed-checkpoint.mts';
import { ensureSeedCustomer, existingSeedCustomer, seedCustomerList } from './rental-seed-customer.mts';
import { connectSeedClient, DemoSeedError, validateSeedTarget } from './seed-client.mts';
import type { SeedClient, SeedTarget } from './seed-client.mts';

interface CaseSeed {
  /** Calendar date the case is expected to close. */
  readonly close: string;
  /** CRM client / registry customer the case belongs to. */
  readonly customer: string;
  readonly monthlyRentCzk: number;
  readonly note: string;
  readonly owner: 'external' | 'management';
  readonly personName?: { readonly firstName: string; readonly lastName: string };
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
    personName: { firstName: 'Ing. Pavel', lastName: 'Šťastný' },
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

const recordsPath = '/reads/records';
const pipelineAudience = 'sales-pipeline';
const EmployeeId = Schema.toEncoded(EmployeeIdSchema);
const PartyId = Schema.toEncoded(PartyIdSchema);
const Empty = Schema.Struct({});
const PrincipalRef = Schema.toEncoded(PrincipalRefSchema);
export const siamparkCaseEntrustedPrincipalRef = {
  principalId: siamparkRentalPersonas[3].principalId,
  tenantId: demoTenantId,
};
const Opportunity = Schema.Struct({
  entrustedPrincipalRef: Schema.optionalKey(PrincipalRef),
  id: Schema.String,
  ownerEmployeeId: Schema.optionalKey(EmployeeId),
  title: Schema.String,
});
const Pipeline = Schema.Struct({ items: Schema.Array(Opportunity), revision: Schema.Int });
const CrmRecords = Schema.Struct({
  state: Schema.Struct({
    clients: Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          kind: Schema.Literals(['organization', 'person']),
          name: Schema.String,
          partyRef: Schema.optionalKey(Schema.Struct({ partyId: PartyId })),
        }),
      ),
    }),
  }),
});
const ApplyPayload = ApplyCommandPayloadSchema;
const Revision = Schema.Struct({ revision: Schema.Int });

const validateCaseTarget = Effect.fn('Demo.validateCaseTarget')(function* validateCaseTarget(target: SeedTarget) {
  if (target.tenantId !== demoTenantId || target.legalEntityId !== rentalDemoLegalEntityId) {
    return yield* new DemoSeedError({
      reason: 'Reviewed case entrustment requires the exact Nájempark tenant and company.',
    });
  }
  return yield* Effect.void;
});
const matchesEntrustment = (opportunity: typeof Opportunity.Type, entry: CaseSeed) =>
  entry.owner === 'external'
    ? opportunity.entrustedPrincipalRef?.tenantId === siamparkCaseEntrustedPrincipalRef.tenantId &&
      opportunity.entrustedPrincipalRef.principalId === siamparkCaseEntrustedPrincipalRef.principalId
    : opportunity.entrustedPrincipalRef === undefined;

const reconcileExistingCase = Effect.fn('Demo.reconcileExistingCase')(function* reconcileExistingCase(
  client: SeedClient,
  pipeline: typeof Pipeline.Type,
  existing: typeof Opportunity.Type,
  entry: CaseSeed,
) {
  if (matchesEntrustment(existing, entry)) {
    return pipeline;
  }
  if (entry.owner !== 'external' || existing.entrustedPrincipalRef !== undefined) {
    return yield* new DemoSeedError({
      reason: `Case entrustment differs from reviewed input; preserve administrator edits: ${entry.title}.`,
    });
  }
  const payload = yield* Schema.decodeUnknownEffect(ApplyPayload)({
    command: {
      _tag: 'UpdateOpportunity',
      id: existing.id,
      patch: { entrustedPrincipalRef: siamparkCaseEntrustedPrincipalRef },
    },
    expectedRevision: pipeline.revision,
  });
  const result = yield* client.call(
    pipelineAudience,
    '/sales-pipeline/actions/apply-command',
    ApplyPayload,
    payload,
    Revision,
    true,
  );
  return { items: pipeline.items, revision: result.revision };
});

export const seedSiamparkCaseRecords = Effect.fn('Demo.seedSiamparkCaseRecords')(function* seedCaseRecords(
  client: SeedClient,
  target: SeedTarget,
  owners: Readonly<Record<'external' | 'management', string>>,
  checkpointDirectory: string,
) {
  yield* validateCaseTarget(target);
  const fs = yield* FileSystem.FileSystem;
  const crmClients = (yield* client.call('crm', recordsPath, Empty, {}, CrmRecords)).state.clients.items;
  const customers = yield* seedCustomerList(client);
  let pipeline = yield* client.call(pipelineAudience, recordsPath, Empty, {}, Pipeline);
  for (const entry of cases) {
    if (pipeline.items.filter(({ title }) => title === entry.title).length > 1) {
      return yield* new DemoSeedError({ reason: `Duplicate reviewed case fixture: ${entry.title}.` });
    }
  }
  for (const entry of cases) {
    const existing = pipeline.items.find(({ title }) => title === entry.title);
    if (existing !== undefined) {
      pipeline = yield* reconcileExistingCase(client, pipeline, existing, entry);
      continue;
    }
    const matchingClients = crmClients.filter(({ name }) => name === entry.customer);
    const [crmClient] = matchingClients;
    if (matchingClients.length !== 1 || crmClient === undefined) {
      return yield* new DemoSeedError({ reason: `Expected one Nájempark CRM fixture for ${entry.customer}.` });
    }
    const customer = yield* existingSeedCustomer(customers, entry.customer);
    let partyId = crmClient.partyRef?.partyId ?? customer?.partyRef.resourceId;
    if (partyId === undefined) {
      yield* fs.makeDirectory(checkpointDirectory, { recursive: true });
      const created = yield* ensureSeedCustomer(
        client,
        target,
        path.join(checkpointDirectory, `${demoId('siampark.case.customer', entry.customer)}.json`),
        {
          evidenceKey: demoId('siampark.case.customer', entry.customer),
          name: entry.customer,
          partyType: crmClient.kind === 'person' ? 'PERSON' : 'ORGANIZATION',
          personName: entry.personName,
        },
      );
      partyId = created.partyRef.resourceId;
    }
    const owner = owners[entry.owner];
    let command: Schema.Codec.Encoded<typeof ApplyPayload>['command'] = {
      _tag: 'CreateOpportunity',
      expectedCloseDate: entry.close,
      lines: [{ productName: entry.premises, quantity: 12, unitPriceMinor: entry.monthlyRentCzk * 100, vatRate: 21 }],
      note: entry.note,
      ownerEmployeeId: owner,
      partyId,
      stage: entry.stage,
      title: entry.title,
    };
    if (entry.owner === 'external') {
      command = { ...command, entrustedPrincipalRef: siamparkCaseEntrustedPrincipalRef };
    }
    const payload = yield* Schema.decodeUnknownEffect(ApplyPayload)({
      command,
      expectedRevision: pipeline.revision,
    });
    const result = yield* client.call(
      pipelineAudience,
      '/sales-pipeline/actions/apply-command',
      ApplyPayload,
      payload,
      Revision,
      true,
    );
    pipeline = { items: pipeline.items, revision: result.revision };
    yield* Console.log(`+ ${entry.title} (${DateTime.formatIsoDateUtc(yield* DateTime.now)})`);
  }
  pipeline = yield* client.call(pipelineAudience, recordsPath, Empty, {}, Pipeline);
  for (const entry of cases) {
    const matched = pipeline.items.filter(({ title }) => title === entry.title);
    if (matched.length !== 1 || matched[0] === undefined || !matchesEntrustment(matched[0], entry)) {
      return yield* new DemoSeedError({ reason: `Nájempark case fixture is missing or duplicated: ${entry.title}.` });
    }
  }
  return pipeline;
});

/** The real reviewed human performs the native seed. Role/field gates and owner target checks remain authoritative. */
export const seedSiamparkCaseEntrustment = (apply: boolean) =>
  Effect.gen(function* seedCaseEntrustment() {
    const shellUrl = yield* Config.String('ONTOS_DEMO_SEED_URL');
    const email = yield* Config.String('ONTOS_DEMO_SEED_EMAIL');
    const password = yield* Config.Redacted('ONTOS_DEMO_SEED_PASSWORD');
    const target = { legalEntityId: rentalDemoLegalEntityId, shellUrl, tenantId: demoTenantId };
    yield* validateCaseTarget(target);
    yield* validateSeedTarget(target);
    const fs = yield* FileSystem.FileSystem;
    const root = yield* Config.String('ONTOS_DEMO_SEED_CHECKPOINT_DIR').pipe(Config.withDefault('.scratch/demo-seed'));
    const directory = seedCheckpointDirectory(target, root);
    const client = yield* Effect.acquireRelease(
      connectSeedClient(target, email, password, seedWriteCheckpoint(fs, directory)),
      (session) => session.signOut.pipe(Effect.ignore),
    );
    if (!apply) {
      const pipeline = yield* client.call(pipelineAudience, recordsPath, Empty, {}, Pipeline);
      yield* Console.log({ current: pipeline.items.length, mode: 'dry-run', reviewed: cases.length, target });
      return;
    }
    yield* seedSiamparkCaseRecords(
      client,
      target,
      {
        external: demoId('workforce.employee', 'siampark-external'),
        management: demoId('workforce.employee', 'siampark-management'),
      },
      directory,
    );
  });

const command = Command.make(
  'seed-siampark-cases',
  {
    apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
  },
  ({ apply }) => seedSiamparkCaseEntrustment(apply).pipe(Effect.scoped),
);
if (import.meta.main) {
  const runtime = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
  const result = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtime)));
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
