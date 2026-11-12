import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';
import { ApplyCommandResponseSchema } from '../../shared/apis/apply-command-action.ts';
import type { ApplyCommandResponse, ClientPartySync } from '../../shared/apis/apply-command-action.ts';
import { dispatchCrmCommand } from '../../shared/commands/index.ts';
import { VerifiedPartySchema } from '../../shared/commands/context.ts';
import type { CrmCommandFailure, VerifiedParty } from '../../shared/commands/context.ts';
import { ClientSchema } from '../../shared/domain/clients.ts';
import type { Client } from '../../shared/domain/clients.ts';
import { CrmReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import {
  PendingClientIntakeRequestSchema,
  PendingClientIntakeResponseSchema,
} from '../../shared/apis/pending-client-intake.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { CrmStateSchema, initialCrmState } from '../../shared/domain/state.ts';
import { commandResultOutcome } from '../../src/crm/client-party-sync-outcome.ts';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import {
  observeClientPartySync,
  PartyIntake,
  PartyIntakeLive,
  reconcileClientPartyBatch,
} from '../../src/services/party-intake.ts';
import type { IntakeCrmClient } from '../../src/services/party-intake.ts';
import { claimHostedModuleCredentials } from '../../../../packages/core-runtime/src/auth/hosted-module-credential-store.ts';

const at = '2026-10-27T09:00:00.000Z';
const shellGateway = 'https://shell.fixture.invalid/shell-super-app-api';
const registeredTenant = '70000000-0000-4000-8000-000000000001';
const unregisteredTenant = '70000000-0000-4000-8000-000000000009';
const INTAKE_KEY = 'platform-issued-intake-key';
/** This test process as an owners process: the host hands CRM its intake workload key for one tenant only. */
const handOverIntakeKey: Effect.Effect<void> = Effect.gen(function* handOver() {
  const receiver = yield* claimHostedModuleCredentials(['crm']).pipe(Effect.orDie);
  yield* receiver.accept({
    credentials: {},
    schemaVersion: 1,
    workloads: { [`crm/demo.crm.party-intake/${registeredTenant}`]: Redacted.make(INTAKE_KEY) },
  });
});
it('never reports a parked command as a committed CRM write or completed Party link', () => {
  const accepted = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
    _tag: 'ActionProposalAccepted',
    expiresAt: '2035-01-01T12:00:00Z',
    proposalId: '10000000-0000-4000-8000-000000000001',
  });
  for (const command of [
    { _tag: 'CreateClient', kind: 'organization', name: 'Proposed client' },
    { _tag: 'SyncClientParties' },
  ] as const) {
    expect(commandResultOutcome(command, accepted, (key) => key)).toEqual({
      entityIds: [],
      message: 'crm.common.approvalRequired',
      ok: false,
    });
  }
});
const viewer = Schema.decodeSync(CrmViewerSchema)({
  assign: true,
  principalId: 'crm-registry-sync-test',
  readAll: true,
  readAssigned: false,
  writeAll: true,
  writeAssigned: false,
});
const client = (id: string, extra: Partial<typeof ClientSchema.Encoded> = {}): Client =>
  Schema.decodeSync(ClientSchema)({
    createdAt: at,
    createdBy: viewer.principalId,
    id,
    kind: 'organization',
    name: `Client ${id}`,
    status: 'active',
    updatedAt: at,
    ...extra,
  });
const party = (entry: IntakeCrmClient): VerifiedParty =>
  Schema.decodeSync(VerifiedPartySchema)({
    counterpartyId: `counterparty-${entry.id}`,
    partyId: `party-${entry.id}`,
  });
const identify = (entry: IntakeCrmClient) => Effect.succeedSome(party(entry));
const failure = () => new CrmReferenceUnavailable({ code: 'crm_reference_unavailable', reason: 'Fixture unavailable' });
const noWrite = (_id: string, _party: VerifiedParty, revision: number) => Effect.succeed(revision + 1);

