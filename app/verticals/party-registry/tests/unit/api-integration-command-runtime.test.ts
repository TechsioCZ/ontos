import { assert, expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

import { ConfigProvider, Context, Effect, Layer, Logger, Schema, Predicate, Struct } from 'effect';

import {
  ActionHandlerExecutionError,
  ActionIdempotencyKeyRequired,
  ActionInvocationNotFound,
  ActionInvocationPersistenceError,
  ActionPayloadValidationError,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionPolicyDenied,
  ActionPolicyEvaluationError,
  ActionRequestHashConflict,
  ActionRuntime,
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
  ReadEvidencePersistenceError,
  ReadEvidenceValidationError,
  ReadHandlerExecutionError,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  ReadPolicyDenied,
  ReadPolicyEvaluationError,
  ReadResultValidationError,
  ReadRuntime,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';

import type {
  ActionCoreError,
  ActionRuntimeService,
  GatewayAssertionRedemption,
  ReadCoreError,
  ReadRuntimeService,
} from '@app/core-runtime';

import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/plugin-bff/effect-edge';

import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';

import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { partyRegistryApi } from '../../shared/api.ts';

import {
  PartyCommandInvalidRequestProblemSchema,
  ResolvePartyCommandCommitResultSchema,
} from '../../shared/command-api.ts';

import {
  partyRegistryCommandRecoveryLive,
  partyRegistryCommandsLive,
} from '../../api/party-command-server.ts';

import { organizationEngagementMutationsLive } from '../../api/engagement-profile-server.ts';

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

const otherPartyRef = {
  ...partyRef,
  resourceId: 'a4000000-0000-4000-8000-000000000002',
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

const relationshipPayload = {
  fromPartyRef: partyRef,
  provenance: { method: 'DOCUMENT', source: 'operator' },
  relationshipType: 'CONTACT_PERSON_OF',
  toPartyRef: otherPartyRef,
  validFrom: '2026-09-01T00:00:00.000Z',
  validTo: null,
} as const;

type CommandTestPayload =
  | Readonly<Record<string, never>>
  | typeof archivePayload
  | typeof createPayload
  | typeof relationshipPayload
  | Readonly<{
      candidate: Omit<(typeof createPayload)['candidate'], 'displayName'> & {
        readonly displayName: string;
      };
    }>;

type EngagementTestPayload =
  | Readonly<{ partyRef: typeof partyRef }>
  | Readonly<{
      profileRef: {
        readonly moduleId: 'party.registry';
        readonly resourceId: string;
        readonly resourceType: 'party.registry.organization-engagement-profile';
        readonly tenantId: string;
      };
    }>;

const makeMissingDecisionReadRuntime = () => {
  let reads = 0;
  const readRuntime: ReadRuntimeService = {
    runRead: () =>
      Effect.suspend(() => {
        reads += 1;
        return Effect.fail(
          new ReadHandlerNotFound({
            code: 'read_handler_not_found',
            reason: 'No fixture decision',
          }),
        );
      }),
  };
  return { readCount: () => reads, readRuntime };
};

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

const makeAssertion = (
  audience = 'party-registry',
  options: { readonly expiresAt?: number; readonly tokenIssuer?: string } = {},
) =>
  Effect.gen(function* signPrincipalAssertions() {
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
        .setIssuer(options.tokenIssuer ?? issuer)
        .setAudience(audience)
        .setSubject(principal.principalId)
        .setIssuedAt()
        .setExpirationTime(options.expiresAt ?? '5m')
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

const nonPersistingRedemption: GatewayAssertionRedemption = { consume: () => Effect.void };

const ProblemTagSchema = Schema.Struct({ _tag: Schema.String });

const mounted = (
  harness: Effect.Success<ReturnType<typeof makeActionTestHarness>>,
  environment: Readonly<Record<string, string>>,
  readRuntime?: ReadRuntimeService,
  redemption: GatewayAssertionRedemption = nonPersistingRedemption,
  actionRuntime: ActionRuntimeService = harness.runtime,
  observedLogs?: string[],
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
  const redemptionLayer = Layer.succeed(GatewayAssertionRedemptionService, redemption);
  const actionLayer = Layer.succeed(ActionRuntime, actionRuntime);
  const loggerLayer =
    observedLogs === undefined
      ? Layer.empty
      : Logger.layer([
          Logger.make((options) => {
            observedLogs.push(JSON.stringify(Logger.formatStructured.log(options)));
          }),
        ]);
  const handlers = Layer.mergeAll(
    partyRegistryCommandsLive,
    partyRegistryCommandRecoveryLive,
    partyMatchDecisionReadApiLive,
  ).pipe(
    Layer.provide(ActionPrincipalVerifierLive),
    Layer.provide(actionLayer),
    Layer.provide(readLayer),
    Layer.provide(redemptionLayer),
    Layer.provide(loggerLayer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
  );
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(handlers),
      Layer.provideMerge(actionLayer),
      Layer.provideMerge(readLayer),
      Layer.provideMerge(redemptionLayer),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
};

const mountedOrganizationEngagement = (
  environment: Readonly<Record<string, string>>,
  actionRuntime: ActionRuntimeService,
) => {
  const api = HttpApi.make('PartyRegistryApi').add(
    partyRegistryApi.groups.organizationEngagementMutations,
  );
  const actionLayer = Layer.succeed(ActionRuntime, actionRuntime);
  const redemptionLayer = Layer.succeed(GatewayAssertionRedemptionService, nonPersistingRedemption);
  const handlers = organizationEngagementMutationsLive.pipe(
    Layer.provide(ActionPrincipalVerifierLive),
    Layer.provide(actionLayer),
    Layer.provide(redemptionLayer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
  );
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(handlers),
      Layer.provideMerge(actionLayer),
      Layer.provideMerge(redemptionLayer),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
};

const mountApp = (
  harness: Effect.Success<ReturnType<typeof makeActionTestHarness>>,
  environment: Readonly<Record<string, string>>,
  readRuntime?: ReadRuntimeService,
  redemption: GatewayAssertionRedemption = nonPersistingRedemption,
  actionRuntime: ActionRuntimeService = harness.runtime,
  observedLogs?: string[],
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      mounted(harness, environment, readRuntime, redemption, actionRuntime, observedLogs),
    ),
    (app) => Effect.promise(() => app.dispose()).pipe(Effect.orDie),
  );

const makeSingleUseRedemption = (): GatewayAssertionRedemption => {
  const redeemed = new Set<string>();
  return {
    consume: ({ audience, issuer: assertionIssuer, jti }) =>
      Effect.suspend(() => {
        const key = `${assertionIssuer}\u0000${audience}\u0000${jti}`;
        if (redeemed.has(key)) {
          return Effect.fail(
            new GatewayAssertionReplayError({
              reason: 'The Bearer assertion is no longer usable',
            }),
          );
        }
        redeemed.add(key);
        return Effect.void;
      }),
  };
};

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

const decisionRequest = (
  actionInvocationId: string,
  token?: string,
  extraHeaders: Readonly<Record<string, string>> = {},
) => {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-correlation-id': 'decision-recovery-test',
    ...extraHeaders,
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

const engagementRequest = (path: string, payload: EngagementTestPayload, token: string) =>
  new Request(`https://party.ontos.test${path}`, {
    body: JSON.stringify(payload),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': `engagement-${randomUUID()}`,
      'x-correlation-id': `engagement-${randomUUID()}`,
    },
    method: 'POST',
  });

it.live(
  'every registered command is mounted and rejects missing structural input or authentication before the lifecycle',
  () =>
    Effect.gen(function* rejectInvalidMountedCommands() {
      const assertion = yield* makeAssertion();
      const harness = yield* makeActionTestHarness();
      const app = yield* mountApp(harness, assertion.environment);

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
          Effect.gen(function* rejectInvalidEndpointRequest() {
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
  'missing, malformed, expired, tampered, wrong-audience, and wrong-issuer assertions are challenged without creating invocations',
  () =>
    Effect.gen(function* rejectInvalidAssertions() {
      const expired = yield* makeAssertion('party-registry', {
        expiresAt: 1,
      });
      const wrongAudience = yield* makeAssertion('contacts');
      const wrongIssuer = yield* makeAssertion('party-registry', {
        tokenIssuer: 'https://untrusted-shell.ontos.test',
      });
      const valid = yield* makeAssertion();
      const signatureStart = valid.token.lastIndexOf('.') + 1;
      const signatureFirstCharacter = valid.token.at(signatureStart);
      expect(signatureFirstCharacter).not.toBe(undefined);
      const tampered = `${valid.token.slice(0, signatureStart)}${signatureFirstCharacter === 'A' ? 'B' : 'A'}${valid.token.slice(signatureStart + 1)}`;
      const cases = [
        { assertion: valid, token: undefined },
        { assertion: valid, token: 'not-a-jwt' },
        { assertion: expired, token: expired.token },
        { assertion: valid, token: tampered },
        { assertion: wrongAudience, token: wrongAudience.token },
        { assertion: wrongIssuer, token: wrongIssuer.token },
      ];
      yield* forEachSequential(cases, ({ assertion, token }) =>
        Effect.gen(function* rejectInvalidAssertionCase() {
          const harness = yield* makeActionTestHarness();
          const app = yield* mountApp(harness, assertion.environment);
          const response = yield* handle(
            app,
            commandRequest('request-search-rebuild', {}, token, {
              'idempotency-key': 'authentication-test',
            }),
          );
          expect(response.status).toBe(401);
          expect(response.headers.get('www-authenticate')).toBe('Bearer');
          expect(response.headers.get('content-type') ?? '').toMatch(/application\/problem\+json/u);
          const body = yield* Effect.promise(() => response.json());
          expect(Predicate.isTagged(body, 'PartyCommandAuthenticationProblem')).toBe(true);
          expect(body.status).toBe(401);
          expect(
            (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).includes(
              assertion.token,
            ),
          ).toBe(false);
          expect(harness.snapshot().invocations.length).toBe(0);
        }),
      );
    }),
);

it.live(
  'missing and malformed verification configuration are retryable and never reach the lifecycle',
  () =>
    Effect.gen(function* rejectInvalidVerificationConfiguration() {
      const assertion = yield* makeAssertion();
      yield* forEachSequential(
        [
          {},
          { ...assertion.environment, ONTOS_GATEWAY_ISSUER: 'not-an-absolute-http-url' },
          { ...assertion.environment, ONTOS_GATEWAY_PUBLIC_JWKS: '{malformed' },
        ],
        (environment) =>
          Effect.gen(function* rejectInvalidConfigurationCase() {
            const harness = yield* makeActionTestHarness();
            const app = yield* mountApp(harness, environment);
            const response = yield* handle(
              app,
              commandRequest('request-search-rebuild', {}, assertion.token, {
                'idempotency-key': 'configuration-test',
              }),
            );
            expect(response.status).toBe(503);
            expect(response.headers.get('www-authenticate')).toBe(null);
            expect(response.headers.get('content-type') ?? '').toMatch(
              /application\/problem\+json/u,
            );
            const body = yield* Effect.promise(() => response.json());
            expect(Predicate.isTagged(body, 'PartyCommandUnavailableProblem')).toBe(true);
            expect(body.retryable).toBe(true);
            expect(harness.snapshot().invocations.length).toBe(0);
          }),
      );
    }),
);

it.live(
  'redemption storage outages return safe retryable problems before Action and Read lifecycles',
  () =>
    Effect.gen(function* reportRedemptionOutages() {
      const assertion = yield* makeAssertion();
      const harness = yield* makeActionTestHarness();
      const { readRuntime, readCount } = makeMissingDecisionReadRuntime();
      const app = yield* mountApp(harness, assertion.environment, readRuntime, {
        consume: () =>
          Effect.fail(
            new GatewayAssertionRedemptionUnavailableError({
              reason: 'private redemption storage diagnostic',
            }),
          ),
      });
      const before = harness.snapshot();
      yield* forEachSequential(
        [
          {
            request: commandRequest('request-search-rebuild', {}, assertion.token, {
              'idempotency-key': 'redemption-unavailable',
            }),
            tag: 'PartyCommandUnavailableProblem',
          },
          {
            request: decisionRequest(randomUUID(), assertion.token),
            tag: 'PartyMatchDecisionUnavailableProblem',
          },
        ],
        ({ request, tag }) =>
          Effect.gen(function* reportRedemptionOutageCase() {
            const response = yield* handle(app, request);
            expect(response.status).toBe(503);
            expect(response.headers.get('www-authenticate')).toBe(null);
            expect(response.headers.get('content-type') ?? '').toMatch(
              /application\/problem\+json/u,
            );
            const body = yield* Effect.promise(() => response.json());
            expect(Predicate.isTagged(body, tag)).toBe(true);
            expect(body.status).toBe(503);
            expect(body.retryable).toBe(true);
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body);
            expect(encoded.includes('private redemption')).toBe(false);
            expect(encoded.includes(assertion.token)).toBe(false);
            expect(encoded.includes(principal.principalId)).toBe(false);
            expect(encoded.includes(principal.tenantId)).toBe(false);
            expect(readCount()).toBe(0);
            expect(harness.snapshot()).toEqual(before);
          }),
      );
    }),
);

it.live(
  'generated governed reads authenticate through the shared adapter before starting ReadRuntime',
  () =>
    Effect.gen(function* authenticateGovernedReads() {
      const assertion = yield* makeAssertion();
      const harness = yield* makeActionTestHarness();
      let reads = 0;
      const receivedPrincipals: unknown[] = [];
      const readRuntime: ReadRuntimeService = {
        runRead: (input) =>
          Effect.sync(() => {
            reads += 1;
            receivedPrincipals.push(input.principal);
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ReadHandlerNotFound({
                  code: 'read_handler_not_found',
                  reason: 'No fixture decision',
                }),
              ),
            ),
          ),
      };
      const app = yield* mountApp(harness, assertion.environment, readRuntime);
      yield* forEachSequential([undefined, 'not-a-jwt'], (token) =>
        Effect.gen(function* rejectMissingGovernedCredentials() {
          const response = yield* handle(app, decisionRequest(randomUUID(), token));
          expect(response.status).toBe(401);
          expect(response.headers.get('www-authenticate')).toBe('Bearer');
          expect(response.headers.get('content-type') ?? '').toMatch(/application\/problem\+json/u);
          const body = yield* Effect.promise(() => response.json());
          expect(
            Schema.is(Schema.TaggedStruct('PartyMatchDecisionAuthenticationProblem', {}))(body),
          ).toBe(true);
          expect(reads).toBe(0);
        }),
      );
      const missingCorrelation = yield* handle(
        app,
        decisionRequest(randomUUID(), assertion.token, { 'x-correlation-id': '' }),
      );
      expect(missingCorrelation.status).toBe(400);
      expect(reads).toBe(0);
      const valid = yield* handle(app, decisionRequest(randomUUID(), assertion.token));
      expect(valid.status).toBe(404);
      expect(reads).toBe(1);
      expect(receivedPrincipals).toEqual([principal]);

      const unavailableApp = yield* mountApp(harness, {}, readRuntime);
      const unavailable = yield* handle(
        unavailableApp,
        decisionRequest(randomUUID(), assertion.otherToken),
      );
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get('www-authenticate')).toBe(null);
      const body = yield* Effect.promise(() => unavailable.json());
      expect(Schema.is(Schema.TaggedStruct('PartyMatchDecisionUnavailableProblem', {}))(body)).toBe(
        true,
      );
      expect(body.retryable).toBe(true);
      expect(reads).toBe(1);
    }),
);

it.live(
  'the complete generated governed Read seam maps every Core failure to its declared HTTP problem',
  () =>
    Effect.gen(function* mapEveryGovernedReadFailure() {
      const assertion = yield* makeAssertion();
      const reason = 'private governed Read diagnostic';
      const initialFailure = new ModuleStateCheckUnavailableError({
        code: 'module_state_check_unavailable',
        reason,
      });
      const cases: readonly [ReadCoreError, number, string][] = [
        [initialFailure, 503, 'PartyMatchDecisionUnavailableProblem'],
        [
          new ModuleStateDeniedError({ code: 'module_state_denied', reason }),
          403,
          'PartyMatchDecisionForbiddenProblem',
        ],
        [
          new OperationAuthenticationRequired({
            code: 'operation_authentication_required',
            reason,
          }),
          401,
          'PartyMatchDecisionAuthenticationProblem',
        ],
        [
          new OperationContextDenied({ code: 'operation_context_denied', reason }),
          403,
          'PartyMatchDecisionForbiddenProblem',
        ],
        [
          new OperationContextInvalid({ code: 'operation_context_invalid', reason }),
          403,
          'PartyMatchDecisionForbiddenProblem',
        ],
        [
          new OperationContextUnavailable({ code: 'operation_context_unavailable', reason }),
          503,
          'PartyMatchDecisionUnavailableProblem',
        ],
        [
          new ReadEvidencePersistenceError({ code: 'read_evidence_persistence_failed', reason }),
          503,
          'PartyMatchDecisionUnavailableProblem',
        ],
        [
          new ReadEvidenceValidationError({ code: 'read_evidence_invalid', reason }),
          500,
          'PartyMatchDecisionInternalProblem',
        ],
        [
          new ReadHandlerExecutionError({ code: 'read_handler_execution_failed', reason }),
          500,
          'PartyMatchDecisionInternalProblem',
        ],
        [
          new ReadHandlerNotFound({ code: 'read_handler_not_found', reason }),
          404,
          'PartyMatchDecisionNotFoundProblem',
        ],
        [
          new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason }),
          503,
          'PartyMatchDecisionUnavailableProblem',
        ],
        [
          new ReadInputValidationError({ code: 'read_input_invalid', reason }),
          400,
          'PartyMatchDecisionInvalidProblem',
        ],
        [
          new ReadPermissionDenied({ code: 'read_permission_denied', reason }),
          403,
          'PartyMatchDecisionForbiddenProblem',
        ],
        [
          new ReadPermissionUnavailable({ code: 'read_permission_unavailable', reason }),
          503,
          'PartyMatchDecisionUnavailableProblem',
        ],
        [
          new ReadPolicyDenied({
            code: 'read_policy_denied',
            httpStatus: 409,
            policyReasonCode: 'policy_conflict',
            reason,
          }),
          409,
          'PartyMatchDecisionPolicyConflictProblem',
        ],
        [
          new ReadPolicyDenied({
            code: 'read_policy_denied',
            httpStatus: 422,
            policyReasonCode: 'policy_ineligible',
            reason,
          }),
          422,
          'PartyMatchDecisionPolicyProblem',
        ],
        [
          new ReadPolicyEvaluationError({ code: 'read_policy_evaluation_failed', reason }),
          503,
          'PartyMatchDecisionUnavailableProblem',
        ],
        [
          new ReadResultValidationError({ code: 'read_result_invalid', reason }),
          500,
          'PartyMatchDecisionInternalProblem',
        ],
      ];
      let failure: ReadCoreError = initialFailure;
      let reads = 0;
      const readRuntime: ReadRuntimeService = {
        runRead: () => {
          reads += 1;
          return Effect.fail(failure);
        },
      };
      const harness = yield* makeActionTestHarness();
      const app = yield* mountApp(harness, assertion.environment, readRuntime);
      yield* forEachSequential(cases, ([nextFailure, expectedStatus, expectedTag]) =>
        Effect.gen(function* verifyGovernedReadFailure() {
          failure = nextFailure;
          const response = yield* handle(app, decisionRequest(randomUUID(), assertion.token));
          expect(response.status, nextFailure.code).toBe(expectedStatus);
          expect(response.headers.get('content-type') ?? '').toMatch(/application\/problem\+json/u);
          expect(response.headers.get('www-authenticate')).toBe(
            expectedStatus === 401 ? 'Bearer' : null,
          );
          const body = yield* Effect.promise(() => response.json());
          expect(Schema.is(Schema.TaggedStruct(expectedTag, {}))(body), nextFailure.code).toBe(
            true,
          );
          expect(body.status, nextFailure.code).toBe(expectedStatus);
          expect(
            (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).includes(
              reason,
            ),
            nextFailure.code,
          ).toBe(false);
          if (expectedStatus === 503) {
            expect(body.retryable, nextFailure.code).toBe(true);
          }
        }),
      );
      expect(reads).toBe(cases.length);
    }),
);

it.live('the generated governed Read seam sanitizes unexpected runtime defects', () =>
  Effect.gen(function* sanitizeGovernedReadDefect() {
    const assertion = yield* makeAssertion();
    const readRuntime: ReadRuntimeService = {
      runRead: () => Effect.die('private governed Read defect'),
    };
    const harness = yield* makeActionTestHarness();
    const app = yield* mountApp(harness, assertion.environment, readRuntime);
    const response = yield* handle(app, decisionRequest(randomUUID(), assertion.token));
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type') ?? '').toMatch(/application\/problem\+json/u);
    const body = yield* Effect.promise(() => response.json());
    expect(Schema.is(Schema.TaggedStruct('PartyMatchDecisionInternalProblem', {}))(body)).toBe(
      true,
    );
    expect(body.status).toBe(500);
    expect(
      (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).includes('private'),
    ).toBe(false);
  }),
);

it.live(
  'replayed assertions are challenged before a second Action or generated Read lifecycle',
  () =>
    Effect.gen(function* rejectAssertionReplays() {
      const assertion = yield* makeAssertion();
      const harness = yield* makeActionTestHarness();
      const { readRuntime, readCount } = makeMissingDecisionReadRuntime();
      const app = yield* mountApp(
        harness,
        assertion.environment,
        readRuntime,
        makeSingleUseRedemption(),
      );
      const firstAction = yield* handle(
        app,
        commandRequest('request-search-rebuild', {}, assertion.token, {
          'idempotency-key': 'first-redemption',
        }),
      );
      expect(firstAction.status).not.toBe(401);
      expect(harness.snapshot().invocations.length).toBe(1);
      const replayedAction = yield* handle(
        app,
        commandRequest('request-search-rebuild', {}, assertion.token, {
          'idempotency-key': 'second-redemption',
        }),
      );
      expect(replayedAction.status).toBe(401);
      expect(replayedAction.headers.get('www-authenticate')).toBe('Bearer');
      expect(replayedAction.headers.get('content-type') ?? '').toMatch(
        /application\/problem\+json/u,
      );
      expect(harness.snapshot().invocations.length).toBe(1);
      const actionAssertionReadReplay = yield* handle(
        app,
        decisionRequest(randomUUID(), assertion.token),
      );
      expect(actionAssertionReadReplay.status).toBe(401);
      expect(actionAssertionReadReplay.headers.get('www-authenticate')).toBe('Bearer');
      expect(readCount()).toBe(0);
      const firstRead = yield* handle(app, decisionRequest(randomUUID(), assertion.otherToken));
      expect(firstRead.status).toBe(404);
      expect(readCount()).toBe(1);
      const replayedRead = yield* handle(app, decisionRequest(randomUUID(), assertion.otherToken));
      expect(replayedRead.status).toBe(401);
      expect(replayedRead.headers.get('www-authenticate')).toBe('Bearer');
      expect(replayedRead.headers.get('content-type') ?? '').toMatch(/application\/problem\+json/u);
      expect(readCount()).toBe(1);
    }),
);

it.live('correlation and idempotency are mandatory before the Core Action lifecycle', () =>
  Effect.gen(function* validateActionTransport() {
    const assertion = yield* makeAssertion();
    const harness = yield* makeActionTestHarness();
    let runtimeCalls = 0;
    const observingRuntime: ActionRuntimeService = {
      resolveActionCommit: harness.runtime.resolveActionCommit,
      runAction: (input) => {
        runtimeCalls += 1;
        return harness.runtime.runAction(input);
      },
    };
    const app = yield* mountApp(
      harness,
      assertion.environment,
      undefined,
      nonPersistingRedemption,
      observingRuntime,
    );
    const missingKey = yield* handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token),
    );
    expect(missingKey.status).toBe(428);
    const missingKeyBody = yield* Effect.promise(() => missingKey.json());
    expect(
      Schema.is(Schema.TaggedStruct('PartyCommandPreconditionRequiredProblem', {}))(missingKeyBody),
    ).toBe(true);
    expect(runtimeCalls).toBe(1);
    const missingCorrelation = yield* handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'correlation-test',
        'x-correlation-id': '',
      }),
    );
    expect(missingCorrelation.status).toBe(400);
    const missingCorrelationBody = yield* Effect.promise(() => missingCorrelation.json());
    expect(
      Schema.is(Schema.TaggedStruct('PartyCommandInvalidRequestProblem', {}))(
        missingCorrelationBody,
      ),
    ).toBe(true);
    expect(runtimeCalls).toBe(1);
    const oversizedCorrelation = yield* handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'oversized-correlation-test',
        'x-correlation-id': 'x'.repeat(201),
      }),
    );
    expect(oversizedCorrelation.status).toBe(400);
    yield* Schema.decodeUnknownEffect(PartyCommandInvalidRequestProblemSchema)(
      yield* Effect.promise(() => oversizedCorrelation.json()),
    );
    expect(runtimeCalls).toBe(1);
    expect(harness.snapshot().invocations.length).toBe(0);
  }),
);

