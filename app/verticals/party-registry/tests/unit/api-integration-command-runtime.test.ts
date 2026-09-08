import { expect, it } from '@app/effect-rstest';
import { randomUUID } from 'node:crypto';
import { ConfigProvider, Context, Effect, Layer, Schema, Predicate } from 'effect';
import {
  ReadRuntime,
  ReadHandlerNotFound,
  ReadPermissionDenied,
  ReadResultValidationError,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { ReadRuntimeService } from '@app/core-runtime';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/plugin-bff/effect-edge';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { partyRegistryApi } from '../../shared/api.ts';
import {
  partyRegistryCommandRecoveryLive,
  partyRegistryCommandsLive,
} from '../../api/party-command-server.ts';
import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { archivePartyAction } from '../../src/actions/archive-party.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import {
  PartyEvidenceInsufficient,
  PartyPersistenceUnavailable,
  PartySchema,
} from '../../shared/domain/identity-contracts.ts';
import { PartyAliasWriteRejected } from '../../shared/domain/merge-alias-resolution.ts';
import { partyMatchDecisionReadApiLive } from '../../api/party-match-decision-read-server.ts';
import { PartyMatchDecisionRequestSchema } from '../../shared/apis/party-match-decision.ts';
import { RuleKeySchema } from '../../shared/domain/matching-contracts.ts';
import type { PartyMatchDecisionRecordSchema } from '../../shared/domain/matching-contracts.ts';

const principal = {
  authBindingId: 'a1000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:party-command-test',
  authMethod: 'session',
  principalId: 'a2000000-0000-4000-8000-000000000001',
  tenantId: 'a3000000-0000-4000-8000-000000000001',
} as const;
const partyRef = {
  moduleId: 'party.registry',
  resourceId: 'a4000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId: principal.tenantId,
} as const;
const archivePayload = { expectedRevision: 1, partyRef, reason: 'No longer active' };
const archivedParty = Schema.decodeUnknownSync(PartySchema)({
  archivedAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  displayName: 'Example organization',
  partyRef,
  partyType: 'ORGANIZATION' as const,
  revision: 1,
  updatedAt: '2026-09-01T00:00:00.000Z',
});
const createPayload = {
  candidate: {
    displayName: 'Example organization',
    evidenceRefs: ['document:verified'],
    officialIdentifiers: [],
    partyType: 'ORGANIZATION',
    provenance: { method: 'DOCUMENT', source: 'operator' },
    validFrom: '2026-09-01T00:00:00.000Z',
  },
} as const;
type CommandTestPayload =
  | Readonly<Record<string, never>>
  | typeof archivePayload
  | typeof createPayload
  | Readonly<{
      candidate: Omit<(typeof createPayload)['candidate'], 'displayName'> & {
        readonly displayName: string;
      };
    }>;
const issuer = 'https://shell.ontos.test';
const actionSlugs = [
  'add-contact-point',
  'add-party-official-identifier',
  'archive-party',
  'confirm-duplicate-parties',
  'correct-party-fact',
  'counterparty-create',
  'counterparty-role-add',
  'counterparty-role-end',
  'create-party',
  'create-party-relationship',
  'dismiss-duplicate-candidate',
  'end-contact-point',
  'end-party-official-identifier',
  'end-party-relationship',
  'mark-duplicate-candidate-needs-evidence',
  'match-party',
  'request-search-rebuild',
  'resolve-duplicate-candidate-create',
  'resolve-duplicate-candidate-match',
  'unarchive-party',
  'update-contact-point',
  'update-party',
  'update-party-official-identifier',
  'update-party-relationship',
] as const;
const endpointNames = [
  'addContactPoint',
  'addPartyOfficialIdentifier',
  'archiveParty',
  'confirmDuplicateParties',
  'correctPartyFact',
  'counterpartyCreate',
  'counterpartyRoleAdd',
  'counterpartyRoleEnd',
  'createParty',
  'createPartyRelationship',
  'dismissDuplicateCandidate',
  'endContactPoint',
  'endPartyOfficialIdentifier',
  'endPartyRelationship',
  'markDuplicateCandidateNeedsEvidence',
  'matchParty',
  'requestSearchRebuild',
  'resolveDuplicateCandidateCreate',
  'resolveDuplicateCandidateMatch',
  'unarchiveParty',
  'updateContactPoint',
  'updateParty',
  'updatePartyOfficialIdentifier',
  'updatePartyRelationship',
] as const;

