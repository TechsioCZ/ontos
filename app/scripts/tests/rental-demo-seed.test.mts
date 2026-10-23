import { NodeServices } from '@effect/platform-node';
import { CounterpartyRefSchema } from '../../verticals/party-registry/shared/resources/counterparty.ts';
import { PartyRefSchema } from '../../verticals/party-registry/shared/resources/party.ts';
import { PartyIdSchema } from '../../verticals/sales-pipeline/shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { EmployeeIdSchema } from '../../verticals/workforce/shared/resources/employee.ts';
import { Effect, FileSystem, Match, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { demoId } from '../demo/fixture-ids.mts';
import { ensureSeedCustomer, existingSeedCustomer } from '../demo/rental-seed-customer.mts';
import { seedSiamparkCaseRecords } from '../demo/seed-siampark-cases.mts';
import { requireSeedMatch, uniqueSeedRecord } from '../demo/rental-seed.mts';
import { connectSeedClient, DemoSeedError, validateSeedTarget } from '../demo/seed-client.mts';

const ownerApi = '/owner-api';
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
        displayName: 'Ukázkový nájemce Siampark',
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
    } else if (url.pathname.endsWith('/actions/apply-command')) {
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
        'Expected one Siampark CRM fixture',
      );
    }).pipe(Effect.provideService(HttpClient.HttpClient, fixture.http));
    expect(fixture.parties).toHaveLength(0);
    expect(fixture.items).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