it.live(
  'the governed runner passes safe transport metadata through one complete Action execution',
  () =>
    Effect.gen(function* preserveSafeActionTransport() {
      const assertion = yield* makeAssertion();
      const correlationId = 'x'.repeat(200);
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        tenantPermission: 'allowed',
      });
      const app = yield* mountApp(harness, assertion.environment);
      const response = yield* handle(
        app,
        commandRequest('request-search-rebuild', {}, assertion.token, {
          'idempotency-key': 'transport-test',
          'x-correlation-id': correlationId,
          'x-trace-id': 'trace-transport-test',
        }),
      );
      expect(response.status).toBe(200);
      const snapshot = harness.snapshot();
      expect(snapshot.invocations.length).toBe(1);
      expect(snapshot.committed.length).toBe(1);
      expect(snapshot.transactionCount).toBe(1);
      expect(snapshot.committed[0]?.transport).toEqual({
        correlationId,
        idempotencyKey: 'transport-test',
        traceId: 'trace-transport-test',
      });
      expect(snapshot.committed[0]?.principal).toEqual(principal);
      expect(snapshot.committed[0]?.actionKey).toBe('party.registry.request-search-rebuild');
    }),
);

it.live('a decoded relationship timestamp reaches the Action runtime exactly once', () =>
  Effect.gen(function* decodeRelationshipTimestampOnce() {
    const assertion = yield* makeAssertion();
    const harness = yield* makeActionTestHarness();
    const failure = new ActionPayloadValidationError({
      code: 'action_payload_invalid',
      reason: 'runtime observation fixture',
    });
    let runtimeCalls = 0;
    const actionRuntime: ActionRuntimeService = {
      resolveActionCommit: harness.runtime.resolveActionCommit,
      runAction: () => {
        runtimeCalls += 1;
        return Effect.fail(failure);
      },
    };
    const app = yield* mountApp(
      harness,
      assertion.environment,
      undefined,
      nonPersistingRedemption,
      actionRuntime,
    );
    const response = yield* handle(
      app,
      commandRequest('create-party-relationship', relationshipPayload, assertion.token, {
        'idempotency-key': 'relationship-timestamp-test',
      }),
    );
    expect(response.status).toBe(400);
    const body = yield* Effect.promise(() => response.json());
    expect(Predicate.isTagged(body, 'PartyCommandInvalidRequestProblem')).toBe(true);
    expect(runtimeCalls).toBe(1);
  }),
);