const makeAssertion = (audience = 'party-registry') =>
  Effect.gen(function* testProgram1() {
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'party-command-test',
      use: 'sig',
    };
    const token = yield* Effect.promise(() =>
      new SignJWT({ principal, ver: 1 })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'party-command-test', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(principal.principalId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .setJti(randomUUID())
        .sign(privateKey),
    );
    const otherPrincipal = { ...principal, principalId: randomUUID() };
    const otherToken = yield* Effect.promise(() =>
      new SignJWT({ principal: otherPrincipal, ver: 1 })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'party-command-test', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(otherPrincipal.principalId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .setJti(randomUUID())
        .sign(privateKey),
    );
    return {
      environment: {
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )({
          keys: [publicJwk],
        }),
      },
      token,
      otherToken,
    };
  });

const mounted = (
  harness: Effect.Success<ReturnType<typeof makeActionTestHarness>>,
  environment: Readonly<Record<string, string>>,
  readRuntime?: ReadRuntimeService,
) => {
  const resolvedReadRuntime = readRuntime ?? {
    runRead: () =>
      Effect.fail(
        new ReadHandlerNotFound({ code: 'read_handler_not_found', reason: 'No fixture decision' }),
      ),
  };
  // Same API identity and production group: only unrelated read routes are omitted.
  const api = HttpApi.make('PartyRegistryApi')
    .add(partyRegistryApi.groups.partyCommands)
    .add(partyRegistryApi.groups.partyCommandRecovery)
    .add(partyRegistryApi.groups.partyMatchDecision);
  const readLayer = Layer.succeed(ReadRuntime, resolvedReadRuntime);
  const handlers = Layer.mergeAll(
    partyRegistryCommandsLive,
    partyRegistryCommandRecoveryLive,
    partyMatchDecisionReadApiLive,
  ).pipe(
    Layer.provide(ActionPrincipalVerifierLive),
    Layer.provide(harness.layer),
    Layer.provide(readLayer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
  );
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(handlers),
      Layer.provideMerge(harness.layer),
      Layer.provideMerge(readLayer),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
};

// The mounted layers provide every runtime service; the handler's conservative unknown requirement
// still requires an explicitly empty per-request context.
const emptyRequestContext = Context.makeUnsafe<unknown>(new Map());
const handle = (app: ReturnType<typeof mounted>, request: Request) =>
  Effect.promise(() => app.handler(request, emptyRequestContext));

const forEachSequential = <Item, E, R>(
  items: Iterable<Item>,
  run: (item: Item) => Effect.Effect<void, E, R>,
) => Effect.forEach(items, run, { discard: true });

const recoveryRequest = (invocationId: string, token?: string) => {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-correlation-id': 'party-recovery-test',
  });
  if (token !== undefined) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return new Request('https://party.ontos.test/party-registry/action-commits/resolve', {
    body: JSON.stringify({ invocationId }),
    headers,
    method: 'POST',
  });
};

const decisionRequest = (actionInvocationId: string, token?: string) => {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-correlation-id': 'decision-recovery-test',
  });
  if (token !== undefined) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return new Request('https://party.ontos.test/reads/party-match-decision', {
    body: JSON.stringify({ actionInvocationId }),
    headers,
    method: 'POST',
  });
};

const commandRequest = (
  slug: string,
  payload: CommandTestPayload,
  token?: string,
  extraHeaders: Readonly<Record<string, string>> = {},
) => {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-correlation-id': 'party-command-test',
    ...extraHeaders,
  });
  if (token !== undefined) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return new Request(`https://party.ontos.test/party-registry/actions/${slug}`, {
    body: JSON.stringify(payload),
    headers,
    method: 'POST',
  });
};

