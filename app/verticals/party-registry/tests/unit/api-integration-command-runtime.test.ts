// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off -- Existing compatibility boundary; expires: 2026-12-31.
import assert from 'node:assert/strict';
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigProvider, Context, Effect, Layer, Logger, Schema } from 'effect';
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
import { PartyCommandInvalidRequestProblemSchema } from '../../shared/command-api.ts';
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

const makeAssertion = async (
  audience = 'party-registry',
  options: { readonly expiresAt?: number; readonly tokenIssuer?: string } = {},
) => {
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: 'EdDSA',
    kid: 'party-command-test',
    use: 'sig',
  };
  const token = await new SignJWT({ principal, ver: 1 })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'party-command-test', typ: 'JWT' })
    .setIssuer(options.tokenIssuer ?? issuer)
    .setAudience(audience)
    .setSubject(principal.principalId)
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? '5m')
    .setJti(randomUUID())
    .sign(privateKey);
  const otherPrincipal = { ...principal, principalId: randomUUID() };
  const otherToken = await new SignJWT({ principal: otherPrincipal, ver: 1 })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'party-command-test', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(otherPrincipal.principalId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(randomUUID())
    .sign(privateKey);
  return {
    environment: {
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    },
    token,
    otherToken,
  };
};

const nonPersistingRedemption: GatewayAssertionRedemption = { consume: () => Effect.void };
const ProblemTagSchema = Schema.Struct({ _tag: Schema.String });

const mounted = (
  harness: ReturnType<typeof makeActionTestHarness>,
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

// The mounted layers provide every runtime service; the handler's conservative unknown requirement
// still requires an explicitly empty per-request context.
const emptyRequestContext = Context.makeUnsafe<unknown>(new Map());
const handle = (app: ReturnType<typeof mounted>, request: Request) =>
  app.handler(request, emptyRequestContext);

const withMountedApp = (
  app: ReturnType<typeof mounted>,
  run: (app: ReturnType<typeof mounted>) => Promise<void>,
): Promise<void> =>
  runEffectTestPromise(
    Effect.acquireUseRelease(
      Effect.succeed(app),
      (resource) => Effect.promise(() => run(resource)),
      (resource) => Effect.promise(() => resource.dispose()),
    ),
  );

const forEachSequential = <Item>(
  items: Iterable<Item>,
  run: (item: Item) => Promise<void>,
): Promise<void> => {
  const iterator = items[Symbol.iterator]();
  const advance = (): Promise<void> => {
    const item = iterator.next();
    return item.done === true ? Promise.resolve() : run(item.value).then(advance);
  };
  return advance();
};

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

test('every registered command is mounted and rejects missing structural input or authentication before the lifecycle', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
  await withMountedApp(mounted(harness, assertion.environment), async (app) => {
    assert.equal(Object.keys(partyRegistryApi.groups.partyCommands.endpoints).length, 24);
    assert.deepEqual(
      Object.keys(partyRegistryApi.groups.partyCommands.endpoints).toSorted(),
      [...endpointNames].toSorted(),
    );
    assert.deepEqual(
      Object.values(partyRegistryApi.groups.partyCommands.endpoints)
        .map((endpoint) => endpoint.path)
        .toSorted(),
      actionSlugs.map((slug) => `/party-registry/actions/${slug}`).toSorted(),
    );
    await forEachSequential(
      Object.values(partyRegistryApi.groups.partyCommands.endpoints),
      async (endpoint) => {
        const response = await handle(
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
        assert.ok(
          response.status === 400 || response.status === 401,
          `${endpoint.path}: ${response.status}`,
        );
        assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/u);
        const body = await response.json();
        assert.ok(
          Schema.is(
            Schema.TaggedStruct(
              response.status === 400
                ? 'PartyCommandInvalidRequestProblem'
                : 'PartyCommandAuthenticationProblem',
              {},
            ),
          )(body),
        );
        assert.equal(body.status, response.status);
      },
    );
    const malformed = await handle(
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
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers.get('content-type') ?? '', /application\/problem\+json/u);
    const malformedBody = await malformed.json();
    assert.ok(
      Schema.is(Schema.TaggedStruct('PartyCommandInvalidRequestProblem', {}))(malformedBody),
    );
    assert.equal(harness.snapshot().invocations.length, 0);
  });
});