it.live('an unexpected runtime defect is sanitized by the governed outer HTTP seam', () =>
  Effect.gen(function* sanitizeActionRuntimeDefect() {
    const assertion = yield* makeAssertion();
    const harness = yield* makeActionTestHarness();
    const defectiveRuntime: ActionRuntimeService = {
      resolveActionCommit: () => Effect.die('private resolution defect'),
      runAction: () => Effect.die('private governed runner defect'),
    };
    const observedLogs: string[] = [];
    const app = yield* mountApp(
      harness,
      assertion.environment,
      undefined,
      nonPersistingRedemption,
      defectiveRuntime,
      observedLogs,
    );
    const response = yield* handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'runner-defect-test',
      }),
    );
    expect(response.status).toBe(500);
    const body = yield* Effect.promise(() => response.json());
    expect(Predicate.isTagged(body, 'PartyCommandInternalProblem')).toBe(true);
    expect(body.status).toBe(500);
    expect(
      (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).includes(
        'private governed runner defect',
      ),
    ).toBe(false);
    expect(harness.snapshot().invocations.length).toBe(0);
    expect(observedLogs.length).toBe(1);
    const [entry] = observedLogs;
    assert.isOk(entry);
    expect(entry).toMatch(/Unexpected governed Action HTTP defect/u);
    expect(entry).toMatch(/private governed runner defect/u);
    expect(entry).toMatch(/party\.registry\.request-search-rebuild/u);
    expect(entry).toMatch(/party-command-test/u);
    expect(entry).not.toMatch(new RegExp(assertion.token, 'u'));
    expect(entry).not.toMatch(/runner-defect-test/u);
  }),
);