it.live(
  'every registered command is mounted and rejects missing structural input or authentication before the lifecycle',
  () =>
    Effect.gen(function* testProgram2() {
      const assertion = yield* makeAssertion();
      const harness = yield* makeActionTestHarness();
      const app = yield* Effect.acquireRelease(
        Effect.sync(() => mounted(harness, assertion.environment)),
        (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
      );

      expect(Object.keys(partyRegistryApi.groups.partyCommands.endpoints).length).toBe(24);
      expect(Object.keys(partyRegistryApi.groups.partyCommands.endpoints).toSorted()).toEqual(
        [...endpointNames].toSorted(),
      );
      expect(
        Object.values(partyRegistryApi.groups.partyCommands.endpoints)
          .map((endpoint) => endpoint.path)
          .toSorted(),
      ).toEqual(actionSlugs.map((slug) => `/party-registry/actions/${slug}`).toSorted());
      yield* forEachSequential(
        Object.values(partyRegistryApi.groups.partyCommands.endpoints),
        (endpoint) =>
          Effect.gen(function* testProgram3() {
            const response = yield* handle(
              app,
              new Request(`https://party.ontos.test${endpoint.path}`, {
                method: 'POST',
                body: '{}',
                headers: {
                  'content-type': 'application/json',
                  'x-correlation-id': 'mounted-command-test',
                },
              }),
            );
            expect(response.status === 400 || response.status === 401).toBe(true);
            if (!(response.status === 400 || response.status === 401)) {
              throw new Error(`${endpoint.path}: ${response.status}`);
            }
            expect(response.headers.get('content-type') ?? '').toMatch(
              /application\/problem\+json/u,
            );
            const body = yield* Effect.promise(() => response.json());
            expect(
              Predicate.isTagged(
                body,
                response.status === 400
                  ? 'PartyCommandInvalidRequestProblem'
                  : 'PartyCommandAuthenticationProblem',
              ),
            ).toBe(true);
            expect(body.status).toBe(response.status);
          }),
      );
      const malformed = yield* handle(
        app,
        new Request('https://party.ontos.test/party-registry/actions/archive-party', {
          body: '{not-json',
          headers: {
            'content-type': 'application/json',
            'x-correlation-id': 'malformed-test',
          },
          method: 'POST',
        }),
      );
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get('content-type') ?? '').toMatch(/application\/problem\+json/u);
      const malformedBody = yield* Effect.promise(() => malformed.json());
      expect(Predicate.isTagged(malformedBody, 'PartyCommandInvalidRequestProblem')).toBe(true);
      expect(harness.snapshot().invocations.length).toBe(0);
    }),
);

