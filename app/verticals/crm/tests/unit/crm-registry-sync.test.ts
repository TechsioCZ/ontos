import { NodePath } from '@effect/platform-node';
import { ConfigProvider, Effect, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';
import { ApplyCommandResponseSchema } from '../../shared/apis/apply-command-action.ts';
import type { ApplyCommandResponse, ClientPartySync } from '../../shared/apis/apply-command-action.ts';
import { dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmCommandFailure, VerifiedParty } from '../../shared/commands/context.ts';
import type { Client } from '../../shared/domain/clients.ts';
import { CrmReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import { RecordsRequestSchema } from '../../shared/apis/records.ts';
import { CrmStateSchema, initialCrmState } from '../../shared/domain/state.ts';
import { commandResultOutcome } from '../../src/crm/client-party-sync-outcome.ts';
import {
  observeClientPartySync,
  PartyIntake,
  PartyIntakeLive,
  reconcileClientPartyBatch,
} from '../../src/services/party-intake.ts';
import type { IntakeCrmClient } from '../../src/services/party-intake.ts';

const at = '2026-10-27T09:00:00.000Z';
const viewer = {
  assign: true,
  principalId: 'crm-registry-sync-test',
  readAll: true,
  readAssigned: false,
  writeAll: true,
  writeAssigned: false,
};
const client = (id: string): Client => ({
  createdAt: at,
  createdBy: viewer.principalId,
  id,
  kind: 'organization',
  name: `Client ${id}`,
  status: 'active',
  updatedAt: at,
});
const party = (entry: IntakeCrmClient): VerifiedParty => ({
  counterpartyId: `counterparty-${entry.id}`,
  partyId: `party-${entry.id}`,
});
const identify = (entry: IntakeCrmClient) => Effect.succeedSome(party(entry));
const failure = () => new CrmReferenceUnavailable({ code: 'crm_reference_unavailable', reason: 'Fixture unavailable' });
const noWrite = (_id: string, _party: VerifiedParty, revision: number) => Effect.succeed(revision + 1);

/** Writes run the real verified-link reducer and re-read the serialized canonical CRM aggregate. */
const persistence = (items: readonly Client[]) => {
  let revision = 7;
  let state = { ...initialCrmState, clients: { ...initialCrmState.clients, items } };
  const writes: string[] = [];
  const read = () =>
    Effect.succeed({
      revision,
      state: Schema.decodeSync(CrmStateSchema)(Schema.encodeSync(CrmStateSchema)(state)),
    });
  const link = Effect.fn('Crm.registrySyncTest.link')(function* link(
    clientId: string,
    verified: VerifiedParty,
    expectedRevision: number,
  ) {
    expect(expectedRevision).toBe(revision);
    const result = yield* dispatchCrmCommand(
      state,
      { _tag: 'LinkClientParty', clientId, partyRef: verified },
      {
        invocationId: `link-${clientId}`,
        now: at,
        verifiedParties: new Map([[verified.counterpartyId, verified]]),
        viewer,
      },
    );
    ({ state } = result);
    revision += 1;
    writes.push(clientId);
    return revision;
  });
  return { link, read, writes };
};
const resultOf = (clientPartySync: ClientPartySync): ApplyCommandResponse => ({
  clientPartySync,
  entityIds: ['a'],
  revision: 8,
});
const translate = (key: string, values: { readonly linked: number; readonly remaining: number }) =>
  `${key}:${values.linked}:${values.remaining}`;
const outcomeOf = (result: ApplyCommandResponse) =>
  commandResultOutcome({ _tag: 'SyncClientParties' }, result, translate);

const configuredIntake = (configuration: Readonly<Record<string, string>>) =>
  Layer.mergeAll(
    PartyIntakeLive,
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ONTOS_CRM_PARTY_INTAKE_API_KEY: 'fixture-intake-key',
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
        ...configuration,
      }),
    ),
    FileSystem.layerNoop({
      readFileString: () => Effect.die('Configured intake must not read local credential files'),
    }),
    NodePath.layer,
  );

const inspectGatewayRequest = Effect.fn('Crm.registrySyncTest.inspectGatewayRequest')(
  function* inspectGatewayRequest(_configuration: Readonly<Record<string, string>>) {
    const requests: string[] = [];
    const http = HttpClient.make((request, url) => {
      requests.push(url.href);
      expect(request.headers['x-api-key']).toBe('fixture-intake-key');
      // Stop after the credential exchange request. No owner read or mutation is attempted by this fixture.
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })));
    });
    const service = yield* PartyIntake;
    const observation = yield* observeClientPartySync(
      service
        .forRequest({
          compositionRevision: 'a'.repeat(64),
          correlationId: 'gateway-routing-fixture',
          legalEntityId: '70000000-0000-4000-8000-000000000022',
        })
        .reconcile()
        .pipe(Effect.provideService(HttpClient.HttpClient, http)),
    );
    expect(observation.status).toBe('unavailable');
    return requests;
  },
  (effect, configuration) => effect.pipe(Effect.provide(configuredIntake(configuration))),
);

