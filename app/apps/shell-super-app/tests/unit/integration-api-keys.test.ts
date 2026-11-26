import { createHash } from 'node:crypto';

import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth/minimal';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { DateTime, Effect, Exit, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeIdentityLifecycleService } from '../../api/auth/identity-lifecycle.ts';
import {
  CreateNonHumanPrincipalPayloadSchema,
  IssueManagedApiKeyPayloadSchema,
  ManagedApiKeyListItemSchema,
  RotateManagedApiKeyPayloadSchema,
} from '../../shared/browser-api.ts';
import { integrationEntries } from '../../src/routes/people/integrations-model.ts';
import { actionSuccess, makeActionRuntimeDouble } from '../support/action-runtime-double.ts';
import { makeApiKeyServiceDouble, makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000002',
  authContextRef: 'better-auth-session:integration-api-keys-test',
  authenticationNamespaceId: 'test.staff.better-auth.v1',
  authMethod: 'session',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
});
const integrationPrincipalId = '00000000-0000-4000-8000-000000000010';
const existingValue = 'SymmyHeldKeyValue0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
const issued = {
  createdAt: '2026-11-26T00:00:00.000Z',
  enabled: true,
  expiresAt: null,
  name: 'symmy',
  providerKeyId: 'provider-key-of-the-registered-value',
  secret: Redacted.make(existingValue),
  start: existingValue.slice(0, 6),
};
const issueInput = {
  correlationId: 'correlation-import',
  idempotencyKey: 'import-1',
  managedPrincipalId: integrationPrincipalId,
  managedScope: 'tenant-managed' as const,
  name: 'symmy',
  principal,
  requestHeaders: new Headers(),
  suppliedSecret: Redacted.make(existingValue),
};

it.effect('registers an existing key value through the provider and binds it like a generated tenant key', () =>
  Effect.gen(function* registersExistingValue() {
    const supplied: (string | undefined)[] = [];
    const actions = makeActionRuntimeDouble([
      actionSuccess({ authBindingId: '00000000-0000-4000-8000-000000000004', status: 'active' }),
    ]);
    const service = makeIdentityLifecycleService(
      actions.runtime,
      makeApiKeyServiceDouble({
        clearPendingCleanup: () => Effect.void,
        isRegistered: () => Effect.succeed(false),
        issue: (_headers, input) => {
          supplied.push(input.suppliedSecret === undefined ? undefined : Redacted.value(input.suppliedSecret));
          return Effect.succeed(issued);
        },
        pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      }),
      makePrincipalResolverDouble(),
    );
    const result = yield* service.issue(issueInput);
    expect(supplied).toEqual([existingValue]);
    expect(actions.payloads).toEqual([
      { principalId: integrationPrincipalId, providerSubjectId: issued.providerKeyId, scope: 'tenant-managed' },
    ]);
    expect(result.authBindingId).toBe('00000000-0000-4000-8000-000000000004');
    expect(Object.hasOwn(result, 'providerKeyId')).toBe(false);
  }),
);

it.effect('refuses a key value that is already registered, in any state, before the provider stores anything', () =>
  Effect.gen(function* refusesRegisteredValue() {
    const service = makeIdentityLifecycleService(
      makeActionRuntimeDouble([]).runtime,
      makeApiKeyServiceDouble({
        isRegistered: (value) => Effect.succeed(Redacted.value(value) === existingValue),
        pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      }),
      makePrincipalResolverDouble(),
    );
    const failure = yield* Effect.flip(service.issue(issueInput));
    expect(Predicate.isTagged(failure, 'IdentityLifecycleConflictError')).toBe(true);
  }),
);

const StoredApiKeySchema = Schema.Struct({ key: Schema.String, start: Schema.String });