it.live(
  'missing, malformed, and wrong-audience assertions are challenged without creating invocations',
  () =>
    forEachSequential(['party-registry', 'contacts'], (audience) =>
      Effect.gen(function* testProgram5() {
        const assertion = yield* makeAssertion(audience);
        const harness = yield* makeActionTestHarness();
        const app = yield* Effect.acquireRelease(
          Effect.sync(() => mounted(harness, assertion.environment)),
          (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
        );

        const tokens = audience === 'contacts' ? [assertion.token] : [undefined, 'not-a-jwt'];
        yield* forEachSequential(tokens, (token) =>
          Effect.gen(function* testProgram6() {
            const response = yield* handle(
              app,
              commandRequest('request-search-rebuild', {}, token, {
                'idempotency-key': 'authentication-test',
              }),
            );
            expect(response.status).toBe(401);
            expect(response.headers.get('www-authenticate')).toBe('Bearer');
            expect(response.headers.get('content-type') ?? '').toMatch(
              /application\/problem\+json/u,
            );
            const body = yield* Effect.promise(() => response.json());
            expect(Predicate.isTagged(body, 'PartyCommandAuthenticationProblem')).toBe(true);
            expect(body.status).toBe(401);
            expect(
              (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).includes(
                assertion.token,
              ),
            ).toBe(false);
          }),
        );
        expect(harness.snapshot().invocations.length).toBe(0);
      }),
    ),
);

it.live(
  'verification configuration unavailability is retryable and never reaches the lifecycle',
  () =>
    Effect.gen(function* testProgram7() {
      const assertion = yield* makeAssertion();
      const harness = yield* makeActionTestHarness();
      const app = yield* Effect.acquireRelease(
        Effect.sync(() => mounted(harness, {})),
        (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
      );

      const response = yield* handle(
        app,
        commandRequest('request-search-rebuild', {}, assertion.token, {
          'idempotency-key': 'configuration-test',
        }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('www-authenticate')).toBe(null);
      const body = yield* Effect.promise(() => response.json());
      expect(Predicate.isTagged(body, 'PartyCommandUnavailableProblem')).toBe(true);
      expect(body.retryable).toBe(true);
      expect(harness.snapshot().invocations.length).toBe(0);
    }),
);

it.live('correlation and idempotency are mandatory before the Core Action lifecycle', () =>
  Effect.gen(function* testProgram8() {
    const assertion = yield* makeAssertion();
    const harness = yield* makeActionTestHarness();
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => mounted(harness, assertion.environment)),
      (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
    );

    const missingKey = yield* handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token),
    );
    expect(missingKey.status).toBe(428);
    const missingKeyBody = yield* Effect.promise(() => missingKey.json());
    expect(Predicate.isTagged(missingKeyBody, 'PartyCommandPreconditionRequiredProblem')).toBe(
      true,
    );
    const missingCorrelation = yield* handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'correlation-test',
        'x-correlation-id': '',
      }),
    );
    expect(missingCorrelation.status).toBe(400);
    const missingCorrelationBody = yield* Effect.promise(() => missingCorrelation.json());
    expect(Predicate.isTagged(missingCorrelationBody, 'PartyCommandInvalidRequestProblem')).toBe(
      true,
    );
    expect(harness.snapshot().invocations.length).toBe(0);
  }),
);

it.live('real Core permission denial is a durable 403 and does not execute the command', () =>
  Effect.gen(function* testProgram9() {
    const assertion = yield* makeAssertion();
    const harness = yield* makeActionTestHarness({
      actionPermission: 'denied',
      tenantPermission: 'allowed',
    });
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => mounted(harness, assertion.environment)),
      (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
    );

    const response = yield* handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'permission-test',
      }),
    );
    expect(response.status).toBe(403);
    const body = yield* Effect.promise(() => response.json());
    expect(Predicate.isTagged(body, 'PartyCommandForbiddenProblem')).toBe(true);
    expect(harness.snapshot().invocations.length).toBe(1);
    expect(harness.snapshot().permissionDenials.length).toBe(1);
  }),
);

it.live(
  'the real handler translates domain conflicts and rolls back without successful evidence',
  () =>
    Effect.gen(function* testProgram10() {
      const assertion = yield* makeAssertion();
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        tenantPermission: 'allowed',
        services: [
          bindActionTestServices(archivePartyAction, {
            transition: () => Effect.succeed({ _tag: 'conflict' as const, value: archivedParty }),
          }),
        ],
      });
      const app = yield* Effect.acquireRelease(
        Effect.sync(() => mounted(harness, assertion.environment)),
        (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
      );

      const response = yield* handle(
        app,
        commandRequest('archive-party', archivePayload, assertion.token, {
          'idempotency-key': 'conflict-test',
        }),
      );
      expect(response.status).toBe(409);
      const body = yield* Effect.promise(() => response.json());
      expect(Predicate.isTagged(body, 'PartyCommandConflictProblem')).toBe(true);
      expect(body.code).toBe('party_lifecycle_conflict');
      expect(harness.snapshot().invocations.length).toBe(1);
      expect(harness.snapshot().committed.length).toBe(0);
    }),
);

