import { cancelStageQaOrder } from '../demo/cancel-stage-qa-order.mts';
import { MerchandiseCommandSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import {
  MerchandiseStateSchema,
  RecordsRequestSchema as MerchandiseRead,
} from '../../verticals/merchandise/shared/apis/records.ts';
import { evolveMerchandiseState } from '../../verticals/merchandise/src/services/persistence.service.ts';
import { computeProductRecords } from '../../verticals/merchandise/src/services/stock-levels.ts';
import { buildAkrosEncoded } from '../../verticals/merchandise/scripts/akros-catalog.mts';
import { seedAkrosStock } from '../demo/seed-akros-stock.mts';
import { applyImportsCommand, ImportsCommandSchema } from '../../verticals/crm/shared/commands/imports.ts';
import { CrmStateSchema, initialCrmState } from '../../verticals/crm/shared/domain/state.ts';
import { orderDateText } from '../../verticals/crm/shared/domain/imports.ts';
import { CrmViewerSchema } from '../../verticals/crm/shared/domain/access.ts';
import { WorkforceCommandSchema } from '../../verticals/workforce/shared/actions/apply-command.ts';
import { WorkforceStateSchema } from '../../verticals/workforce/shared/apis/records.ts';
import { evolveEmployeeState } from '../../verticals/workforce/src/services/persistence.service.ts';
import { seedCompanyEmployees } from '../demo/seed-company-employees.mts';
import type { FinanceState } from '../../verticals/finance-billing/shared/apis/records.ts';
import { FinanceCommandSchema } from '../../verticals/finance-billing/shared/actions/apply-command.ts';
import { RecordsResponseSchema as FinanceRecords } from '../../verticals/finance-billing/shared/apis/records.ts';
import {
  projectFinanceRecords,
  transitionFinance,
} from '../../verticals/finance-billing/src/services/persistence.service.ts';
import { NodeServices } from '@effect/platform-node';
import { CounterpartyRefSchema } from '../../verticals/party-registry/shared/resources/counterparty.ts';
import { PartyRefSchema } from '../../verticals/party-registry/shared/resources/party.ts';
import { PartyIdSchema } from '../../verticals/sales-pipeline/shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { EmployeeIdSchema } from '../../verticals/workforce/shared/resources/employee.ts';
import { Array as EffectArray, DateTime, Effect, FileSystem, Match, Order, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { demoId } from '../demo/fixture-ids.mts';
import { rentalCrmOrderPlan, seedRentalCrmOrders } from '../demo/rental-crm-orders.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from '../demo/seed-checkpoint.mts';
import { ensureSeedCustomer, existingSeedCustomer } from '../demo/rental-seed-customer.mts';
import { seedSiamparkCaseRecords } from '../demo/seed-siampark-cases.mts';
import {
  ensureInvoice,
  rentalInvoicePlan,
  rentalStory,
  requireSeedMatch,
  uniqueSeedRecord,
} from '../demo/rental-seed.mts';
import { connectSeedClient, DemoSeedError, validateSeedTarget } from '../demo/seed-client.mts';

const ownerApi = '/owner-api';
const applyCommandPath = '/actions/apply-command';
const recordsPath = '/reads/records';
const seedTestInstant = '2026-10-23T12:00:00Z';
const seedTestDate = '2026-10-23';
const revisionFixture = 'revision-fixture';
const propertyAudience = 'property-portfolio';
const partyModule = 'party.registry';
const partyResource = 'party.registry.party';
const counterpartyResource = 'party.registry.counterparty';
const target = {
  legalEntityId: '71000000-0000-4000-8000-000000000021',
  shellUrl: 'https://demo.example.test',
  tenantId: '70000000-0000-4000-8000-000000000020',
};
const gatewayPath = '/shell-super-app-api/auth/gateway-context';
const Empty = Schema.Struct({});
const Revision = Schema.Struct({ revision: Schema.Int });

it.effect('accepts HTTPS and loopback, rejects insecure remote origins and embedded credentials', () =>
  Effect.gen(function* originValidation() {
    for (const shellUrl of [target.shellUrl, 'http://localhost:3020', 'http://127.0.0.1:3020']) {
      expect(yield* validateSeedTarget({ ...target, shellUrl })).toBe(shellUrl);
    }
    for (const shellUrl of [
      'http://server.test',
      'https://user:secret@demo.test',
      'https://demo.test/path',
      'https://demo.test?token=secret',
    ]) {
      expect(Schema.is(DemoSeedError)(yield* validateSeedTarget({ ...target, shellUrl }).pipe(Effect.flip))).toBe(true);
    }
  }),
);

it.effect('refuses duplicate fixture keys and mismatching records without overwriting them', () =>
  Effect.gen(function* collisionChecks() {
    expect(yield* uniqueSeedRecord('Property', [])).toBeUndefined();
    expect(yield* uniqueSeedRecord('Property', ['record'])).toBe('record');
    expect(Schema.is(DemoSeedError)(yield* uniqueSeedRecord('Property', ['one', 'two']).pipe(Effect.flip))).toBe(true);
    expect(Schema.is(DemoSeedError)(yield* requireSeedMatch('Invoice', false).pipe(Effect.flip))).toBe(true);
    yield* requireSeedMatch('Invoice', true);
    const failure = yield* existingSeedCustomer([
      {
        counterpartyRef: {
          moduleId: partyModule,
          resourceId: target.legalEntityId,
          resourceType: counterpartyResource,
          tenantId: target.tenantId,
        },
        displayName: 'Ukázkový nájemce Nájempark',
        partyRef: {
          moduleId: partyModule,
          resourceId: target.legalEntityId,
          resourceType: partyResource,
          tenantId: target.tenantId,
        },
        status: 'ARCHIVED',
      },
    ]).pipe(Effect.flip);
    expect(Schema.is(DemoSeedError)(failure)).toBe(true);
  }),
);

it.effect('retains a legacy rental customer identity and refuses old/new-name duplicates after the rebrand', () =>
  Effect.gen(function* preservesRebrandedCustomerIdentity() {
    const existing: Parameters<typeof existingSeedCustomer>[0][number] = {
      counterpartyRef: {
        moduleId: partyModule,
        resourceId: target.legalEntityId,
        resourceType: counterpartyResource,
        tenantId: target.tenantId,
      },
      displayName: 'Ukázkový nájemce Siampark',
      partyRef: {
        moduleId: partyModule,
        resourceId: target.legalEntityId,
        resourceType: partyResource,
        tenantId: target.tenantId,
      },
      status: 'ACTIVE',
    };
    expect(yield* existingSeedCustomer([existing])).toEqual(existing);
    const duplicate = { ...existing, displayName: 'Ukázkový nájemce Nájempark' };
    const failure = yield* existingSeedCustomer([existing, duplicate]).pipe(Effect.flip);
    expect(Schema.is(DemoSeedError)(failure)).toBe(true);
  }),
);

const sessionResponse = (pathname: string, tenantId = target.tenantId) => {
  if (pathname.endsWith('/sign-in')) {
    return Response.json({}, { headers: { 'set-cookie': 'seed-session=fixture; Path=/; HttpOnly' } });
  }
  if (pathname.endsWith('/session')) {
    return Response.json({ identity: { legalEntityId: target.legalEntityId, tenantId }, state: 'authenticated' });
  }
  if (pathname.endsWith('/composition')) {
    return Response.json({ compositionRevision: revisionFixture, state: 'available' });
  }
  return Response.json({});
};
const connect = () => connectSeedClient(target, 'operator@example.test', Redacted.make('fixture-password'));

it.effect('resumes customer onboarding after an owner failure without creating a second Party', () =>
  Effect.gen(function* interruptedOnboarding() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'rental-seed-test-' });
    const checkpointPath = `${directory}/customer.json`;
    const partyRef = {
      moduleId: partyModule,
      resourceId: target.legalEntityId,
      resourceType: partyResource,
      tenantId: target.tenantId,
    };
    const counterpartyRef = { ...partyRef, resourceType: counterpartyResource };
    let creates = 0;
    let onboards = 0;
    const http = HttpClient.make((request, url) => {
      let response: Response;
      if (url.pathname === gatewayPath) {
        response = Response.json({
          apiBaseUrl: ownerApi,
          compositionRevision: revisionFixture,
          token: 'fixture-assertion',
        });
      } else if (url.pathname.endsWith('/reads/customer-list')) {
        response = Response.json({ items: [] });
      } else if (url.pathname.endsWith('/actions/create-party')) {
        creates += 1;
        response = Response.json({
          decisionRef: { ...partyRef, resourceType: 'party.registry.party-match-decision' },
          outcome: 'CREATED',
          partyRef,
        });
      } else if (url.pathname.endsWith('/actions/counterparty-customer-onboard')) {
        onboards += 1;
        response =
          onboards === 1
            ? Response.json({}, { status: 503 })
            : Response.json({
                counterpartyCreated: true,
                counterpartyRef,
                legalEntityRef: {
                  moduleId: 'core.identity',
                  resourceId: target.legalEntityId,
                  resourceType: 'core.identity.legal-entity',
                  tenantId: target.tenantId,
                },
                partyRef,
                rolePeriodCreated: true,
                rolePeriodRef: { ...partyRef, resourceType: 'party.registry.counterparty-role-period' },
                roleType: 'CUSTOMER',
                validFrom: '2026-10-05T00:00:00.000Z',
                validTo: null,
              });
      } else {
        response = sessionResponse(url.pathname);
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    });
    yield* Effect.gen(function* retryRemainingStep() {
      const client = yield* connect();
      const failure = yield* ensureSeedCustomer(client, target, checkpointPath).pipe(Effect.flip);
      expect(Schema.is(DemoSeedError)(failure)).toBe(true);
      expect(yield* fs.exists(checkpointPath)).toBe(true);
      expect((yield* ensureSeedCustomer(client, target, checkpointPath)).partyRef).toEqual(partyRef);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    expect(creates).toBe(1);
    expect(onboards).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('verifies the authenticated target before issuing any owner assertion', () =>
  Effect.gen(function* wrongTenant() {
    const paths: string[] = [];
    const http = HttpClient.make((request, url) => {
      paths.push(url.pathname);
      return Effect.succeed(HttpClientResponse.fromWeb(request, sessionResponse(url.pathname, 'other-tenant')));
    });
    const failure = yield* connect().pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip);
    expect(Schema.is(DemoSeedError)(failure)).toBe(true);
    expect(paths).not.toContain(gatewayPath);
  }),
);

it.effect('issues fresh assertions, including separate assertions for two reads from the same reference owner', () =>
  Effect.gen(function* referenceAssertions() {
    let assertions = 0;
    const authorizations: string[] = [];
    const referenceHeaders: string[] = [];
    const http = HttpClient.make((request, url) => {
      if (url.pathname === gatewayPath) {
        assertions += 1;
        expect(request.headers.cookie).toContain('seed-session=fixture');
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              apiBaseUrl: ownerApi,
              compositionRevision: revisionFixture,
              token: `assertion-${assertions}`,
            }),
          ),
        );
      }
      if (url.pathname.startsWith(ownerApi)) {
        authorizations.push(request.headers.authorization ?? 'missing');
        referenceHeaders.push(request.headers['x-ontos-reference-credentials'] ?? '');
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ revision: 4 })));
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, sessionResponse(url.pathname)));
    });
    yield* Effect.gen(function* calls() {
      const client = yield* connect();
      yield* client.read(propertyAudience, Revision);
      yield* client.call('legal-agreements', '/action', Empty, {}, Revision, true, [
        propertyAudience,
        propertyAudience,
      ]);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    expect(authorizations).toEqual(['Bearer assertion-1', 'Bearer assertion-2']);
    expect(referenceHeaders[1]).toContain('Bearer assertion-3');
    expect(referenceHeaders[1]).toContain('Bearer assertion-4');
  }),
);