test('missing, malformed, expired, tampered, wrong-audience, and wrong-issuer assertions are challenged without creating invocations', async () => {
  const expired = await makeAssertion('party-registry', {
    expiresAt: 1,
  });
  const wrongAudience = await makeAssertion('contacts');
  const wrongIssuer = await makeAssertion('party-registry', {
    tokenIssuer: 'https://untrusted-shell.ontos.test',
  });
  const valid = await makeAssertion();
  const signatureStart = valid.token.lastIndexOf('.') + 1;
  const signatureFirstCharacter = valid.token.at(signatureStart);
  assert.notEqual(signatureFirstCharacter, undefined);
  const tampered = `${valid.token.slice(0, signatureStart)}${signatureFirstCharacter === 'A' ? 'B' : 'A'}${valid.token.slice(signatureStart + 1)}`;
  const cases = [
    { assertion: valid, token: undefined },
    { assertion: valid, token: 'not-a-jwt' },
    { assertion: expired, token: expired.token },
    { assertion: valid, token: tampered },
    { assertion: wrongAudience, token: wrongAudience.token },
    { assertion: wrongIssuer, token: wrongIssuer.token },
  ];
  await forEachSequential(cases, async ({ assertion, token }) => {
    const harness = makeActionTestHarness();
    await withMountedApp(mounted(harness, assertion.environment), async (app) => {
      const response = await handle(
        app,
        commandRequest('request-search-rebuild', {}, token, {
          'idempotency-key': 'authentication-test',
        }),
      );
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/u);
      const body = await response.json();
      assert.ok(Schema.is(Schema.TaggedStruct('PartyCommandAuthenticationProblem', {}))(body));
      assert.equal(body.status, 401);
      assert.equal(JSON.stringify(body).includes(assertion.token), false);
      assert.equal(harness.snapshot().invocations.length, 0);
    });
  });
});

test('missing and malformed verification configuration are retryable and never reach the lifecycle', async () => {
  const assertion = await makeAssertion();
  await forEachSequential(
    [
      {},
      { ...assertion.environment, ONTOS_GATEWAY_ISSUER: 'not-an-absolute-http-url' },
      { ...assertion.environment, ONTOS_GATEWAY_PUBLIC_JWKS: '{malformed' },
    ],
    async (environment) => {
      const harness = makeActionTestHarness();
      await withMountedApp(mounted(harness, environment), async (app) => {
        const response = await handle(
          app,
          commandRequest('request-search-rebuild', {}, assertion.token, {
            'idempotency-key': 'configuration-test',
          }),
        );
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('www-authenticate'), null);
        assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/u);
        const body = await response.json();
        assert.ok(Schema.is(Schema.TaggedStruct('PartyCommandUnavailableProblem', {}))(body));
        assert.equal(body.retryable, true);
        assert.equal(harness.snapshot().invocations.length, 0);
      });
    },
  );
});

test('redemption storage outages return safe retryable problems before Action and Read lifecycles', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
  let reads = 0;
  const readRuntime: ReadRuntimeService = {
    runRead: () =>
      Effect.sync(() => {
        reads += 1;
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
  const app = mounted(harness, assertion.environment, readRuntime, {
    consume: () =>
      Effect.fail(
        new GatewayAssertionRedemptionUnavailableError({
          reason: 'private redemption storage diagnostic',
        }),
      ),
  });
  const before = harness.snapshot();
  try {
    await forEachSequential(
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
      async ({ request, tag }) => {
        const response = await handle(app, request);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('www-authenticate'), null);
        assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/u);
        const body = await response.json();
        assert.equal(body._tag, tag);
        assert.equal(body.status, 503);
        assert.equal(body.retryable, true);
        const encoded = JSON.stringify(body);
        assert.equal(encoded.includes('private redemption'), false);
        assert.equal(encoded.includes(assertion.token), false);
        assert.equal(encoded.includes(principal.principalId), false);
        assert.equal(encoded.includes(principal.tenantId), false);
        assert.equal(reads, 0);
        assert.deepEqual(harness.snapshot(), before);
      },
    );
  } finally {
    await app.dispose();
  }
});