it.effect('stores a registered value exactly as Better Auth stores a key it generated: its SHA-256 hash', () =>
  Effect.gen(function* storesNativeHash() {
    const at = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-26T00:00:00.000Z'));
    const database = {
      apikey: [],
      user: [
        {
          createdAt: at,
          email: 'owner@example.test',
          emailVerified: true,
          id: 'owner-user',
          name: 'Owner',
          updatedAt: at,
        },
      ],
    };
    const auth = betterAuth({
      database: memoryAdapter(database),
      logger: { disabled: true },
      plugins: [apiKey({ customKeyGenerator: () => existingValue, enableMetadata: true, references: 'user' })],
      secret: 'integration-api-keys-test-secret-0123456789',
    });
    const created = yield* Effect.promise(() =>
      auth.api.createApiKey({ body: { name: 'symmy', remaining: null, userId: 'owner-user' } }),
    );
    expect(created.key).toBe(existingValue);
    const [row] = yield* Schema.decodeUnknownEffect(Schema.Array(StoredApiKeySchema))(database.apikey);
    // The Shell verifies a key by this exact lookup (`apiKeyLookupHash`); the value itself is never stored.
    expect(row?.key).toBe(createHash('sha256').update(existingValue).digest('base64url'));
    expect(row?.start).toBe(existingValue.slice(0, 6));
    expect(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(database.apikey),
    ).not.toContain(existingValue);
  }),
);

/** The Shell's HTTP API decodes a request body through the schema's JSON codec. */
const decodeIssue = Schema.decodeUnknownEffect(Schema.toCodecJson(IssueManagedApiKeyPayloadSchema));
const decodeRotate = Schema.decodeUnknownEffect(Schema.toCodecJson(RotateManagedApiKeyPayloadSchema));
const decodeCreate = Schema.decodeUnknownEffect(Schema.toCodecJson(CreateNonHumanPrincipalPayloadSchema));
const decodeListItem = Schema.decodeUnknownEffect(Schema.toCodecJson(ManagedApiKeyListItemSchema));
const accepted = <A, E>(decoded: Effect.Effect<A, E>) => Effect.map(Effect.exit(decoded), Exit.isSuccess);
const keyRequest = { name: 'symmy', principalId: integrationPrincipalId };

it.effect('accepts an existing key value only for a tenant-managed key, and only a well-formed one', () =>
  Effect.gen(function* acceptsTenantValue() {
    expect(yield* accepted(decodeIssue({ ...keyRequest, scope: 'tenant-managed', secret: existingValue }))).toBe(true);
    expect(yield* accepted(decodeIssue({ ...keyRequest, scope: 'tenant-managed', secret: 'short' }))).toBe(false);
    expect(yield* accepted(decodeIssue({ ...keyRequest, scope: 'tenant-managed', secret: `${existingValue} ` }))).toBe(
      false,
    );
    // An agent key is always generated: a supplied value is never carried for it.
    const agent = yield* decodeIssue({ ...keyRequest, scope: 'company-agent', secret: existingValue });
    expect(Object.hasOwn(agent, 'secret')).toBe(false);
    expect(
      yield* accepted(
        decodeRotate({
          ...keyRequest,
          oldAuthBindingId: '00000000-0000-4000-8000-000000000004',
          reason: 'Symmy keeps its key',
          scope: 'tenant-managed',
          secret: existingValue,
        }),
      ),
    ).toBe(true);
  }),
);

it.effect('names a declared connector partner only for an integration principal', () =>
  Effect.gen(function* namesPartner() {
    expect(yield* accepted(decodeCreate({ displayName: 'Symmy', integrationKind: 'symmy', kind: 'integration' }))).toBe(
      true,
    );
    expect(yield* accepted(decodeCreate({ displayName: 'Symmy', kind: 'integration' }))).toBe(true);
    expect(yield* accepted(decodeCreate({ displayName: 'X', integrationKind: 'abra', kind: 'integration' }))).toBe(
      false,
    );
    const service = yield* decodeCreate({ displayName: 'Robot', integrationKind: 'symmy', kind: 'service' });
    expect(Object.hasOwn(service, 'integrationKind')).toBe(false);
  }),
);

it.effect('lists each integration once, with its partner, and nothing that is not an integration', () =>
  Effect.gen(function* foldsIntegrations() {
    const symmy = { displayName: 'Symmy', integrationKind: 'symmy', key: null, kind: 'integration' };
    const rows = yield* Effect.forEach(
      [
        { ...symmy, principalId: integrationPrincipalId, principalStatus: 'active' },
        { ...symmy, principalId: integrationPrincipalId, principalStatus: 'active' },
        {
          displayName: 'Robot',
          key: null,
          kind: 'service',
          principalId: '00000000-0000-4000-8000-000000000011',
          principalStatus: 'active',
        },
      ],
      (row) => decodeListItem(row),
    );
    expect(integrationEntries(rows)).toEqual([
      {
        displayName: 'Symmy',
        integrationKind: 'symmy',
        principalId: integrationPrincipalId,
        principalStatus: 'active',
      },
    ]);
  }),
);