it.effect('does not retry a conflicting write and preserves the revision used to select the fixture', () =>
  Effect.gen(function* revisionConflict() {
    const writes: string[] = [];
    const http = HttpClient.make((request, url) => {
      if (url.pathname === gatewayPath) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ apiBaseUrl: ownerApi, compositionRevision: revisionFixture, token: 'assertion' }),
          ),
        );
      }
      if (url.pathname.startsWith(ownerApi)) {
        writes.push(
          Match.value(request.body).pipe(
            Match.tag('Uint8Array', ({ body }) => new TextDecoder().decode(body)),
            Match.orElse(() => 'missing'),
          ),
        );
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ privateDiagnostic: 'never-log-this' }, { status: 409 })),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, sessionResponse(url.pathname)));
    });
    const failure = yield* Effect.gen(function* write() {
      const client = yield* connect();
      return yield* client.apply(propertyAudience, Empty, {}, 7);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip);
    expect(Schema.is(DemoSeedError)(failure)).toBe(true);
    expect(writes).toEqual(['{"command":{},"expectedRevision":7}']);
    expect(String(failure)).not.toContain('never-log-this');
  }),
);

it.effect('stops at denied authorization without sending a write to an owner', () =>
  Effect.gen(function* deniedGateway() {
    const ownerPaths: string[] = [];
    const http = HttpClient.make((request, url) => {
      if (url.pathname === gatewayPath) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 403 })));
      }
      if (url.pathname.startsWith(ownerApi)) {
        ownerPaths.push(url.pathname);
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, sessionResponse(url.pathname)));
    });
    const failure = yield* Effect.gen(function* write() {
      const client = yield* connect();
      return yield* client.apply(propertyAudience, Empty, {}, 0);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip);
    expect(Schema.is(DemoSeedError)(failure)).toBe(true);
    expect(ownerPaths).toEqual([]);
  }),
);