it.live('the endpoint-owned mapper preserves representative Core failure semantics', () =>
  Effect.gen(function* mapRepresentativeActionFailures() {
    const assertion = yield* makeAssertion();
    const cases: readonly [failure: ActionCoreError, status: number, tag: string][] = [
      [
        new ActionPayloadValidationError({
          code: 'action_payload_invalid',
          reason: 'invalid payload fixture',
        }),
        400,
        'PartyCommandInvalidRequestProblem',
      ],
      [
        new ActionPermissionDenied({
          code: 'action_permission_denied',
          reason: 'permission denied fixture',
        }),
        403,
        'PartyCommandForbiddenProblem',
      ],
      [
        new ActionPermissionCheckError({
          code: 'action_permission_check_failed',
          reason: 'permission unavailable fixture',
        }),
        503,
        'PartyCommandUnavailableProblem',
      ],
      [
        new ModuleStateDeniedError({
          code: 'module_state_denied',
          reason: 'module denied fixture',
        }),
        403,
        'PartyCommandForbiddenProblem',
      ],
      [
        new ModuleStateCheckUnavailableError({
          code: 'module_state_check_unavailable',
          reason: 'module unavailable fixture',
        }),
        503,
        'PartyCommandUnavailableProblem',
      ],
      [
        new ActionIdempotencyKeyRequired({
          code: 'action_idempotency_key_required',
          reason: 'idempotency fixture',
        }),
        428,
        'PartyCommandPreconditionRequiredProblem',
      ],
      [
        new ActionRequestHashConflict({
          code: 'action_request_hash_conflict',
          reason: 'conflict fixture',
        }),
        409,
        'PartyCommandConflictProblem',
      ],
      [
        new ActionInvocationNotFound({
          code: 'action_invocation_not_found',
          reason: 'not-found fixture',
        }),
        404,
        'PartyCommandNotFoundProblem',
      ],
      [
        new ActionInvocationPersistenceError({
          code: 'action_invocation_persistence_failed',
          reason: 'persistence fixture',
        }),
        503,
        'PartyCommandUnavailableProblem',
      ],
      [
        new ActionPolicyDenied({
          code: 'action_policy_denied',
          policyReasonCode: 'fixture_ineligible',
          reason: 'policy denial fixture',
        }),
        422,
        'PartyCommandUnprocessableProblem',
      ],
      [
        new ActionPolicyEvaluationError({
          code: 'action_policy_evaluation_failed',
          reason: 'policy evaluation fixture',
        }),
        503,
        'PartyCommandUnavailableProblem',
      ],
      [
        new ActionHandlerExecutionError({
          code: 'action_handler_execution_failed',
          reason: 'handler failure fixture',
        }),
        500,
        'PartyCommandInternalProblem',
      ],
    ];

    yield* forEachSequential(cases, ([failure, expectedStatus, expectedTag]) =>
      Effect.gen(function* verifyActionFailureMapping() {
        const harness = yield* makeActionTestHarness();
        const failingRuntime: ActionRuntimeService = {
          resolveActionCommit: harness.runtime.resolveActionCommit,
          runAction: () => Effect.fail(failure),
        };
        const app = yield* mountApp(
          harness,
          assertion.environment,
          undefined,
          nonPersistingRedemption,
          failingRuntime,
        );
        const response = yield* handle(
          app,
          commandRequest('request-search-rebuild', {}, assertion.token, {
            'idempotency-key': `mapping-${failure.code}`,
          }),
        );
        expect(response.status, failure.code).toBe(expectedStatus);
        const body = yield* Effect.promise(() => response.json());
        expect(Predicate.isTagged(body, expectedTag), failure.code).toBe(true);
      }),
    );
  }),
);