test('generated governed reads authenticate through the shared adapter before starting ReadRuntime', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
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
  await withMountedApp(mounted(harness, assertion.environment, readRuntime), async (app) => {
    await forEachSequential([undefined, 'not-a-jwt'], async (token) => {
      const response = await handle(app, decisionRequest(randomUUID(), token));
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/u);
      const body = await response.json();
      assert.ok(
        Schema.is(Schema.TaggedStruct('PartyMatchDecisionAuthenticationProblem', {}))(body),
      );
      assert.equal(reads, 0);
    });
    const missingCorrelation = await handle(
      app,
      decisionRequest(randomUUID(), assertion.token, { 'x-correlation-id': '' }),
    );
    assert.equal(missingCorrelation.status, 400);
    assert.equal(reads, 0);
    const valid = await handle(app, decisionRequest(randomUUID(), assertion.token));
    assert.equal(valid.status, 404);
    assert.equal(reads, 1);
    assert.deepEqual(receivedPrincipals, [principal]);
  });

  await withMountedApp(mounted(harness, {}, readRuntime), async (unavailableApp) => {
    const unavailable = await handle(
      unavailableApp,
      decisionRequest(randomUUID(), assertion.otherToken),
    );
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('www-authenticate'), null);
    const body = await unavailable.json();
    assert.ok(Schema.is(Schema.TaggedStruct('PartyMatchDecisionUnavailableProblem', {}))(body));
    assert.equal(body.retryable, true);
    assert.equal(reads, 1);
  });
});

test('the complete generated governed Read seam maps every Core failure to its declared HTTP problem', async () => {
  const assertion = await makeAssertion();
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
      new OperationAuthenticationRequired({ code: 'operation_authentication_required', reason }),
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
  await withMountedApp(
    mounted(makeActionTestHarness(), assertion.environment, readRuntime),
    async (app) => {
      await forEachSequential(cases, async ([nextFailure, expectedStatus, expectedTag]) => {
        failure = nextFailure;
        const response = await handle(app, decisionRequest(randomUUID(), assertion.token));
        assert.equal(response.status, expectedStatus, nextFailure._tag);
        assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/u);
        assert.equal(
          response.headers.get('www-authenticate'),
          expectedStatus === 401 ? 'Bearer' : null,
        );
        const body = await response.json();
        assert.ok(Schema.is(Schema.TaggedStruct(expectedTag, {}))(body), nextFailure._tag);
        assert.equal(body.status, expectedStatus, nextFailure._tag);
        assert.equal(JSON.stringify(body).includes(reason), false, nextFailure._tag);
        if (expectedStatus === 503) {
          assert.equal(body.retryable, true, nextFailure._tag);
        }
      });
      assert.equal(reads, cases.length);
    },
  );
});

test('the generated governed Read seam sanitizes unexpected runtime defects', async () => {
  const assertion = await makeAssertion();
  const readRuntime: ReadRuntimeService = {
    runRead: () => Effect.die('private governed Read defect'),
  };
  await withMountedApp(
    mounted(makeActionTestHarness(), assertion.environment, readRuntime),
    async (app) => {
      const response = await handle(app, decisionRequest(randomUUID(), assertion.token));
      assert.equal(response.status, 500);
      assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/u);
      const body = await response.json();
      assert.ok(Schema.is(Schema.TaggedStruct('PartyMatchDecisionInternalProblem', {}))(body));
      assert.equal(body.status, 500);
      assert.equal(JSON.stringify(body).includes('private'), false);
    },
  );
});