const caseClients = [
  { kind: 'organization', name: 'Kavárna Na Nábřeží s.r.o.' },
  { kind: 'organization', name: 'Advokátní kancelář Horák & partneři' },
  { kind: 'person', name: 'Ing. Pavel Šťastný' },
  { kind: 'organization', name: 'Fyzioterapie Pohyb s.r.o.' },
] as const;
const caseOwners = { external: demoId('seed.employee', 'external'), management: demoId('seed.employee', 'management') };
const CaseCandidate = Schema.Struct({
  candidate: Schema.Struct({
    displayName: Schema.String,
    partyType: Schema.Literals(['ORGANIZATION', 'PERSON']),
    subjectEvidence: Schema.Array(Schema.Struct({ observedSubject: Schema.String })),
  }),
});
const CasePartyRef = Schema.toEncoded(PartyRefSchema);
const CaseCounterpartyRef = Schema.toEncoded(CounterpartyRefSchema);
const CaseCommand = Schema.Struct({
  command: Schema.Struct({
    ownerEmployeeId: Schema.toEncoded(EmployeeIdSchema),
    partyId: Schema.toEncoded(PartyIdSchema),
    title: Schema.String,
  }),
  expectedRevision: Schema.Int,
});
const decodeSeedBody = <A, E>(schema: Schema.Codec<A, E>, body: string): A =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(body);
const expectReferenceAudiences = (encoded: string | undefined, audiences: readonly string[]) =>
  Effect.sync(() => {
    const credentials = decodeSeedBody(Schema.Array(Schema.Struct({ audience: Schema.String })), encoded ?? '[]');
    expect(credentials.map(({ audience }) => audience)).toEqual(audiences);
  });