/** Writes run the real verified-link reducer and re-read the serialized canonical CRM aggregate. */
const persistence = (items: readonly Client[]) => {
  const fixtureClientId = (id: string) => {
    const entry = items.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      throw new Error(`Missing client fixture ${id}`);
    }
    return entry.id;
  };
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
      { _tag: 'LinkClientParty', clientId: fixtureClientId(clientId), partyRef: verified },
      {
        invocationId: `link-${clientId}`,
        now: DateTime.makeUnsafe(at),
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
const resultOf = (clientPartySync: ClientPartySync): ApplyCommandResponse =>
  Schema.decodeSync(ApplyCommandResponseSchema)({
    clientPartySync,
    entityIds: ['a'],
    revision: 8,
  });
const translate = (key: string, values: { readonly linked: number; readonly remaining: number }) =>
  `${key}:${values.linked}:${values.remaining}`;
const outcomeOf = (result: ApplyCommandResponse) =>
  commandResultOutcome({ _tag: 'SyncClientParties' }, result, translate);

const select = (entry: IntakeCrmClient) =>
  entry.id === 'review' ? Effect.succeed(Option.none<VerifiedParty>()) : identify(entry);

describe('CRM registry-link completion', () => {
  it.effect('persists six verified identities and sees zero unlinked clients after a full reload', () =>
    Effect.gen(function* writesSixIdentities() {
      const db = persistence(Array.from({ length: 6 }, (_entry, index) => client(`client-${index}`)));
      const before = yield* db.read();
      const selection = yield* dispatchCrmCommand(
        before.state,
        { _tag: 'SyncClientParties' },
        { invocationId: 'sync', now: DateTime.makeUnsafe(at), viewer },
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
        client('partial', { partyRef: { partyId: 'party-partial' } }),
        client('untouched'),
        client('archived', { status: 'archived' }),
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
            // No workload key was handed over for this tenant (the workload is not registered here).
            tenantId: unregisteredTenant,
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
          NodeCrypto.layer,
          ConfigProvider.layer(ConfigProvider.fromUnknown({ ONTOS_SHELL_GATEWAY_BASE_URL: shellGateway })),
        ),
      ),
    ),
  );

  it.effect('acts as its registered intake workload with the platform-issued key, through purpose-only reads', () =>
    Effect.gen(function* freshAuthoritativeReads() {
      yield* handOverIntakeKey;
      const requestBodies: (typeof PendingClientIntakeRequestSchema.Type)[] = [];
      const credentials: string[] = [];
      let assertions = 0;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.href === `${shellGateway}/auth/api-key/gateway-context`) {
          assertions += 1;
          // The workload's own key for this tenant, as the host handed it over; never an environment variable.
          expect(request.headers.get('x-api-key')).toBe(INTAKE_KEY);
          return Response.json({
            apiBaseUrl: '/crm-api',
            compositionRevision: 'a'.repeat(64),
            expiresAt: 4_102_444_800,
            token: `fixture-assertion-${assertions}`,
          });
        }
        expect(url.pathname).toBe('/crm-api/reads/pending-client-intake');
        const payload = Schema.decodeSync(Schema.fromJsonString(PendingClientIntakeRequestSchema))(
          await request.text(),
        );
        requestBodies.push(payload);
        expect(payload).toEqual({});
        credentials.push(request.headers.get('authorization') ?? '');
        return Response.json(Schema.encodeSync(PendingClientIntakeResponseSchema)({ items: [], revision: 7 }));
      };
      const service = yield* PartyIntake;
      const result = yield* service
        .forRequest({
          compositionRevision: 'a'.repeat(64),
          correlationId: 'fresh-registry-observations',
          legalEntityId: '70000000-0000-4000-8000-000000000022',
          tenantId: registeredTenant,
        })
        .reconcile()
        .pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch));
      expect(result).toEqual({ failed: 0, linked: 0, remaining: 0, review: 0, status: 'unchanged' });
      expect(assertions).toBe(2);
      expect(credentials).toEqual(['Bearer fixture-assertion-1', 'Bearer fixture-assertion-2']);
      expect(requestBodies).toEqual([{}, {}]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PartyIntakeLive,
          NodeCrypto.layer,
          ConfigProvider.layer(ConfigProvider.fromUnknown({ ONTOS_SHELL_GATEWAY_BASE_URL: shellGateway })),
        ),
      ),
    ),
  );

  it('rejects absent, contradictory and unknown completion evidence instead of trusting HTTP 200', () => {
    expect(outcomeOf(Schema.decodeSync(ApplyCommandResponseSchema)({ entityIds: ['a'], revision: 8 })).ok).toBe(false);
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