test('replayed assertions are challenged before a second Action or generated Read lifecycle', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
  let reads = 0;
  const readRuntime: ReadRuntimeService = {
    runRead: () =>
      Effect.sync(() => {
        reads += 1;
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
  await withMountedApp(
    mounted(harness, assertion.environment, readRuntime, makeSingleUseRedemption()),
    async (app) => {
      const firstAction = await handle(
        app,
        commandRequest('request-search-rebuild', {}, assertion.token, {
          'idempotency-key': 'first-redemption',
        }),
      );
      assert.notEqual(firstAction.status, 401);
      assert.equal(harness.snapshot().invocations.length, 1);

      const replayedAction = await handle(
        app,
        commandRequest('request-search-rebuild', {}, assertion.token, {
          'idempotency-key': 'second-redemption',
        }),
      );
      assert.equal(replayedAction.status, 401);
      assert.equal(replayedAction.headers.get('www-authenticate'), 'Bearer');
      assert.match(replayedAction.headers.get('content-type') ?? '', /application\/problem\+json/u);
      assert.equal(harness.snapshot().invocations.length, 1);

      const actionAssertionReadReplay = await handle(
        app,
        decisionRequest(randomUUID(), assertion.token),
      );
      assert.equal(actionAssertionReadReplay.status, 401);
      assert.equal(actionAssertionReadReplay.headers.get('www-authenticate'), 'Bearer');
      assert.equal(reads, 0);

      const firstRead = await handle(app, decisionRequest(randomUUID(), assertion.otherToken));
      assert.equal(firstRead.status, 404);
      assert.equal(reads, 1);

      const replayedRead = await handle(app, decisionRequest(randomUUID(), assertion.otherToken));
      assert.equal(replayedRead.status, 401);
      assert.equal(replayedRead.headers.get('www-authenticate'), 'Bearer');
      assert.match(replayedRead.headers.get('content-type') ?? '', /application\/problem\+json/u);
      assert.equal(reads, 1);
    },
  );
});

test('correlation and idempotency are mandatory before the Core Action lifecycle', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
  let runtimeCalls = 0;
  const observingRuntime: ActionRuntimeService = {
    resolveActionCommit: harness.runtime.resolveActionCommit,
    runAction: (input) => {
      runtimeCalls += 1;
      return harness.runtime.runAction(input);
    },
  };
  await withMountedApp(
    mounted(harness, assertion.environment, undefined, nonPersistingRedemption, observingRuntime),
    async (app) => {
      const missingKey = await handle(
        app,
        commandRequest('request-search-rebuild', {}, assertion.token),
      );
      assert.equal(missingKey.status, 428);
      const missingKeyBody = await missingKey.json();
      assert.ok(
        Schema.is(Schema.TaggedStruct('PartyCommandPreconditionRequiredProblem', {}))(
          missingKeyBody,
        ),
      );
      assert.equal(runtimeCalls, 1);
      const missingCorrelation = await handle(
        app,
        commandRequest('request-search-rebuild', {}, assertion.token, {
          'idempotency-key': 'correlation-test',
          'x-correlation-id': '',
        }),
      );
      assert.equal(missingCorrelation.status, 400);
      const missingCorrelationBody = await missingCorrelation.json();
      assert.ok(
        Schema.is(Schema.TaggedStruct('PartyCommandInvalidRequestProblem', {}))(
          missingCorrelationBody,
        ),
      );
      assert.equal(runtimeCalls, 1);
      const oversizedCorrelation = await handle(
        app,
        commandRequest('request-search-rebuild', {}, assertion.token, {
          'idempotency-key': 'oversized-correlation-test',
          'x-correlation-id': 'x'.repeat(201),
        }),
      );
      assert.equal(oversizedCorrelation.status, 400);
      Schema.decodeUnknownSync(PartyCommandInvalidRequestProblemSchema)(
        await oversizedCorrelation.json(),
      );
      assert.equal(runtimeCalls, 1);
      assert.equal(harness.snapshot().invocations.length, 0);
    },
  );
});

test('the governed runner passes safe transport metadata through one complete Action execution', async () => {
  const assertion = await makeAssertion();
  const correlationId = 'x'.repeat(200);
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    tenantPermission: 'allowed',
  });
  await withMountedApp(mounted(harness, assertion.environment), async (app) => {
    const response = await handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'transport-test',
        'x-correlation-id': correlationId,
        'x-trace-id': 'trace-transport-test',
      }),
    );
    assert.equal(response.status, 200);
    const snapshot = harness.snapshot();
    assert.equal(snapshot.invocations.length, 1);
    assert.equal(snapshot.committed.length, 1);
    assert.equal(snapshot.transactionCount, 1);
    assert.deepEqual(snapshot.committed[0]?.transport, {
      correlationId,
      idempotencyKey: 'transport-test',
      traceId: 'trace-transport-test',
    });
    assert.deepEqual(snapshot.committed[0]?.principal, principal);
    assert.equal(snapshot.committed[0]?.actionKey, 'party.registry.request-search-rebuild');
  });
});