const caseFixture = (options: { readonly failOnboardingOnce?: boolean; readonly missingClient?: boolean } = {}) => {
  const customers: {
    readonly counterpartyRef: typeof CaseCounterpartyRef.Type;
    readonly displayName: string;
    readonly partyRef: typeof CasePartyRef.Type;
    readonly status: string;
  }[] = [];
  const parties: { readonly candidate: typeof CaseCandidate.Type.candidate; readonly ref: typeof CasePartyRef.Type }[] =
    [];
  const items: {
    readonly id: string;
    readonly ownerEmployeeId: string;
    readonly partyId: string;
    readonly title: string;
  }[] = [];
  let onboards = 0;
  const http = HttpClient.make((request, url) => {
    const body = Match.value(request.body).pipe(
      Match.tag('Uint8Array', ({ body: bytes }) => new TextDecoder().decode(bytes)),
      Match.orElse(() => '{}'),
    );
    let response: Response;
    if (url.pathname === gatewayPath) {
      const { audience } = decodeSeedBody(Schema.Struct({ audience: Schema.String }), body);
      response = Response.json({
        apiBaseUrl: `${ownerApi}/${audience}`,
        compositionRevision: revisionFixture,
        token: 'case-fixture-assertion',
      });
    } else if (url.pathname.endsWith('/crm/reads/records')) {
      response = Response.json({
        state: { clients: { items: options.missingClient === true ? caseClients.slice(1) : caseClients } },
      });
    } else if (url.pathname.endsWith('/reads/customer-list')) {
      response = Response.json({ items: customers });
    } else if (url.pathname.endsWith('/actions/create-party')) {
      const { candidate } = decodeSeedBody(CaseCandidate, body);
      const ref: typeof CasePartyRef.Type = {
        moduleId: partyModule,
        resourceId: demoId('seed.case.party', candidate.displayName),
        resourceType: partyResource,
        tenantId: target.tenantId,
      };
      parties.push({ candidate, ref });
      response = Response.json({
        decisionRef: { ...ref, resourceType: 'party.registry.party-match-decision' },
        outcome: 'CREATED',
        partyRef: ref,
      });
    } else if (url.pathname.endsWith('/actions/counterparty-customer-onboard')) {
      onboards += 1;
      const { partyRef } = decodeSeedBody(Schema.Struct({ partyRef: CasePartyRef }), body);
      const party = parties.find(({ ref }) => ref.resourceId === partyRef.resourceId);
      expect(party).toBeDefined();
      const counterpartyRef: typeof CaseCounterpartyRef.Type = { ...partyRef, resourceType: counterpartyResource };
      if (options.failOnboardingOnce === true && onboards === 1) {
        response = Response.json({}, { status: 503 });
      } else {
        customers.push({
          counterpartyRef,
          displayName: party?.candidate.displayName ?? '',
          partyRef,
          status: 'ACTIVE',
        });
        response = Response.json({
          counterpartyCreated: true,
          counterpartyRef,
          legalEntityRef: {
            moduleId: 'core.identity',
            resourceId: target.legalEntityId,
            resourceType: 'core.identity.legal-entity',
            tenantId: target.tenantId,
          },
          partyRef,
          rolePeriodCreated: true,
          rolePeriodRef: { ...partyRef, resourceType: 'party.registry.counterparty-role-period' },
          roleType: 'CUSTOMER',
          validFrom: '2026-10-05T00:00:00.000Z',
          validTo: null,
        });
      }
    } else if (url.pathname.endsWith(applyCommandPath)) {
      const { command, expectedRevision } = decodeSeedBody(CaseCommand, body);
      expect(customers.some(({ partyRef }) => partyRef.resourceId === command.partyId)).toBe(true);
      expect(expectedRevision).toBe(items.length);
      items.push({ ...command, id: demoId('seed.case', command.title) });
      response = Response.json({ revision: items.length });
    } else if (url.pathname.endsWith('/sales-pipeline/reads/records')) {
      response = Response.json({ items, revision: items.length });
    } else {
      response = sessionResponse(url.pathname);
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return { customers, http, items, parties };
};

it.effect('a clean CRM-only bootstrap creates all four native customers before cases and keeps the person kind', () =>
  Effect.gen(function* seedsCompleteCaseDataset() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'siampark-case-seed-' });
    const fixture = caseFixture();
    yield* Effect.gen(function* nativeCases() {
      const client = yield* connect();
      const first = yield* seedSiamparkCaseRecords(client, target, caseOwners, directory);
      expect(first.items).toHaveLength(4);
      expect(first.items.filter(({ ownerEmployeeId }) => ownerEmployeeId === caseOwners.external)).toHaveLength(3);
      expect((yield* seedSiamparkCaseRecords(client, target, caseOwners, directory)).items).toEqual(first.items);
    }).pipe(Effect.provideService(HttpClient.HttpClient, fixture.http));
    expect(fixture.customers).toHaveLength(4);
    expect(fixture.parties).toHaveLength(4);
    expect(fixture.items).toHaveLength(4);
    expect(fixture.parties.map(({ candidate }) => candidate.partyType)).toEqual([
      'ORGANIZATION',
      'ORGANIZATION',
      'PERSON',
      'ORGANIZATION',
    ]);
    expect(
      fixture.parties.every(({ candidate }) => candidate.subjectEvidence[0]?.observedSubject === candidate.partyType),
    ).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('an interrupted case customer onboarding fails and resumes its native Party instead of duplicating it', () =>
  Effect.gen(function* resumesCaseCustomer() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'siampark-case-retry-' });
    const fixture = caseFixture({ failOnboardingOnce: true });
    yield* Effect.gen(function* nativeRetry() {
      const client = yield* connect();
      expect(
        Schema.is(DemoSeedError)(
          yield* seedSiamparkCaseRecords(client, target, caseOwners, directory).pipe(Effect.flip),
        ),
      ).toBe(true);
      expect(fixture.items).toHaveLength(0);
      expect((yield* seedSiamparkCaseRecords(client, target, caseOwners, directory)).items).toHaveLength(4);
    }).pipe(Effect.provideService(HttpClient.HttpClient, fixture.http));
    expect(fixture.parties).toHaveLength(4);
    expect(fixture.customers).toHaveLength(4);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('missing CRM fixture data fails the case seed rather than silently reporting a partial success', () =>
  Effect.gen(function* rejectsIncompleteCrm() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'siampark-case-missing-' });
    const fixture = caseFixture({ missingClient: true });
    yield* Effect.gen(function* noPartialCases() {
      const client = yield* connect();
      const failure = yield* seedSiamparkCaseRecords(client, target, caseOwners, directory).pipe(Effect.flip);
      expect(Schema.is(DemoSeedError)(failure)).toBe(true);
      expect((yield* Schema.decodeUnknownEffect(DemoSeedError)(failure)).reason).toContain(
        'Expected one Nájempark CRM fixture',
      );
    }).pipe(Effect.provideService(HttpClient.HttpClient, fixture.http));
    expect(fixture.parties).toHaveLength(0);
    expect(fixture.items).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it('keeps invoices and CRM orders in four rolling months, including at year rollover', () => {
  const asOf = DateTime.toDateUtc(DateTime.makeUnsafe('2027-01-02T12:00:00Z'));
  const invoices = rentalInvoicePlan(asOf);
  const orders = rentalCrmOrderPlan(asOf);
  expect(invoices).toHaveLength(12);
  expect(new Set(invoices.map((invoice) => invoice.documentNumber)).size).toBe(12);
  expect([...new Set(invoices.map((invoice) => invoice.issueDate.slice(0, 7)))]).toEqual([
    '2026-10',
    '2026-11',
    '2026-12',
    '2027-01',
  ]);
  expect(invoices.filter((invoice) => invoice.paid)).toHaveLength(9);
  expect(invoices.some((invoice) => !invoice.paid && invoice.dueDate < '2027-01-02')).toBe(true);
  expect(orders).toHaveLength(12);
  expect(orders.filter((order) => order.orderedOn.startsWith('2027-01'))).toHaveLength(3);
  expect(orders.every((order) => order.orderedOn <= '2027-01-02')).toBe(true);
  expect(new Set(orders.map((order) => order.externalId)).size).toBe(12);
  expect(rentalInvoicePlan(asOf)).toEqual(invoices);
  expect(rentalCrmOrderPlan(asOf)).toEqual(orders);
});

it.effect('persists a write identity before dispatch and reuses it across client recreation', () =>
  Effect.gen(function* durableWriteIdentity() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'seed-write-checkpoint-' });
    const directory = seedCheckpointDirectory(target, root);
    const checkpoint = seedWriteCheckpoint(fs, directory);
    const audience = 'finance-billing';
    const route = '/apply';
    const payload = '{"expectedRevision":1}';
    const key = yield* checkpoint(audience, route, payload);
    expect(yield* seedWriteCheckpoint(fs, directory)(audience, route, payload)).toBe(key);
    expect(yield* checkpoint(audience, route, '{"expectedRevision":2}')).not.toBe(key);
    expect(seedCheckpointDirectory({ ...target, legalEntityId: demoId('test', 'other-company') }, root)).not.toBe(
      directory,
    );
    const files = yield* fs.readDirectory(`${directory}/writes`);
    for (const file of files) {
      yield* fs.writeFileString(`${directory}/writes/${file}`, '{}');
    }
    expect(Schema.is(DemoSeedError)(yield* checkpoint(audience, route, payload).pipe(Effect.flip))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  'resumes a native confirmed invoice after a lost payment response without a second invoice, payment or budget',
  () =>
    Effect.gen(function* nativeFinanceResume() {
      let state: FinanceState = { financialPlanEntries: [], invoices: [] };
      let revision = 0;
      let losePaymentResponse = true;
      const writes: string[] = [];
      const now = DateTime.makeUnsafe(seedTestInstant);
      const http = HttpClient.make((request, url) =>
        Effect.gen(function* ownerRequest() {
          if (url.pathname === gatewayPath) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ apiBaseUrl: ownerApi, compositionRevision: revisionFixture, token: 'finance-test' }),
            );
          }
          if (url.pathname.endsWith(recordsPath)) {
            const records = { ...projectFinanceRecords(state, revision, {}, seedTestDate), canWrite: true };
            return HttpClientResponse.fromWeb(request, Response.json(Schema.encodeSync(FinanceRecords)(records)));
          }
          if (url.pathname.endsWith(applyCommandPath)) {
            const body = Match.value(request.body).pipe(
              Match.tag('Uint8Array', ({ body: bytes }) => new TextDecoder().decode(bytes)),
              Match.orElse(() => '{}'),
            );
            const payload = decodeSeedBody(
              Schema.Struct({ command: FinanceCommandSchema, expectedRevision: Schema.Int }),
              body,
            );
            expect(payload.expectedRevision).toBe(revision);
            writes.push(payload.command._tag);
            const result = yield* transitionFinance(
              state,
              payload.command,
              target,
              {
                anchors: () =>
                  expectReferenceAudiences(request.headers['x-ontos-reference-credentials'], [
                    propertyAudience,
                    propertyAudience,
                  ]),
                invoice: () =>
                  expectReferenceAudiences(request.headers['x-ontos-reference-credentials'], [
                    'party-registry',
                    propertyAudience,
                    propertyAudience,
                    'property-leasing',
                  ]),
              },
              {
                attemptId: `seed-attempt-${revision}`,
                now,
                resourceId: `seed-resource-${revision}`,
              },
            );
            ({ state } = result);
            revision += 1;
            if (
              Match.value(payload.command).pipe(
                Match.tag('RecordManualPayment', () => losePaymentResponse),
                Match.orElse(() => false),
              )
            ) {
              losePaymentResponse = false;
              return HttpClientResponse.fromWeb(request, Response.json({}, { status: 503 }));
            }
            return HttpClientResponse.fromWeb(request, Response.json({ revision }));
          }
          return HttpClientResponse.fromWeb(request, sessionResponse(url.pathname));
        }).pipe(Effect.orDie),
      );
      const propertyRef = {
        moduleId: 'property.portfolio',
        resourceId: demoId('seed.property', 'test'),
        resourceType: 'property.portfolio.property',
        tenantId: target.tenantId,
      } as const;
      const unitRef = {
        ...propertyRef,
        resourceId: demoId('seed.unit', 'test'),
        resourceType: 'property.portfolio.unit',
      } as const;
      const tenant = {
        counterpartyRef: {
          moduleId: partyModule,
          resourceId: demoId('seed.counterparty', 'test'),
          resourceType: counterpartyResource,
          tenantId: target.tenantId,
        },
        partyRef: {
          moduleId: partyModule,
          resourceId: demoId('seed.party', 'test'),
          resourceType: partyResource,
          tenantId: target.tenantId,
        },
      } as const;
      const occupancyRef = {
        moduleId: 'property.leasing',
        resourceId: demoId('seed.occupancy', 'test'),
        resourceType: 'property.leasing.occupancy',
        tenantId: target.tenantId,
      } as const;
      const [spec] = rentalInvoicePlan(DateTime.toDateUtc(now));
      yield* Effect.gen(function* seedAndResume() {
        const client = yield* connect();
        const run = () =>
          ensureInvoice(
            client,
            spec,
            rentalStory.leases[0],
            { code: 'R101', name: 'Kavárna', propertyRef, unitRef },
            tenant,
            { occupancyRef },
          );
        expect(Schema.is(DemoSeedError)(yield* run().pipe(Effect.flip))).toBe(true);
        yield* run();
        const completedWrites = writes.length;
        yield* run();
        expect(writes).toHaveLength(completedWrites);
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      expect(state.invoices).toHaveLength(1);
      expect(state.invoices[0]?.businessState).toBe('CONFIRMED');
      expect(state.invoices[0]?.paidMinor).toBe(state.invoices[0]?.totalMinor);
      expect(state.budgets).toHaveLength(1);
      expect(writes.filter((tag) => tag === 'RecordManualPayment')).toHaveLength(1);
      expect(writes).toContain('MarkInvoicesPrepared');
      expect(writes).toContain('ConfirmInvoice');
    }),
);

it.effect('imports current-month orders through the native CRM reducer and creates no second batch on rerun', () =>
  Effect.gen(function* nativeCrmOrders() {
    const now = seedTestInstant;
    const asOf = DateTime.toDateUtc(DateTime.makeUnsafe(now));
    const viewer = Schema.decodeUnknownSync(CrmViewerSchema)({
      assign: true,
      principalId: 'seed-test',
      readAll: true,
      readAssigned: false,
      writeAll: true,
      writeAssigned: false,
    });
    let state = Schema.decodeUnknownSync(CrmStateSchema)({
      ...initialCrmState,
      clients: {
        ...initialCrmState.clients,
        items: [...new Set(rentalCrmOrderPlan(asOf).map((order) => order.clientId))].map((id) => ({
          createdAt: now,
          createdBy: 'seed-test',
          id,
          kind: 'organization',
          name: 'Nájemce',
          status: 'active',
          updatedAt: now,
        })),
      },
    });
    let revision = 0;
    const http = HttpClient.make((request, url) =>
      Effect.gen(function* crmOwnerRequest() {
        if (url.pathname === gatewayPath) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ apiBaseUrl: ownerApi, compositionRevision: revisionFixture, token: 'crm-test' }),
          );
        }
        if (url.pathname.endsWith(recordsPath)) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ revision, state: Schema.encodeSync(CrmStateSchema)(state) }),
          );
        }
        if (url.pathname.endsWith(applyCommandPath)) {
          const body = Match.value(request.body).pipe(
            Match.tag('Uint8Array', ({ body: bytes }) => new TextDecoder().decode(bytes)),
            Match.orElse(() => '{}'),
          );
          const payload = decodeSeedBody(
            Schema.Struct({ command: ImportsCommandSchema, expectedRevision: Schema.Int }),
            body,
          );
          expect(payload.expectedRevision).toBe(revision);
          const result = yield* applyImportsCommand(state, payload.command, {
            invocationId: `crm-seed-${revision}`,
            now: DateTime.makeUnsafe(now),
            viewer,
          });
          ({ state } = result);
          revision += 1;
          return HttpClientResponse.fromWeb(request, Response.json({ revision }));
        }
        return HttpClientResponse.fromWeb(request, sessionResponse(url.pathname));
      }).pipe(Effect.orDie),
    );
    yield* Effect.gen(function* importAndRerun() {
      const client = yield* connect();
      expect(yield* seedRentalCrmOrders(client, asOf)).toBe(12);
      expect(yield* seedRentalCrmOrders(client, asOf)).toBe(0);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    expect(state.imports.orders).toHaveLength(12);
    expect(state.imports.customerLinks).toHaveLength(3);
    expect(state.imports.batches).toHaveLength(1);
    expect(state.imports.orders.every((order) => order.pairing === 'paired')).toBe(true);
    expect(
      state.imports.orders.filter((order) => orderDateText(order.orderedAt)?.startsWith('2026-10') === true),
    ).toHaveLength(3);
    expect(state.imports.batches[0]?.rejected).toBe(0);
  }),
);