it.live('alias conflicts preserve only safe canonical recovery metadata', () =>
  Effect.gen(function* testProgram11() {
    const assertion = yield* makeAssertion();
    const canonicalPartyRef = { ...partyRef, resourceId: 'a4000000-0000-4000-8000-000000000002' };
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      tenantPermission: 'allowed',
      services: [
        bindActionTestServices(archivePartyAction, {
          transition: () =>
            Effect.fail(
              new PartyAliasWriteRejected({
                aliasPartyRef: partyRef,
                canonicalPartyRef,
                code: 'party_alias_write_rejected',
                reason: 'Private diagnostic must never leave the owner boundary',
              }),
            ),
        }),
      ],
    });
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => mounted(harness, assertion.environment)),
      (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
    );

    const response = yield* handle(
      app,
      commandRequest('archive-party', archivePayload, assertion.token, {
        'idempotency-key': 'alias-test',
      }),
    );
    expect(response.status).toBe(409);
    const body = yield* Effect.promise(() => response.json());
    expect(Predicate.isTagged(body, 'PartyCommandAliasWriteRejectedProblem')).toBe(true);
    expect(body.aliasPartyRef).toEqual(partyRef);
    expect(body.canonicalPartyRef).toEqual(canonicalPartyRef);
    expect(
      (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).includes(
        'Private diagnostic',
      ),
    ).toBe(false);
    expect(harness.snapshot().committed.length).toBe(0);
  }),
);

it.live('committed request replay stays a terminal 409 and does not execute or emit twice', () =>
  Effect.gen(function* testProgram12() {
    const assertion = yield* makeAssertion();
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      tenantPermission: 'allowed',
    });
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => mounted(harness, assertion.environment)),
      (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
    );

    const first = yield* handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'replay-test',
      }),
    );
    expect(first.status).toBe(200);
    const result = yield* Effect.promise(() => first.json());
    expect(result.status).toBe('QUEUED');
    const { committed } = harness.snapshot();
    expect(committed.length).toBe(1);
    const replay = yield* handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'replay-test',
      }),
    );
    expect(replay.status).toBe(409);
    const body = yield* Effect.promise(() => replay.json());
    expect(Predicate.isTagged(body, 'PartyCommandAlreadyCommittedProblem')).toBe(true);
    expect(body.code).toBe('action_already_committed');
    expect(body.invocationId).toBe(harness.snapshot().invocations[0]?.actionInvocationId);
    expect(body.retryCommand).toBe(false);
    expect(body.resolution).toBe('REFRESH_GOVERNED_READS');
    expect(harness.snapshot().invocations.length).toBe(1);
    expect(harness.snapshot().committed).toEqual(committed);
  }),
);