test('a decoded relationship timestamp reaches the Action runtime exactly once', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
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
  await withMountedApp(
    mounted(harness, assertion.environment, undefined, nonPersistingRedemption, actionRuntime),
    async (app) => {
      const response = await handle(
        app,
        commandRequest('create-party-relationship', relationshipPayload, assertion.token, {
          'idempotency-key': 'relationship-timestamp-test',
        }),
      );
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body._tag, 'PartyCommandInvalidRequestProblem');
      assert.equal(runtimeCalls, 1);
    },
  );
});

test('an unexpected runtime defect is sanitized by the governed outer HTTP seam', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
  const defectiveRuntime: ActionRuntimeService = {
    resolveActionCommit: () => Effect.die('private resolution defect'),
    runAction: () => Effect.die('private governed runner defect'),
  };
  const observedLogs: string[] = [];
  await withMountedApp(
    mounted(
      harness,
      assertion.environment,
      undefined,
      nonPersistingRedemption,
      defectiveRuntime,
      observedLogs,
    ),
    async (app) => {
      const response = await handle(
        app,
        commandRequest('request-search-rebuild', {}, assertion.token, {
          'idempotency-key': 'runner-defect-test',
        }),
      );
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body._tag, 'PartyCommandInternalProblem');
      assert.equal(body.status, 500);
      assert.equal(JSON.stringify(body).includes('private governed runner defect'), false);
      assert.equal(harness.snapshot().invocations.length, 0);
      assert.equal(observedLogs.length, 1);
      const [entry] = observedLogs;
      assert.ok(entry);
      assert.match(entry, /Unexpected governed Action HTTP defect/u);
      assert.match(entry, /private governed runner defect/u);
      assert.match(entry, /party\.registry\.request-search-rebuild/u);
      assert.match(entry, /party-command-test/u);
      assert.doesNotMatch(entry, new RegExp(assertion.token, 'u'));
      assert.doesNotMatch(entry, /runner-defect-test/u);
    },
  );
});

test('the endpoint-owned mapper preserves representative Core failure semantics', async () => {
  const assertion = await makeAssertion();
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

  await forEachSequential(cases, async ([failure, expectedStatus, expectedTag]) => {
    const harness = makeActionTestHarness();
    const failingRuntime: ActionRuntimeService = {
      resolveActionCommit: harness.runtime.resolveActionCommit,
      runAction: () => Effect.fail(failure),
    };
    await withMountedApp(
      mounted(harness, assertion.environment, undefined, nonPersistingRedemption, failingRuntime),
      async (app) => {
        const response = await handle(
          app,
          commandRequest('request-search-rebuild', {}, assertion.token, {
            'idempotency-key': `mapping-${failure._tag}`,
          }),
        );
        assert.equal(response.status, expectedStatus, failure._tag);
        const body = await response.json();
        assert.equal(body._tag, expectedTag, failure._tag);
      },
    );
  });
});