it.effect('links four Hanák organizational employees through native workforce commands, without any Core write', () =>
  Effect.gen(function* nativeEmployeeSeed() {
    let state = Schema.decodeUnknownSync(WorkforceStateSchema)({ employees: [] });
    let revision = 0;
    const now = DateTime.makeUnsafe(seedTestInstant);
    const http = HttpClient.make((request, url) =>
      Effect.gen(function* workforceOwnerRequest() {
        if (url.pathname === gatewayPath) {
          const body = Match.value(request.body).pipe(
            Match.tag('Uint8Array', ({ body: bytes }) => new TextDecoder().decode(bytes)),
            Match.orElse(() => '{}'),
          );
          expect(decodeSeedBody(Schema.Struct({ audience: Schema.String }), body).audience).toBe('workforce');
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ apiBaseUrl: ownerApi, compositionRevision: revisionFixture, token: 'workforce-test' }),
          );
        }
        if (url.pathname.endsWith(recordsPath)) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ items: Schema.encodeSync(WorkforceStateSchema)(state).employees, revision }),
          );
        }
        if (url.pathname.endsWith(applyCommandPath)) {
          const body = Match.value(request.body).pipe(
            Match.tag('Uint8Array', ({ body: bytes }) => new TextDecoder().decode(bytes)),
            Match.orElse(() => '{}'),
          );
          const payload = decodeSeedBody(
            Schema.Struct({ command: WorkforceCommandSchema, expectedRevision: Schema.Int }),
            body,
          );
          expect(payload.expectedRevision).toBe(revision);
          const result = yield* evolveEmployeeState(state, payload.command, { now });
          ({ state } = result);
          revision += 1;
          return HttpClientResponse.fromWeb(request, Response.json({ revision }));
        }
        return HttpClientResponse.fromWeb(request, sessionResponse(url.pathname));
      }).pipe(Effect.orDie),
    );
    yield* Effect.gen(function* seedAndRepeat() {
      const client = yield* connect();
      expect((yield* seedCompanyEmployees(client, 'hanak', false)).created).toBe(0);
      expect(revision).toBe(0);
      expect((yield* seedCompanyEmployees(client, 'hanak', true)).created).toBe(4);
      expect((yield* seedCompanyEmployees(client, 'hanak', true)).created).toBe(0);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    expect(state.employees).toHaveLength(4);
    expect(state.employees.every((employee) => employee.principalRef?.tenantId === target.tenantId)).toBe(true);
    expect(new Set(state.employees.map((employee) => employee.principalRef?.principalId)).size).toBe(4);
    expect(revision).toBe(4);
  }),
);