it.live('endpoint-local mappings keep declared not-found capability distinct over HTTP', () =>
  Effect.gen(function* preserveEndpointNotFoundCapabilities() {
    const assertion = yield* makeAssertion();
    const failure = new ActionInvocationNotFound({
      code: 'action_invocation_not_found',
      reason: 'endpoint capability fixture',
    });
    const actionRuntime: ActionRuntimeService = {
      resolveActionCommit: () => Effect.die('commit recovery is outside the fixture'),
      runAction: () => Effect.fail(failure),
    };
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => mountedOrganizationEngagement(assertion.environment, actionRuntime)),
      (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
    );
    const profileRef = {
      moduleId: 'party.registry',
      resourceId: randomUUID(),
      resourceType: 'party.registry.organization-engagement-profile',
      tenantId: principal.tenantId,
    } as const;
    const attachResponse = yield* handle(
      app,
      engagementRequest('/contacts/engagement/organizations/attach', { partyRef }, assertion.token),
    );
    expect(attachResponse.status).toBe(500);
    const attachBody = yield* Schema.decodeUnknownEffect(ProblemTagSchema)(
      yield* Effect.promise(() => attachResponse.json()),
    );
    expect(Predicate.isTagged(attachBody, 'ContactsInternalProblem')).toBe(true);
    const archiveResponse = yield* handle(
      app,
      engagementRequest(
        '/contacts/engagement/organizations/archive',
        { profileRef },
        assertion.otherToken,
      ),
    );
    expect(archiveResponse.status).toBe(404);
    const archiveBody = yield* Schema.decodeUnknownEffect(ProblemTagSchema)(
      yield* Effect.promise(() => archiveResponse.json()),
    );
    expect(Predicate.isTagged(archiveBody, 'ContactsNotFoundProblem')).toBe(true);
  }),
);