test('endpoint-local mappings keep declared not-found capability distinct over HTTP', async () => {
  const assertion = await makeAssertion();
  const failure = new ActionInvocationNotFound({
    code: 'action_invocation_not_found',
    reason: 'endpoint capability fixture',
  });
  const actionRuntime: ActionRuntimeService = {
    resolveActionCommit: () => Effect.die('commit recovery is outside the fixture'),
    runAction: () => Effect.fail(failure),
  };
  const app = mountedOrganizationEngagement(assertion.environment, actionRuntime);
  const profileRef = {
    moduleId: 'party.registry',
    resourceId: randomUUID(),
    resourceType: 'party.registry.organization-engagement-profile',
    tenantId: principal.tenantId,
  } as const;
  try {
    const attachResponse = await handle(
      app,
      engagementRequest('/contacts/engagement/organizations/attach', { partyRef }, assertion.token),
    );
    assert.equal(attachResponse.status, 500);
    const attachBody = Schema.decodeUnknownSync(ProblemTagSchema)(await attachResponse.json());
    assert.equal(attachBody._tag, 'ContactsInternalProblem');

    const archiveResponse = await handle(
      app,
      engagementRequest(
        '/contacts/engagement/organizations/archive',
        { profileRef },
        assertion.otherToken,
      ),
    );
    assert.equal(archiveResponse.status, 404);
    const archiveBody = Schema.decodeUnknownSync(ProblemTagSchema)(await archiveResponse.json());
    assert.equal(archiveBody._tag, 'ContactsNotFoundProblem');
  } finally {
    await app.dispose();
  }
});

test('real Core permission denial is a durable 403 and does not execute the command', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness({
    actionPermission: 'denied',
    tenantPermission: 'allowed',
  });
  await withMountedApp(mounted(harness, assertion.environment), async (app) => {
    const response = await handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'permission-test',
      }),
    );
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.ok(Schema.is(Schema.TaggedStruct('PartyCommandForbiddenProblem', {}))(body));
    assert.equal(harness.snapshot().invocations.length, 1);
    assert.equal(harness.snapshot().permissionDenials.length, 1);
  });
});

test('the real handler translates domain conflicts and rolls back without successful evidence', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    tenantPermission: 'allowed',
    services: [
      bindActionTestServices(archivePartyAction, {
        transition: () => Effect.succeed({ _tag: 'conflict' as const, value: archivedParty }),
      }),
    ],
  });
  await withMountedApp(mounted(harness, assertion.environment), async (app) => {
    const response = await handle(
      app,
      commandRequest('archive-party', archivePayload, assertion.token, {
        'idempotency-key': 'conflict-test',
      }),
    );
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.ok(Schema.is(Schema.TaggedStruct('PartyCommandConflictProblem', {}))(body));
    assert.equal(body.code, 'party_lifecycle_conflict');
    assert.equal(harness.snapshot().invocations.length, 1);
    assert.equal(harness.snapshot().committed.length, 0);
  });
});

test('alias conflicts preserve only safe canonical recovery metadata', async () => {
  const assertion = await makeAssertion();
  const canonicalPartyRef = { ...partyRef, resourceId: 'a4000000-0000-4000-8000-000000000002' };
  const harness = makeActionTestHarness({
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
  await withMountedApp(mounted(harness, assertion.environment), async (app) => {
    const response = await handle(
      app,
      commandRequest('archive-party', archivePayload, assertion.token, {
        'idempotency-key': 'alias-test',
      }),
    );
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.ok(Schema.is(Schema.TaggedStruct('PartyCommandAliasWriteRejectedProblem', {}))(body));
    assert.deepEqual(body.aliasPartyRef, partyRef);
    assert.deepEqual(body.canonicalPartyRef, canonicalPartyRef);
    assert.equal(JSON.stringify(body).includes('Private diagnostic'), false);
    assert.equal(harness.snapshot().committed.length, 0);
  });
});

test('committed request replay stays a terminal 409 and does not execute or emit twice', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    tenantPermission: 'allowed',
  });
  await withMountedApp(mounted(harness, assertion.environment), async (app) => {
    const first = await handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'replay-test',
      }),
    );
    assert.equal(first.status, 200);
    const result = await first.json();
    assert.equal(result.status, 'QUEUED');
    const { committed } = harness.snapshot();
    assert.equal(committed.length, 1);
    const replay = await handle(
      app,
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'replay-test',
      }),
    );
    assert.equal(replay.status, 409);
    const body = await replay.json();
    assert.ok(Schema.is(Schema.TaggedStruct('PartyCommandAlreadyCommittedProblem', {}))(body));
    assert.equal(body.code, 'action_already_committed');
    assert.equal(body.invocationId, harness.snapshot().invocations[0]?.actionInvocationId);
    assert.equal(body.retryCommand, false);
    assert.equal(body.resolution, 'REFRESH_GOVERNED_READS');
    assert.equal(harness.snapshot().invocations.length, 1);
    assert.deepEqual(harness.snapshot().committed, committed);
  });
});

