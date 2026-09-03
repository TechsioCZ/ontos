// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
/* eslint-disable no-await-in-loop, sort-keys, unicorn/no-await-expression-member -- Mounted HTTP lifecycle scenarios are intentionally sequential and assert decoded responses directly. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
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
import { archivePartyAction } from '../../src/actions/archive-party.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import {
  PartyEvidenceInsufficient,
  PartyPersistenceUnavailable,
} from '../../shared/domain/identity-contracts.ts';
import { PartyAliasWriteRejected } from '../../shared/domain/merge-alias-resolution.ts';
import { partyMatchDecisionReadApiLive } from '../../api/party-match-decision-read-server.ts';
import { PartyMatchDecisionRequestSchema } from '../../shared/apis/party-match-decision.ts';
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
const archivedParty = {
  archivedAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  displayName: 'Example organization',
  partyRef,
  partyType: 'ORGANIZATION' as const,
  revision: 1,
  updatedAt: '2026-09-01T00:00:00.000Z',
};
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

const makeAssertion = async (audience = 'party-registry') => {
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: 'EdDSA',
    kid: 'party-command-test',
    use: 'sig',
  };
  const token = await new SignJWT({ principal, ver: 1 })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'party-command-test', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(principal.principalId)
    .setIssuedAt()
    .setExpirationTime('5m')
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

const mounted = (
  harness: ReturnType<typeof makeActionTestHarness>,
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

test('every registered command is mounted and rejects missing structural input or authentication before the lifecycle', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
  const app = mounted(harness, assertion.environment);
  try {
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
    for (const endpoint of Object.values(partyRegistryApi.groups.partyCommands.endpoints)) {
      const response = await app.handler(
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
      assert.equal(
        body._tag,
        response.status === 400
          ? 'PartyCommandInvalidRequestProblem'
          : 'PartyCommandAuthenticationProblem',
      );
      assert.equal(body.status, response.status);
    }
    const malformed = await app.handler(
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
    assert.equal((await malformed.json())._tag, 'PartyCommandInvalidRequestProblem');
    assert.equal(harness.snapshot().invocations.length, 0);
  } finally {
    await app.dispose();
  }
});

test('missing, malformed, and wrong-audience assertions are challenged without creating invocations', async () => {
  for (const audience of ['party-registry', 'contacts']) {
    const assertion = await makeAssertion(audience);
    const harness = makeActionTestHarness();
    const app = mounted(harness, assertion.environment);
    try {
      const tokens = audience === 'contacts' ? [assertion.token] : [undefined, 'not-a-jwt'];
      for (const token of tokens) {
        const response = await app.handler(
          commandRequest('request-search-rebuild', {}, token, {
            'idempotency-key': 'authentication-test',
          }),
        );
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('www-authenticate'), 'Bearer');
        assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/u);
        const body = await response.json();
        assert.equal(body._tag, 'PartyCommandAuthenticationProblem');
        assert.equal(body.status, 401);
        assert.equal(JSON.stringify(body).includes(assertion.token), false);
      }
      assert.equal(harness.snapshot().invocations.length, 0);
    } finally {
      await app.dispose();
    }
  }
});

test('verification configuration unavailability is retryable and never reaches the lifecycle', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
  const app = mounted(harness, {});
  try {
    const response = await app.handler(
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'configuration-test',
      }),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('www-authenticate'), null);
    const body = await response.json();
    assert.equal(body._tag, 'PartyCommandUnavailableProblem');
    assert.equal(body.retryable, true);
    assert.equal(harness.snapshot().invocations.length, 0);
  } finally {
    await app.dispose();
  }
});

test('correlation and idempotency are mandatory before the Core Action lifecycle', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
  const app = mounted(harness, assertion.environment);
  try {
    const missingKey = await app.handler(
      commandRequest('request-search-rebuild', {}, assertion.token),
    );
    assert.equal(missingKey.status, 428);
    assert.equal((await missingKey.json())._tag, 'PartyCommandPreconditionRequiredProblem');
    const missingCorrelation = await app.handler(
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'correlation-test',
        'x-correlation-id': '',
      }),
    );
    assert.equal(missingCorrelation.status, 400);
    assert.equal((await missingCorrelation.json())._tag, 'PartyCommandInvalidRequestProblem');
    assert.equal(harness.snapshot().invocations.length, 0);
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
  const app = mounted(harness, assertion.environment);
  try {
    const response = await app.handler(
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'permission-test',
      }),
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json())._tag, 'PartyCommandForbiddenProblem');
    assert.equal(harness.snapshot().invocations.length, 1);
    assert.equal(harness.snapshot().permissionDenials.length, 1);
  } finally {
    await app.dispose();
  }
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
  const app = mounted(harness, assertion.environment);
  try {
    const response = await app.handler(
      commandRequest('archive-party', archivePayload, assertion.token, {
        'idempotency-key': 'conflict-test',
      }),
    );
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body._tag, 'PartyCommandConflictProblem');
    assert.equal(body.code, 'party_lifecycle_conflict');
    assert.equal(harness.snapshot().invocations.length, 1);
    assert.equal(harness.snapshot().committed.length, 0);
  } finally {
    await app.dispose();
  }
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
  const app = mounted(harness, assertion.environment);
  try {
    const response = await app.handler(
      commandRequest('archive-party', archivePayload, assertion.token, {
        'idempotency-key': 'alias-test',
      }),
    );
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body._tag, 'PartyCommandAliasWriteRejectedProblem');
    assert.deepEqual(body.aliasPartyRef, partyRef);
    assert.deepEqual(body.canonicalPartyRef, canonicalPartyRef);
    assert.equal(JSON.stringify(body).includes('Private diagnostic'), false);
    assert.equal(harness.snapshot().committed.length, 0);
  } finally {
    await app.dispose();
  }
});

test('committed request replay stays a terminal 409 and does not execute or emit twice', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    tenantPermission: 'allowed',
  });
  const app = mounted(harness, assertion.environment);
  try {
    const first = await app.handler(
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'replay-test',
      }),
    );
    assert.equal(first.status, 200);
    const result = await first.json();
    assert.equal(result.status, 'QUEUED');
    const { committed } = harness.snapshot();
    assert.equal(committed.length, 1);
    const replay = await app.handler(
      commandRequest('request-search-rebuild', {}, assertion.token, {
        'idempotency-key': 'replay-test',
      }),
    );
    assert.equal(replay.status, 409);
    const body = await replay.json();
    assert.equal(body._tag, 'PartyCommandAlreadyCommittedProblem');
    assert.equal(body.code, 'action_already_committed');
    assert.equal(body.invocationId, harness.snapshot().invocations[0]?.actionInvocationId);
    assert.equal(body.retryCommand, false);
    assert.equal(body.resolution, 'REFRESH_GOVERNED_READS');
    assert.equal(harness.snapshot().invocations.length, 1);
    assert.deepEqual(harness.snapshot().committed, committed);
  } finally {
    await app.dispose();
  }
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
  for (const item of cases) {
    const harness = makeActionTestHarness({
      actionPermission: 'allowed',
      tenantPermission: 'allowed',
      services: [item.service],
    });
    const app = mounted(harness, assertion.environment);
    try {
      const response = await app.handler(
        commandRequest('archive-party', archivePayload, assertion.token, {
          'idempotency-key': `failure-${item.status}`,
        }),
      );
      assert.equal(response.status, item.status);
      assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/u);
      const body = await response.json();
      assert.equal(body._tag, item.tag);
      assert.equal(body.status, item.status);
      assert.equal(JSON.stringify(body).includes('private'), false);
      if (item.status === 503) {
        assert.equal(body.retryable, true);
      }
      assert.equal(harness.snapshot().committed.length, 0);
    } finally {
      await app.dispose();
    }
  }
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
  const app = mounted(harness, assertion.environment);
  try {
    const response = await app.handler(
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
  } finally {
    await app.dispose();
  }
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
  const app = mounted(harness, assertion.environment);
  try {
    const first = await app.handler(
      commandRequest('create-party', createPayload, assertion.token, {
        'idempotency-key': 'hash-test',
      }),
    );
    assert.equal(first.status, 200);
    const changed = await app.handler(
      commandRequest(
        'create-party',
        { candidate: { ...createPayload.candidate, displayName: 'Different organization' } },
        assertion.token,
        { 'idempotency-key': 'hash-test' },
      ),
    );
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).code, 'action_request_hash_conflict');
    assert.equal(executions, 1);
    assert.equal(harness.snapshot().committed.length, 1);
  } finally {
    await app.dispose();
  }
});

test('commit resolution requires authentication and a valid invocation without creating an Action', async () => {
  const assertion = await makeAssertion();
  const harness = makeActionTestHarness();
  const app = mounted(harness, assertion.environment);
  try {
    const missingAuth = await app.handler(recoveryRequest(randomUUID()));
    assert.equal(missingAuth.status, 401);
    assert.equal(missingAuth.headers.get('www-authenticate'), 'Bearer');
    const malformed = await app.handler(recoveryRequest('not-an-id', assertion.token));
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json())._tag, 'PartyCommandInvalidRequestProblem');
    const absent = await app.handler(recoveryRequest(randomUUID(), assertion.token));
    assert.equal(absent.status, 404);
    assert.equal(harness.snapshot().invocations.length, 0);
  } finally {
    await app.dispose();
  }
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
  const app = mounted(harness, assertion.environment);
  try {
    const failed = await app.handler(
      commandRequest('archive-party', archivePayload, assertion.token, {
        'idempotency-key': 'pending-resolution',
      }),
    );
    assert.equal(failed.status, 409);
    const invocationId = harness.snapshot().invocations[0]?.actionInvocationId;
    assert.ok(invocationId);
    const resolution = await app.handler(recoveryRequest(invocationId, assertion.token));
    assert.equal(resolution.status, 200);
    assert.deepEqual(await resolution.json(), {
      _tag: 'PartyCommandCommitResolution',
      invocationId,
      retryCommand: false,
      state: 'OPEN',
    });
    assert.equal(harness.snapshot().invocations.length, 1);
    assert.equal(harness.snapshot().committed.length, 0);
  } finally {
    await app.dispose();
  }
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
              decidedAt: '2026-09-01T00:00:00.000Z',
              decisionRef,
              evidenceExplanation: [
                { reason: 'Verified creation evidence', ruleKey: 'creation-evidence' },
              ],
              matchRuleVersion: 'test-original-rule-v1',
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
  const app = mounted(harness, assertion.environment, reads);
  try {
    const uncertain = await app.handler(
      commandRequest('create-party', createPayload, assertion.token, {
        'idempotency-key': 'uncertain-create',
      }),
    );
    assert.equal(uncertain.status, 503);
    const body = await uncertain.json();
    assert.equal(body._tag, 'PartyCommandCommitIndeterminateProblem');
    assert.equal(body.resolution, 'RESOLVE_COMMIT');
    assert.equal(body.retryCommand, false);
    const invocationId = harness.snapshot().invocations[0]?.actionInvocationId;
    assert.ok(invocationId);
    assert.equal(body.invocationId, invocationId);
    assert.equal(harness.snapshot().committed.length, 1);
    const committedSnapshot = harness.snapshot();
    const deniedRecovery = await app.handler(recoveryRequest(invocationId, assertion.otherToken));
    assert.equal(deniedRecovery.status, 404);
    const resolution = await app.handler(recoveryRequest(invocationId, assertion.token));
    assert.equal(resolution.status, 200);
    assert.deepEqual(await resolution.json(), {
      _tag: 'PartyCommandCommitResolution',
      invocationId,
      retryCommand: false,
      state: 'COMMITTED',
    });
    const missingReadAuth = await app.handler(decisionRequest(invocationId));
    assert.equal(missingReadAuth.status, 401);
    const deniedRead = await app.handler(decisionRequest(invocationId, assertion.otherToken));
    assert.equal(deniedRead.status, 403);
    const recovered = await app.handler(decisionRequest(invocationId, assertion.token));
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), decisions.get(invocationId));
    const replay = await app.handler(
      commandRequest('create-party', createPayload, assertion.token, {
        'idempotency-key': 'uncertain-create',
      }),
    );
    assert.equal(replay.status, 409);
    const replayBody = await replay.json();
    assert.equal(replayBody._tag, 'PartyCommandAlreadyCommittedProblem');
    assert.equal(replayBody.invocationId, invocationId);
    assert.equal(replayBody.retryCommand, false);
    assert.equal(executions, 1);
    assert.deepEqual(harness.snapshot().committed, committedSnapshot.committed);
    assert.equal(harness.snapshot().invocations.length, 1);
  } finally {
    await app.dispose();
  }
});