it.effect('repairs every stock page through native updates and reruns without moving stock or writing again', () =>
  Effect.gen(function* paginatedStockRepair() {
    const baseline = yield* buildAkrosEncoded();
    const products = baseline.products.slice(0, 260).map((product) => ({ ...product, lowStockThreshold: 5 }));
    const ids = new Set(products.map((product) => product.id));
    let state = Schema.decodeUnknownSync(MerchandiseStateSchema)({
      ...baseline,
      movements: baseline.movements.filter((movement) => ids.has(movement.productId)),
      orders: [],
      products,
    });
    const originalMovements = state.movements;
    const originalPrices = state.products.map((product) => product.currentPriceMinor);
    let revision = 0;
    const offsets: number[] = [];
    const http = HttpClient.make((request, url) =>
      Effect.gen(function* stockOwnerRequest() {
        const body = Match.value(request.body).pipe(
          Match.tag('Uint8Array', ({ body: bytes }) => new TextDecoder().decode(bytes)),
          Match.orElse(() => '{}'),
        );
        if (url.pathname === gatewayPath) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ apiBaseUrl: ownerApi, compositionRevision: revisionFixture, token: 'stock-test' }),
          );
        }
        if (url.pathname.endsWith(recordsPath)) {
          const { view } = decodeSeedBody(MerchandiseRead, body);
          expect(view?.productSort).toBe('sku');
          const offset = view?.offset ?? 0;
          offsets.push(offset);
          const records = EffectArray.sort(
            computeProductRecords(state),
            Order.mapInput(Order.String, (product: ReturnType<typeof computeProductRecords>[number]) => product.sku),
          );
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ products: records.slice(offset, offset + (view?.limit ?? 250)), revision }),
          );
        }
        if (url.pathname.endsWith(applyCommandPath)) {
          const payload = decodeSeedBody(
            Schema.Struct({ command: MerchandiseCommandSchema, expectedRevision: Schema.Int }),
            body,
          );
          expect(payload.expectedRevision).toBe(revision);
          const result = yield* evolveMerchandiseState(state, payload.command, {
            actor: { principalId: demoId('test', 'stock-owner'), tenantId: target.tenantId },
            now: DateTime.makeUnsafe(seedTestInstant),
            resourceId: `stock-repair-${revision}`,
          });
          ({ state } = result);
          revision += 1;
          return HttpClientResponse.fromWeb(request, Response.json({ revision }));
        }
        return HttpClientResponse.fromWeb(request, sessionResponse(url.pathname));
      }).pipe(Effect.orDie),
    );
    yield* Effect.gen(function* repairAndRerun() {
      const client = yield* connect();
      expect(yield* seedAkrosStock(client, true)).toBeGreaterThan(0);
      const completedRevision = revision;
      expect(yield* seedAkrosStock(client, true)).toBe(0);
      expect(revision).toBe(completedRevision);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    expect(offsets).toEqual([0, 250, 0, 250]);
    expect(state.movements).toEqual(originalMovements);
    expect(state.products.map((product) => product.currentPriceMinor)).toEqual(originalPrices);
    expect(state.orders).toHaveLength(0);
  }),
);