it.live(
  'declared not-found, capability-unavailable and unexpected defects retain safe distinct HTTP statuses',
  () =>
    Effect.gen(function* testProgram13() {
      const assertion = yield* makeAssertion();
      const cases = [
        {
          status: 404,
          tag: 'PartyCommandNotFoundProblem',
          service: bindActionTestServices(archivePartyAction, {
            transition: () => Effect.succeed({ _tag: 'not_found' as const }),
          }),
        },
        {
          status: 503,
          tag: 'PartyCommandUnavailableProblem',
          service: bindActionTestServices(archivePartyAction, {
            transition: () =>
              Effect.fail(
                new PartyPersistenceUnavailable({
                  code: 'party_persistence_unavailable',
                  reason: 'private database diagnostic',
                }),
              ),
          }),
        },
        {
          status: 500,
          tag: 'PartyCommandInternalProblem',
          service: bindActionTestServices(archivePartyAction, {
            transition: () => Effect.die('private unexpected diagnostic'),
          }),
        },
      ];
      yield* forEachSequential(cases, (item) =>
        Effect.gen(function* testProgram14() {
          const harness = yield* makeActionTestHarness({
            actionPermission: 'allowed',
            tenantPermission: 'allowed',
            services: [item.service],
          });
          const app = yield* Effect.acquireRelease(
            Effect.sync(() => mounted(harness, assertion.environment)),
            (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
          );

          const response = yield* handle(
            app,
            commandRequest('archive-party', archivePayload, assertion.token, {
              'idempotency-key': `failure-${item.status}`,
            }),
          );
          expect(response.status).toBe(item.status);
          expect(response.headers.get('content-type') ?? '').toMatch(/application\/problem\+json/u);
          const body = yield* Effect.promise(() => response.json());
          expect(Predicate.isTagged(body, item.tag)).toBe(true);
          expect(body.status).toBe(item.status);
          expect(
            (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).includes(
              'private',
            ),
          ).toBe(false);
          if (item.status === 503) {
            expect(body.retryable).toBe(true);
          }
          expect(harness.snapshot().committed.length).toBe(0);
        }),
      );
    }),
);

it.live('semantically insufficient Party evidence is a declared 422, not a server defect', () =>
  Effect.gen(function* testProgram15() {
    const assertion = yield* makeAssertion();
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      tenantPermission: 'allowed',
      services: [
        bindActionTestServices(createPartyAction, {
          createOrMatch: () =>
            Effect.fail(
              new PartyEvidenceInsufficient({
                code: 'party_evidence_insufficient',
                reason: 'Private evidence diagnostics',
              }),
            ),
        }),
      ],
    });
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => mounted(harness, assertion.environment)),
      (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
    );

    const response = yield* handle(
      app,
      commandRequest('create-party', createPayload, assertion.token, {
        'idempotency-key': 'evidence-test',
      }),
    );
    expect(response.status).toBe(422);
    const body = yield* Effect.promise(() => response.json());
    expect(body.code).toBe('party_evidence_insufficient');
    expect(body.status).toBe(422);
    expect(
      (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).includes(
        'Private evidence',
      ),
    ).toBe(false);
    expect(harness.snapshot().committed.length).toBe(0);
  }),
);

it.live(
  'the Core request hash rejects reuse of an idempotency key for a different command payload',
  () =>
    Effect.gen(function* testProgram16() {
      const assertion = yield* makeAssertion();
      let executions = 0;
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        tenantPermission: 'allowed',
        services: [
          bindActionTestServices(createPartyAction, {
            createOrMatch: () =>
              Effect.sync(() => {
                executions += 1;
                return {
                  outcome: 'CREATED' as const,
                  partyRef,
                  decisionRef: {
                    ...partyRef,
                    resourceType: 'party.registry.party-match-decision' as const,
                  },
                };
              }),
          }),
        ],
      });
      const app = yield* Effect.acquireRelease(
        Effect.sync(() => mounted(harness, assertion.environment)),
        (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
      );

      const first = yield* handle(
        app,
        commandRequest('create-party', createPayload, assertion.token, {
          'idempotency-key': 'hash-test',
        }),
      );
      expect(first.status).toBe(200);
      const changed = yield* handle(
        app,
        commandRequest(
          'create-party',
          { candidate: { ...createPayload.candidate, displayName: 'Different organization' } },
          assertion.token,
          { 'idempotency-key': 'hash-test' },
        ),
      );
      expect(changed.status).toBe(409);
      const changedBody = yield* Effect.promise(() => changed.json());
      expect(changedBody.code).toBe('action_request_hash_conflict');
      expect(executions).toBe(1);
      expect(harness.snapshot().committed.length).toBe(1);
    }),
);

