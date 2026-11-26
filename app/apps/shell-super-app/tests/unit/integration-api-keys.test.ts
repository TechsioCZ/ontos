import { createHash } from 'node:crypto';

import { ActionPermissionDenied, ActionTransactionError, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth/minimal';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { DateTime, Effect, Exit, Option, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ApiKeyProviderUnavailableError } from '../../api/auth/api-key-service.ts';
import { makeIdentityLifecycleService } from '../../api/auth/identity-lifecycle.ts';
import {
  CreateNonHumanPrincipalPayloadSchema,
  IssueManagedApiKeyPayloadSchema,
  ManagedApiKeyIssueResponseSchema,
  ManagedApiKeyListItemSchema,
  RotateManagedApiKeyPayloadSchema,
} from '../../shared/browser-api.ts';
import { integrationEntries } from '../../src/routes/people/integrations-model.ts';
import { actionCoreFailure, actionSuccess, makeActionRuntimeDouble } from '../support/action-runtime-double.ts';
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
const registered = {
  createdAt: '2026-11-26T00:00:00.000Z',
  enabled: true,
  expiresAt: null,
  name: 'symmy',
  providerKeyId: 'provider-key-of-the-registered-value',
  start: existingValue.slice(0, 6),
};
const authBindingId = '00000000-0000-4000-8000-000000000004';
const registerInput = {
  correlationId: 'correlation-import',
  idempotencyKey: 'import-1',
  managedPrincipalId: integrationPrincipalId,
  managedScope: 'tenant-managed' as const,
  name: 'symmy',
  principal,
  requestHeaders: new Headers(),
  suppliedSecret: Redacted.make(existingValue),
};
const noPendingCleanup = () => Effect.succeed({ hasMore: false, providerKeyIds: [] });
const providerUnavailable = new ApiKeyProviderUnavailableError({
  code: 'api_key_provider_unavailable',
  reason: 'The provider is unavailable',
});
const bindingHolder = (principalId: string) => ({
  authBindingId,
  displayName: 'Symmy',
  principalId,
  principalKind: 'integration' as const,
  tenantId: principal.tenantId,
});

it.effect('registers an existing value, binds it like a generated tenant key and never answers the value', () =>
  Effect.gen(function* registersExistingValue() {
    const supplied: string[] = [];
    const actions = makeActionRuntimeDouble([actionSuccess({ authBindingId, status: 'active' })]);
    const service = makeIdentityLifecycleService(
      actions.runtime,
      makeApiKeyServiceDouble({
        clearPendingCleanup: () => Effect.void,
        pendingCleanup: noPendingCleanup,
        register: (_headers, input) => {
          supplied.push(Redacted.value(input.secret));
          return Effect.succeed(registered);
        },
        registeredKeyId: () => Effect.succeed(Option.none()),
      }),
      makePrincipalResolverDouble(),
    );
    const result = yield* service.register(registerInput);
    expect(supplied).toEqual([existingValue]);
    expect(actions.payloads).toEqual([
      { principalId: integrationPrincipalId, providerSubjectId: registered.providerKeyId, scope: 'tenant-managed' },
    ]);
    expect(result.authBindingId).toBe(authBindingId);
    expect(Object.hasOwn(result, 'providerKeyId')).toBe(false);
    // The value is the integration's own: neither the result nor its HTTP answer carries it.
    expect(Object.hasOwn(result, 'secret')).toBe(false);
    const answered = yield* Schema.encodeEffect(Schema.toCodecJson(ManagedApiKeyIssueResponseSchema))(
      yield* Schema.decodeUnknownEffect(ManagedApiKeyIssueResponseSchema)(result),
    );
    expect(JSON.stringify(answered)).not.toContain('"secret"');
    expect(JSON.stringify(answered)).not.toContain(existingValue);
  }),
);

it.effect('refuses a value another principal holds, without running a bind or storing anything', () =>
  Effect.gen(function* refusesRegisteredValue() {
    const actions = makeActionRuntimeDouble([]);
    const service = makeIdentityLifecycleService(
      actions.runtime,
      makeApiKeyServiceDouble({
        pendingCleanup: noPendingCleanup,
        registeredKeyId: () => Effect.succeed(Option.some(registered.providerKeyId)),
      }),
      makePrincipalResolverDouble({
        resolveBetterAuthApiKey: () => Effect.succeed(bindingHolder('00000000-0000-4000-8000-000000000099')),
      }),
    );
    const failure = yield* Effect.flip(service.register(registerInput));
    expect(Predicate.isTagged(failure, 'IdentityLifecycleConflictError')).toBe(true);
    expect(actions.payloads).toEqual([]);
  }),
);

it.effect('answers the original result when the same request is retried after it registered the value', () =>
  Effect.gen(function* replaysRegistration() {
    const actions = makeActionRuntimeDouble([actionSuccess({ authBindingId, status: 'active' })]);
    const service = makeIdentityLifecycleService(
      actions.runtime,
      makeApiKeyServiceDouble({
        metadata: () => Effect.succeed(registered),
        pendingCleanup: noPendingCleanup,
        registeredKeyId: () => Effect.succeed(Option.some(registered.providerKeyId)),
      }),
      makePrincipalResolverDouble({
        resolveBetterAuthApiKey: () => Effect.succeed(bindingHolder(integrationPrincipalId)),
      }),
    );
    const result = yield* service.register(registerInput);
    expect(result).toMatchObject({ authBindingId, cleanupPending: false, start: registered.start });
    expect(Object.hasOwn(result, 'secret')).toBe(false);
    // The same bind again, under the same idempotency key, so the runtime answers its saved reply.
    expect(actions.payloads).toEqual([
      { principalId: integrationPrincipalId, providerSubjectId: registered.providerKeyId, scope: 'tenant-managed' },
    ]);
  }),
);

it.effect('refuses the loser of two concurrent registrations of one value as already registered', () =>
  Effect.gen(function* losesRace() {
    const lookups: string[] = [];
    const service = makeIdentityLifecycleService(
      makeActionRuntimeDouble([]).runtime,
      makeApiKeyServiceDouble({
        pendingCleanup: noPendingCleanup,
        // The twin committed between the check and the create; auth.apikey(key) refused this one.
        register: () => Effect.fail(providerUnavailable),
        registeredKeyId: () => {
          lookups.push('lookup');
          return Effect.succeed(lookups.length === 1 ? Option.none() : Option.some(registered.providerKeyId));
        },
      }),
      makePrincipalResolverDouble(),
    );
    const failure = yield* Effect.flip(service.register(registerInput));
    expect(Predicate.isTagged(failure, 'IdentityLifecycleConflictError')).toBe(true);
  }),
);

it.effect('removes the provider key of a refused binding, so the value can be registered again', () =>
  Effect.gen(function* removesRefused() {
    const removed: string[] = [];
    const disabled: string[] = [];
    const denied = new ActionPermissionDenied({ code: 'action_permission_denied', reason: 'Not an administrator' });
    const service = makeIdentityLifecycleService(
      makeActionRuntimeDouble([actionCoreFailure(denied)]).runtime,
      makeApiKeyServiceDouble({
        pendingCleanup: noPendingCleanup,
        register: () => Effect.succeed(registered),
        registeredKeyId: () => Effect.succeed(Option.none()),
        removeUnbound: (keyId) => Effect.sync(() => removed.push(keyId)),
        setEnabled: (keyId) => Effect.sync(() => disabled.push(keyId)).pipe(Effect.as(registered)),
      }),
      makePrincipalResolverDouble(),
    );
    const failure = yield* Effect.flip(service.register(registerInput));
    expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
    expect(removed).toEqual([registered.providerKeyId]);
    expect(disabled).toEqual([]);
  }),
);

it.effect('keeps, disabled, the provider key of a bind that may have committed', () =>
  Effect.gen(function* keepsIndeterminate() {
    const removed: string[] = [];
    const disabled: string[] = [];
    const transactionFailed = new ActionTransactionError({ code: 'action_transaction_failed', reason: 'Lost commit' });
    const service = makeIdentityLifecycleService(
      makeActionRuntimeDouble([actionCoreFailure(transactionFailed)]).runtime,
      makeApiKeyServiceDouble({
        clearPendingCleanup: () => Effect.void,
        pendingCleanup: noPendingCleanup,
        register: () => Effect.succeed(registered),
        registeredKeyId: () => Effect.succeed(Option.none()),
        removeUnbound: (keyId) => Effect.sync(() => removed.push(keyId)),
        setEnabled: (keyId) => Effect.sync(() => disabled.push(keyId)).pipe(Effect.as(registered)),
      }),
      makePrincipalResolverDouble(),
    );
    yield* Effect.flip(service.register(registerInput));
    expect(disabled).toEqual([registered.providerKeyId]);
    expect(removed).toEqual([]);
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