it.effect('cancels only the exact QA order through native staff status change, without adding a demo flag', () =>
  Effect.gen(function* nativeQaCancellation() {
    const actor = { principalId: demoId('test', 'qa-cancel-owner'), tenantId: target.tenantId };
    let state = Schema.decodeUnknownSync(MerchandiseStateSchema)({
      movements: [],
      orders: [
        {
          channel: 'STOREFRONT',
          contact: { email: 'stage.qa.20261022@example.invalid', name: 'Stage QA' },
          createdAt: seedTestInstant,
          id: demoId('test', 'qa-order'),
          lines: [
            { productId: 'qa-product', productName: 'Test', quantity: 1, sku: 'QA', unitPriceMinor: 100, vatRate: 21 },
          ],
          number: 'OBJ-2026-0007',
          partyId: 'qa-party',
          status: 'NEW',
          totalMinor: 100,
          totalVatMinor: 21,
          updatedAt: seedTestInstant,
        },
      ],
      products: [],
    });
    let revision = 0;
    const http = HttpClient.make((request, url) =>
      Effect.gen(function* cancellationOwner() {
        if (url.pathname === gatewayPath) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ apiBaseUrl: ownerApi, compositionRevision: revisionFixture, token: 'cancel-test' }),
          );
        }
        if (url.pathname.endsWith(recordsPath)) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              ...Schema.encodeSync(MerchandiseStateSchema)(state),
              actorPrincipalRef: actor,
              canWrite: true,
              indicators: {
                lowStockCount: 0,
                openOrderValueMinor: 100,
                orderCount: 1,
                productCount: 0,
                stockValueMinor: 0,
              },
              revision,
            }),
          );
        }
        if (url.pathname.endsWith(applyCommandPath)) {
          const body = Match.value(request.body).pipe(
            Match.tag('Uint8Array', ({ body: bytes }) => new TextDecoder().decode(bytes)),
            Match.orElse(() => '{}'),
          );
          const payload = decodeSeedBody(
            Schema.Struct({ command: MerchandiseCommandSchema, expectedRevision: Schema.Int }),
            body,
          );
          expect(payload.expectedRevision).toBe(revision);
          const result = yield* evolveMerchandiseState(state, payload.command, {
            actor,
            now: DateTime.makeUnsafe(seedTestInstant),
            resourceId: `cancel-${revision}`,
          });
          ({ state } = result);
          revision += 1;
          return HttpClientResponse.fromWeb(request, Response.json({ revision }));
        }
        return HttpClientResponse.fromWeb(request, sessionResponse(url.pathname));
      }).pipe(Effect.orDie),
    );
    yield* Effect.gen(function* cancelAndRepeat() {
      const client = yield* connect();
      expect(yield* cancelStageQaOrder(client, false)).toBe(1);
      expect(revision).toBe(0);
      expect(yield* cancelStageQaOrder(client, true)).toBe(1);
      expect(yield* cancelStageQaOrder(client, true)).toBe(0);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    expect(state.orders[0]?.status).toBe('CANCELLED');
    expect(state.orders[0]?.demo).toBeUndefined();
    expect(state.orders[0]?.demoCleanup).toBeUndefined();
    expect(state.orders[0]?.history).toHaveLength(1);
    expect(state.orders[0]?.history?.[0]?.reason).toBe('Testovací objednávka');
    expect(revision).toBe(1);
  }),
);

it('does not fabricate signatures or signed-document evidence for rental contracts', () => {
  for (const lease of rentalStory.leases) {
    if (lease.contract !== null) {
      expect(lease.contract).not.toHaveProperty('signedBy');
      expect(lease.contract).not.toHaveProperty('signedOn');
    }
  }
});