it.live(
  'commit resolution requires authentication and a valid invocation without creating an Action',
  () =>
    Effect.gen(function* testProgram17() {
      const assertion = yield* makeAssertion();
      const harness = yield* makeActionTestHarness();
      const app = yield* Effect.acquireRelease(
        Effect.sync(() => mounted(harness, assertion.environment)),
        (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
      );

      const missingAuth = yield* handle(app, recoveryRequest(randomUUID()));
      expect(missingAuth.status).toBe(401);
      expect(missingAuth.headers.get('www-authenticate')).toBe('Bearer');
      const malformed = yield* handle(app, recoveryRequest('not-an-id', assertion.token));
      expect(malformed.status).toBe(400);
      const malformedBody = yield* Effect.promise(() => malformed.json());
      expect(Predicate.isTagged(malformedBody, 'PartyCommandInvalidRequestProblem')).toBe(true);
      const absent = yield* handle(app, recoveryRequest(randomUUID(), assertion.token));
      expect(absent.status).toBe(404);
      expect(harness.snapshot().invocations.length).toBe(0);
    }),
);

it.live('an open invocation resolves explicitly without authorizing automatic command retry', () =>
  Effect.gen(function* testProgram18() {
    const assertion = yield* makeAssertion();
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [
        bindActionTestServices(archivePartyAction, {
          transition: () => Effect.succeed({ _tag: 'conflict' as const, value: archivedParty }),
        }),
      ],
      tenantPermission: 'allowed',
    });
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => mounted(harness, assertion.environment)),
      (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
    );

    const failed = yield* handle(
      app,
      commandRequest('archive-party', archivePayload, assertion.token, {
        'idempotency-key': 'pending-resolution',
      }),
    );
    expect(failed.status).toBe(409);
    const invocationId = harness.snapshot().invocations[0]?.actionInvocationId;
    expect(Boolean(invocationId)).toBe(true);
    if (invocationId === undefined || invocationId.length === 0) {
      throw new Error('Expected truthy value');
    }
    const resolution = yield* handle(app, recoveryRequest(invocationId, assertion.token));
    expect(resolution.status).toBe(200);
    expect(yield* Effect.promise(() => resolution.json())).toEqual({
      _tag: 'PartyCommandCommitResolution',
      invocationId,
      retryCommand: false,
      state: 'OPEN',
    });
    expect(harness.snapshot().invocations.length).toBe(1);
    expect(harness.snapshot().committed.length).toBe(0);
  }),
);