test('declared not-found, capability-unavailable and unexpected defects retain safe distinct HTTP statuses', async () => {
  const assertion = await makeAssertion();
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
  await forEachSequential(cases, async (item) => {
    const harness = makeActionTestHarness({
      actionPermission: 'allowed',
      tenantPermission: 'allowed',
      services: [item.service],
    });
    await withMountedApp(mounted(harness, assertion.environment), async (app) => {
      const response = await handle(
        app,
        commandRequest('archive-party', archivePayload, assertion.token, {
          'idempotency-key': `failure-${item.status}`,
        }),
      );
      assert.equal(response.status, item.status);
      assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/u);
      const body = await response.json();
      assert.ok(Schema.is(Schema.TaggedStruct(item.tag, {}))(body));
      assert.equal(body.status, item.status);
      assert.equal(JSON.stringify(body).includes('private'), false);
      if (item.status === 503) {
        assert.equal(body.retryable, true);
      }
      assert.equal(harness.snapshot().committed.length, 0);
    });
  });
});

test('semantically insufficient Party evidence is a declared 422, not a server defect', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness({
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
  await withMountedApp(mounted(harness, assertion.environment), async (app) => {
    const response = await handle(
      app,
      commandRequest('create-party', createPayload, assertion.token, {
        'idempotency-key': 'evidence-test',
      }),
    );
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.code, 'party_evidence_insufficient');
    assert.equal(body.status, 422);
    assert.equal(JSON.stringify(body).includes('Private evidence'), false);
    assert.equal(harness.snapshot().committed.length, 0);
  });
});

test('the Core request hash rejects reuse of an idempotency key for a different command payload', async () => {
  const assertion = await makeAssertion();
  let executions = 0;
  const harness = makeActionTestHarness({
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
  await withMountedApp(mounted(harness, assertion.environment), async (app) => {
    const first = await handle(
      app,
      commandRequest('create-party', createPayload, assertion.token, {
        'idempotency-key': 'hash-test',
      }),
    );
    assert.equal(first.status, 200);
    const changed = await handle(
      app,
      commandRequest(
        'create-party',
        { candidate: { ...createPayload.candidate, displayName: 'Different organization' } },
        assertion.token,
        { 'idempotency-key': 'hash-test' },
      ),
    );
    assert.equal(changed.status, 409);
    const changedBody = await changed.json();
    assert.equal(changedBody.code, 'action_request_hash_conflict');
    assert.equal(executions, 1);
    assert.equal(harness.snapshot().committed.length, 1);
  });
});

test('commit resolution requires authentication and a valid invocation without creating an Action', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
  await withMountedApp(mounted(harness, assertion.environment), async (app) => {
    const missingAuth = await handle(app, recoveryRequest(randomUUID()));
    assert.equal(missingAuth.status, 401);
    assert.equal(missingAuth.headers.get('www-authenticate'), 'Bearer');
    const malformed = await handle(app, recoveryRequest('not-an-id', assertion.token));
    assert.equal(malformed.status, 400);
    const malformedBody = await malformed.json();
    assert.ok(
      Schema.is(Schema.TaggedStruct('PartyCommandInvalidRequestProblem', {}))(malformedBody),
    );
    const absent = await handle(app, recoveryRequest(randomUUID(), assertion.token));
    assert.equal(absent.status, 404);
    assert.equal(harness.snapshot().invocations.length, 0);
  });
});

test('an open invocation resolves explicitly without authorizing automatic command retry', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    services: [
      bindActionTestServices(archivePartyAction, {
        transition: () => Effect.succeed({ _tag: 'conflict' as const, value: archivedParty }),
      }),
    ],
    tenantPermission: 'allowed',
  });
  await withMountedApp(mounted(harness, assertion.environment), async (app) => {
    const failed = await handle(
      app,
      commandRequest('archive-party', archivePayload, assertion.token, {
        'idempotency-key': 'pending-resolution',
      }),
    );
    assert.equal(failed.status, 409);
    const invocationId = harness.snapshot().invocations[0]?.actionInvocationId;
    assert.ok(invocationId);
    const resolution = await handle(app, recoveryRequest(invocationId, assertion.token));
    assert.equal(resolution.status, 200);
    assert.deepEqual(await resolution.json(), {
      _tag: 'PartyCommandCommitResolution',
      invocationId,
      retryCommand: false,
      state: 'OPEN',
    });
    assert.equal(harness.snapshot().invocations.length, 1);
    assert.equal(harness.snapshot().committed.length, 0);
  });
});