it.live('real Core permission denial is a durable 403 and does not execute the command', () =>
  Effect.gen(function* persistPermissionDenial() {
    const assertion = yield* makeAssertion();
    const harness = yield* makeActionTestHarness({
      actionPermission: 'denied',
      tenantPermission: 'allowed',
    });
    const app = yield* mountApp(harness, assertion.environment);

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
    Effect.gen(function* rollBackDomainConflict() {
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
      const app = yield* mountApp(harness, assertion.environment);

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
  Effect.gen(function* preserveSafeAliasRecoveryMetadata() {
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
    const app = yield* mountApp(harness, assertion.environment);

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
  Effect.gen(function* rejectCommittedCommandReplay() {
    const assertion = yield* makeAssertion();
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      tenantPermission: 'allowed',
    });
    const app = yield* mountApp(harness, assertion.environment);

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
    Effect.gen(function* preserveDistinctFailureStatuses() {
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
        Effect.gen(function* verifySafeFailureResponse() {
          const harness = yield* makeActionTestHarness({
            actionPermission: 'allowed',
            tenantPermission: 'allowed',
            services: [item.service],
          });
          const app = yield* mountApp(harness, assertion.environment);

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
  Effect.gen(function* rejectInsufficientPartyEvidence() {
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
    const app = yield* mountApp(harness, assertion.environment);

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
    Effect.gen(function* rejectIdempotencyPayloadMismatch() {
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
      const app = yield* mountApp(harness, assertion.environment);

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
    Effect.gen(function* validateCommitResolutionRequest() {
      const assertion = yield* makeAssertion();
      const harness = yield* makeActionTestHarness();
      const app = yield* mountApp(harness, assertion.environment);

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
  Effect.gen(function* resolveOpenInvocationWithoutRetry() {
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
    const app = yield* mountApp(harness, assertion.environment);

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
    const resolutionBody = yield* Effect.promise(() => resolution.json());
    expect(Schema.is(ResolvePartyCommandCommitResultSchema)(resolutionBody)).toBe(true);
    expect(Struct.omit(resolutionBody, ['_tag'])).toEqual({
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
    Effect.gen(function* recoverOriginalDecisionAfterLostCommitAcknowledgement() {
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
      const app = yield* mountApp(harness, assertion.environment, reads);

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
      const resolutionBody = yield* Effect.promise(() => resolution.json());
      expect(Schema.is(ResolvePartyCommandCommitResultSchema)(resolutionBody)).toBe(true);
      expect(Struct.omit(resolutionBody, ['_tag'])).toEqual({
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