it.live(
  'actual Core commit acknowledgement loss resolves and the mounted governed Read returns the original decision without rerunning the Action',
  () =>
    Effect.gen(function* testProgram19() {
      const assertion = yield* makeAssertion();
      const decisions = new Map<string, typeof PartyMatchDecisionRecordSchema.Type>();
      let executions = 0;
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        tenantPermission: 'allowed',
        commitAcknowledgement: 'indeterminate-once',
        services: [
          bindActionTestServices(createPartyAction, {
            createOrMatch: (_candidate, actionInvocationId) =>
              Effect.sync(() => {
                executions += 1;
                const decisionRef = {
                  ...partyRef,
                  resourceId: randomUUID(),
                  resourceType: 'party.registry.party-match-decision' as const,
                };
                decisions.set(actionInvocationId, {
                  caseRef: null,
                  committedCreateOutcome: 'CREATED',
                  decidedAt: '2026-09-01T00:00:00.000Z',
                  decisionRef,
                  evidenceEvaluation: null,
                  evidenceExplanation: [
                    {
                      reason: 'Verified creation evidence',
                      ruleKey: RuleKeySchema.make('creation-evidence'),
                    },
                  ],
                  matchRuleVersion: 'test-original-rule-v1',
                  operation: 'CREATE',
                  outcome: 'CREATED',
                  partyRef,
                });
                return { outcome: 'CREATED' as const, partyRef, decisionRef };
              }),
          }),
        ],
      });
      // Only the ReadRuntime is a typed double: the Action runtime and mounted BFFs are real.
      // Its projection is the exact decision written by the original Action service above.
      const reads: ReadRuntimeService = {
        runRead: (input) =>
          Effect.gen(function* readOriginalDecision() {
            const actor = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
              input.principal,
            ).pipe(
              Effect.mapError(
                () =>
                  new ReadPermissionDenied({
                    code: 'read_permission_denied',
                    reason: 'Invalid actor',
                  }),
              ),
            );
            if (
              actor.principalId !== principal.principalId ||
              actor.tenantId !== principal.tenantId
            ) {
              return yield* new ReadPermissionDenied({
                code: 'read_permission_denied',
                reason: 'Decision belongs to another principal',
              });
            }
            const query = yield* Schema.decodeUnknownEffect(PartyMatchDecisionRequestSchema)(
              input.input,
            ).pipe(
              Effect.mapError(
                () =>
                  new ReadHandlerNotFound({
                    code: 'read_handler_not_found',
                    reason: 'No decision identity',
                  }),
              ),
            );
            const decision =
              query.actionInvocationId === undefined
                ? undefined
                : decisions.get(query.actionInvocationId);
            if (decision === undefined) {
              return yield* new ReadHandlerNotFound({
                code: 'read_handler_not_found',
                reason: 'No persisted decision',
              });
            }
            return yield* Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)(
              decision,
            ).pipe(
              Effect.mapError(
                () =>
                  new ReadResultValidationError({
                    code: 'read_result_invalid',
                    reason: 'Invalid decision fixture',
                  }),
              ),
            );
          }),
      };
      const app = yield* Effect.acquireRelease(
        Effect.sync(() => mounted(harness, assertion.environment, reads)),
        (mountedApp) => Effect.promise(() => mountedApp.dispose()).pipe(Effect.orDie),
      );

      const uncertain = yield* handle(
        app,
        commandRequest('create-party', createPayload, assertion.token, {
          'idempotency-key': 'uncertain-create',
        }),
      );
      expect(uncertain.status).toBe(503);
      const body = yield* Effect.promise(() => uncertain.json());
      expect(Predicate.isTagged(body, 'PartyCommandCommitIndeterminateProblem')).toBe(true);
      expect(body.resolution).toBe('RESOLVE_COMMIT');
      expect(body.retryCommand).toBe(false);
      const invocationId = harness.snapshot().invocations[0]?.actionInvocationId;
      expect(Boolean(invocationId)).toBe(true);
      if (invocationId === undefined || invocationId.length === 0) {
        throw new Error('Expected truthy value');
      }
      expect(body.invocationId).toBe(invocationId);
      expect(harness.snapshot().committed.length).toBe(1);
      const committedSnapshot = harness.snapshot();
      const deniedRecovery = yield* handle(
        app,
        recoveryRequest(invocationId, assertion.otherToken),
      );
      expect(deniedRecovery.status).toBe(404);
      const resolution = yield* handle(app, recoveryRequest(invocationId, assertion.token));
      expect(resolution.status).toBe(200);
      expect(yield* Effect.promise(() => resolution.json())).toEqual({
        _tag: 'PartyCommandCommitResolution',
        invocationId,
        retryCommand: false,
        state: 'COMMITTED',
      });
      const missingReadAuth = yield* handle(app, decisionRequest(invocationId));
      expect(missingReadAuth.status).toBe(401);
      const deniedRead = yield* handle(app, decisionRequest(invocationId, assertion.otherToken));
      expect(deniedRead.status).toBe(403);
      const recovered = yield* handle(app, decisionRequest(invocationId, assertion.token));
      expect(recovered.status).toBe(200);
      expect(yield* Effect.promise(() => recovered.json())).toEqual(decisions.get(invocationId));
      const replay = yield* handle(
        app,
        commandRequest('create-party', createPayload, assertion.token, {
          'idempotency-key': 'uncertain-create',
        }),
      );
      expect(replay.status).toBe(409);
      const replayBody = yield* Effect.promise(() => replay.json());
      expect(Predicate.isTagged(replayBody, 'PartyCommandAlreadyCommittedProblem')).toBe(true);
      expect(replayBody.invocationId).toBe(invocationId);
      expect(replayBody.retryCommand).toBe(false);
      expect(executions).toBe(1);
      expect(harness.snapshot().committed).toEqual(committedSnapshot.committed);
      expect(harness.snapshot().invocations.length).toBe(1);
    }),
);