test('actual Core commit acknowledgement loss resolves and the mounted governed Read returns the original decision without rerunning the Action', async () => {
  const assertion = await makeAssertion();
  const decisions = new Map<string, typeof PartyMatchDecisionRecordSchema.Type>();
  let executions = 0;
  const harness = makeActionTestHarness({
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
              new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'Invalid actor' }),
          ),
        );
        if (actor.principalId !== principal.principalId || actor.tenantId !== principal.tenantId) {
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
  await withMountedApp(mounted(harness, assertion.environment, reads), async (app) => {
    const uncertain = await handle(
      app,
      commandRequest('create-party', createPayload, assertion.token, {
        'idempotency-key': 'uncertain-create',
      }),
    );
    assert.equal(uncertain.status, 503);
    const body = await uncertain.json();
    assert.ok(Schema.is(Schema.TaggedStruct('PartyCommandCommitIndeterminateProblem', {}))(body));
    assert.equal(body.resolution, 'RESOLVE_COMMIT');
    assert.equal(body.retryCommand, false);
    const invocationId = harness.snapshot().invocations[0]?.actionInvocationId;
    assert.ok(invocationId);
    assert.equal(body.invocationId, invocationId);
    assert.equal(harness.snapshot().committed.length, 1);
    const committedSnapshot = harness.snapshot();
    const deniedRecovery = await handle(app, recoveryRequest(invocationId, assertion.otherToken));
    assert.equal(deniedRecovery.status, 404);
    const resolution = await handle(app, recoveryRequest(invocationId, assertion.token));
    assert.equal(resolution.status, 200);
    assert.deepEqual(await resolution.json(), {
      _tag: 'PartyCommandCommitResolution',
      invocationId,
      retryCommand: false,
      state: 'COMMITTED',
    });
    const missingReadAuth = await handle(app, decisionRequest(invocationId));
    assert.equal(missingReadAuth.status, 401);
    const deniedRead = await handle(app, decisionRequest(invocationId, assertion.otherToken));
    assert.equal(deniedRead.status, 403);
    const recovered = await handle(app, decisionRequest(invocationId, assertion.token));
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), decisions.get(invocationId));
    const replay = await handle(
      app,
      commandRequest('create-party', createPayload, assertion.token, {
        'idempotency-key': 'uncertain-create',
      }),
    );
    assert.equal(replay.status, 409);
    const replayBody = await replay.json();
    assert.ok(
      Schema.is(Schema.TaggedStruct('PartyCommandAlreadyCommittedProblem', {}))(replayBody),
    );
    assert.equal(replayBody.invocationId, invocationId);
    assert.equal(replayBody.retryCommand, false);
    assert.equal(executions, 1);
    assert.deepEqual(harness.snapshot().committed, committedSnapshot.committed);
    assert.equal(harness.snapshot().invocations.length, 1);
  });
});