/** Deliberately unsupported protocol fixtures must be rejected before a credential-bearing request. */
const rejectedGatewayProtocol = (protocol: string) => {
  const url = new URL('https://public.fixture.invalid');
  url.protocol = protocol;
  return url.href;
};

describe('CRM registry-link completion', () => {
  it.effect('persists six verified identities and sees zero unlinked clients after a full reload', () =>
    Effect.gen(function* writesSixIdentities() {
      const db = persistence(Array.from({ length: 6 }, (_entry, index) => client(`client-${index}`)));
      const before = yield* db.read();
      const selection = yield* dispatchCrmCommand(
        before.state,
        { _tag: 'SyncClientParties' },
        { invocationId: 'sync', now: at, viewer },
      );
      expect(selection.entityIds).toHaveLength(6);
      expect(selection.state.clients.items.filter((entry) => entry.partyRef === undefined)).toHaveLength(6);
      const result = yield* reconcileClientPartyBatch(db.read, identify, db.link);
      expect(result).toEqual({ failed: 0, linked: 6, remaining: 0, review: 0, status: 'complete' });
      const reloaded = yield* db.read();
      expect(reloaded.state.clients.items.filter((entry) => entry.partyRef?.counterpartyId === undefined)).toEqual([]);
      expect(reloaded.state.clients.events?.filter((entry) => entry.kind === 'party_linked')).toHaveLength(6);
      expect(db.writes).toHaveLength(6);
      expect(outcomeOf(resultOf(result)).ok).toBe(true);
    }),
  );

  it.effect('does not call a successful no-op transport a persisted link', () =>
    Effect.gen(function* refusesNoOp() {
      const db = persistence([client('a')]);
      const result = yield* observeClientPartySync(reconcileClientPartyBatch(db.read, identify, noWrite));
      expect(result).toEqual({ status: 'unavailable' });
      expect(db.writes).toEqual([]);
      expect(outcomeOf(resultOf(result))).toMatchObject({ message: 'crm.registrySync.unavailable:0:0', ok: false });
    }),
  );

  it.effect('reports partial writes separately from review decisions and unavailable writes', () =>
    Effect.gen(function* keepsPartialResults() {
      const db = persistence([client('linked'), client('review'), client('failed')]);
      const select = (entry: IntakeCrmClient) =>
        entry.id === 'review' ? Effect.succeed(Option.none<VerifiedParty>()) : identify(entry);
      const write = (
        id: string,
        verified: VerifiedParty,
        revision: number,
      ): Effect.Effect<number, CrmCommandFailure | CrmReferenceUnavailable> =>
        id === 'failed' ? Effect.fail(failure()) : db.link(id, verified, revision);
      const result = yield* reconcileClientPartyBatch(db.read, select, write);
      expect(result).toEqual({ failed: 1, linked: 1, remaining: 2, review: 1, status: 'partial' });
      expect(db.writes).toEqual(['linked']);
      expect(outcomeOf(resultOf(result)).ok).toBe(false);
      expect((yield* db.read()).state.clients.items.filter((entry) => entry.partyRef !== undefined)).toHaveLength(1);
    }),
  );

  it.effect('does not claim every client is linked when the bounded batch leaves work', () =>
    Effect.gen(function* retainsRemainingCount() {
      const db = persistence(Array.from({ length: 21 }, (_entry, index) => client(`batch-${index}`)));
      const result = yield* reconcileClientPartyBatch(db.read, identify, db.link);
      expect(result).toEqual({ failed: 0, linked: 20, remaining: 1, review: 0, status: 'partial' });
      expect(outcomeOf(resultOf(result)).ok).toBe(false);
    }),
  );

  it.effect('repairs a Party-only reference and respects explicit targets, including an empty selection', () =>
    Effect.gen(function* preservesSelection() {
      const db = persistence([
        { ...client('partial'), partyRef: { partyId: 'party-partial' } },
        client('untouched'),
        { ...client('archived'), status: 'archived' },
      ]);
      const empty = yield* reconcileClientPartyBatch(db.read, identify, db.link, []);
      expect(empty).toMatchObject({ linked: 0, remaining: 0, status: 'unchanged' });
      expect(outcomeOf(resultOf(empty)).ok).toBe(false);
      const result = yield* reconcileClientPartyBatch(db.read, identify, db.link, ['partial', 'archived']);
      expect(result).toMatchObject({ linked: 2, remaining: 0, status: 'complete' });
      expect(db.writes).toEqual(['partial', 'archived']);
      expect(
        (yield* db.read()).state.clients.items.find((entry) => entry.id === 'untouched')?.partyRef,
      ).toBeUndefined();
    }),
  );

  it.effect('retains an unavailable verification result if the final authoritative read fails', () =>
    Effect.gen(function* failsClosedAfterWrite() {
      const db = persistence([client('a')]);
      let reads = 0;
      const read = () => {
        reads += 1;
        return reads === 1 ? db.read() : Effect.fail(failure());
      };
      const result = yield* observeClientPartySync(reconcileClientPartyBatch(read, identify, db.link));
      expect(result).toEqual({ status: 'unavailable' });
      expect(db.writes).toEqual(['a']);
      expect(outcomeOf(resultOf(result)).ok).toBe(false);
    }),
  );

  it.effect('surfaces missing intake credentials without attempting registry or database writes', () =>
    Effect.gen(function* missingConfiguration() {
      let requests = 0;
      const http = HttpClient.make(() => {
        requests += 1;
        return Effect.die('Missing credentials must stop before HTTP');
      });
      const service = yield* PartyIntake;
      const result = yield* observeClientPartySync(
        service
          .forRequest({
            compositionRevision: 'a'.repeat(64),
            correlationId: 'missing-intake-config',
            legalEntityId: '70000000-0000-4000-8000-000000000022',
          })
          .reconcile()
          .pipe(Effect.provideService(HttpClient.HttpClient, http)),
      );
      expect(result.status).toBe('unavailable');
      expect(requests).toBe(0);
      expect(outcomeOf(resultOf(result)).ok).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PartyIntakeLive,
          ConfigProvider.layer(ConfigProvider.fromUnknown({})),
          FileSystem.layerNoop({ readFileString: () => Effect.succeed('') }),
          NodePath.layer,
        ),
      ),
    ),
  );

  it.effect('uses fresh governed read bodies and fresh audience credentials before and after reconciliation', () =>
    Effect.gen(function* freshAuthoritativeReads() {
      const refreshTokens: string[] = [];
      const credentials: string[] = [];
      let assertions = 0;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === '/shell-super-app-api/auth/api-key/gateway-context') {
          assertions += 1;
          expect(request.headers.get('x-api-key')).toBe('fixture-intake-key');
          return Response.json({
            apiBaseUrl: 'https://fixture.invalid/crm-api',
            compositionRevision: 'a'.repeat(64),
            token: `fixture-assertion-${assertions}`,
          });
        }
        expect(url.pathname).toBe('/crm-api/reads/records');
        const payload = Schema.decodeSync(Schema.fromJsonString(RecordsRequestSchema))(await request.text());
        expect(payload.refreshToken).toBeDefined();
        if (payload.refreshToken !== undefined) {
          refreshTokens.push(Redacted.value(payload.refreshToken));
        }
        credentials.push(request.headers.get('authorization') ?? '');
        return Response.json({
          assignmentCandidates: [],
          departedPrincipalIds: [],
          now: at,
          revision: 7,
          state: initialCrmState,
          viewer,
        });
      };
      const service = yield* PartyIntake;
      const result = yield* service
        .forRequest({
          compositionRevision: 'a'.repeat(64),
          correlationId: 'fresh-registry-observations',
          legalEntityId: '70000000-0000-4000-8000-000000000022',
        })
        .reconcile()
        .pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch));
      expect(result).toEqual({ failed: 0, linked: 0, remaining: 0, review: 0, status: 'unchanged' });
      expect(assertions).toBe(2);
      expect(credentials).toEqual(['Bearer fixture-assertion-1', 'Bearer fixture-assertion-2']);
      expect(refreshTokens).toHaveLength(2);
      expect(new Set(refreshTokens).size).toBe(2);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PartyIntakeLive,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              ONTOS_CRM_PARTY_INTAKE_API_KEY: 'fixture-intake-key',
              ONTOS_GATEWAY_ISSUER: 'https://fixture.invalid/issuer',
              ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
            }),
          ),
          FileSystem.layerNoop({
            readFileString: () => Effect.die('Configured intake must not read local credential files'),
          }),
          NodePath.layer,
        ),
      ),
    ),
  );

  it.effect('derives the Shell gateway from the trusted issuer origin, never from an implicit localhost', () =>
    Effect.gen(function* issuerGateway() {
      expect(
        yield* inspectGatewayRequest({
          ONTOS_GATEWAY_ISSUER: 'https://trusted-shell.fixture.invalid/issuer',
        }),
      ).toEqual(['https://trusted-shell.fixture.invalid/shell-super-app-api/auth/api-key/gateway-context']);
    }),
  );

  it.effect('honors an explicit valid gateway override and an explicitly configured development loopback', () =>
    Effect.gen(function* explicitGateway() {
      expect(
        yield* inspectGatewayRequest({
          ONTOS_GATEWAY_ISSUER: 'https://trusted-shell.fixture.invalid',
          ONTOS_SHELL_GATEWAY_BASE_URL: 'https://override.fixture.invalid:8443/shell-super-app-api/',
        }),
      ).toEqual(['https://override.fixture.invalid:8443/shell-super-app-api/auth/api-key/gateway-context']);
      expect(
        yield* inspectGatewayRequest({
          ONTOS_SHELL_GATEWAY_BASE_URL: 'http://127.0.0.1:3020/shell-super-app-api',
          ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
        }),
      ).toEqual(['http://127.0.0.1:3020/shell-super-app-api/auth/api-key/gateway-context']);
    }),
  );

  it.effect('fails closed before HTTP for missing or malformed trusted gateway configuration', () =>
    Effect.gen(function* refusesInvalidGateway() {
      const configurations: readonly Readonly<Record<string, string>>[] = [
        {},
        { ONTOS_GATEWAY_ISSUER: '' },
        { ONTOS_GATEWAY_ISSUER: '/relative-issuer' },
        { ONTOS_GATEWAY_ISSUER: rejectedGatewayProtocol('http:') },
        { ONTOS_GATEWAY_ISSUER: rejectedGatewayProtocol('ftp:') },
        { ONTOS_GATEWAY_ISSUER: 'https://user:password@public.fixture.invalid' },
        { ONTOS_GATEWAY_ISSUER: 'https://public.fixture.invalid?credential=forbidden' },
        { ONTOS_GATEWAY_ISSUER: 'https://public.fixture.invalid#fragment' },
        { ONTOS_GATEWAY_ISSUER: 'http://127.0.0.1:3020' },
        { ONTOS_GATEWAY_ISSUER: 'https://localhost:3020' },
        { ONTOS_SHELL_GATEWAY_BASE_URL: 'http://127.0.0.1:3020/shell-super-app-api' },
        { ONTOS_SHELL_GATEWAY_BASE_URL: 'https://public.fixture.invalid/wrong-api' },
        { ONTOS_SHELL_GATEWAY_BASE_URL: 'https://public.fixture.invalid/shell-super-app-api?query=forbidden' },
        { ONTOS_SHELL_GATEWAY_BASE_URL: 'https://public.fixture.invalid/shell-super-app-api#fragment' },
        { ONTOS_SHELL_GATEWAY_BASE_URL: 'https://user:password@public.fixture.invalid/shell-super-app-api' },
        { ONTOS_SHELL_GATEWAY_BASE_URL: ' https://public.fixture.invalid/shell-super-app-api' },
        { ONTOS_SHELL_GATEWAY_BASE_URL: String.raw`https://public.fixture.invalid\shell-super-app-api` },
        {
          ONTOS_GATEWAY_ISSUER: 'https://trusted-shell.fixture.invalid',
          ONTOS_SHELL_GATEWAY_BASE_URL: 'https://public.fixture.invalid/not-the-shell',
        },
      ];
      for (const configuration of configurations) {
        expect(yield* inspectGatewayRequest(configuration)).toEqual([]);
      }
    }),
  );

  it('rejects absent, contradictory and unknown completion evidence instead of trusting HTTP 200', () => {
    expect(outcomeOf({ entityIds: ['a'], revision: 8 }).ok).toBe(false);
    const evidence: ClientPartySync = { failed: 0, linked: 0, remaining: 0, review: 0, status: 'complete' };
    expect(outcomeOf(resultOf(evidence)).ok).toBe(false);
    expect(outcomeOf(resultOf({ ...evidence, linked: 1, remaining: 1 })).ok).toBe(false);
    expect(outcomeOf(resultOf({ status: 'unavailable' })).ok).toBe(false);
    expect(
      Schema.is(ApplyCommandResponseSchema)({ ...resultOf(evidence), clientPartySync: { status: 'success' } }),
    ).toBe(false);
    // A committed CreateClient is still successful even if its optional post-commit intake needs recovery.
    expect(
      commandResultOutcome(
        { _tag: 'CreateClient', kind: 'organization', name: 'Client' },
        resultOf({ ...evidence, status: 'unavailable' }),
        translate,
      ).ok,
    ).toBe(true);
  });
});
