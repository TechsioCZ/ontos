import {
  ActionRuntime,
  createNonHumanPrincipalAction,
  LegalEntityContext,
  PrincipalResolver,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeTestAccessGateLayers } from '@app/core-runtime/testing/access-gate';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Option, Redacted, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeActionRuntimeDouble } from '../support/action-runtime-double.ts';
import { makeApiKeyServiceDouble, makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';
import {
  runPreproposalIdentityProtocol,
  runPreproposalIdentityRuntime,
} from '../support/preproposal-basis-identity.fixture.ts';
import type { PreproposalIdentityParticipants } from '../support/preproposal-basis-identity.fixture.ts';

const protocol = 'ontos.shell.preproposal-basis.identity.v1';
const principalId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const legalEntityId = '88888888-8888-4888-8888-888888888888';
const buyerBindingId = '55555555-5555-4555-8555-555555555555';
const origin = 'https://fixture.invalid';
const services = [
  {
    bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    name: 'ccc-reader',
    principalId: '33333333-3333-4333-8333-333333333333',
  },
  {
    bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    name: 'pricing-issuer',
    principalId: '44444444-4444-4444-8444-444444444444',
  },
  {
    bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
    name: 'catalog',
    principalId: '77777777-7777-4777-8777-777777777777',
  },
  {
    bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
    name: 'market-relay',
    principalId: '66666666-6666-4666-8666-666666666666',
  },
] as const;
const scriptedService = (name: string | undefined) =>
  Effect.fromNullishOr(services.find((service) => service.name === name)).pipe(Effect.orDie);
const identity = { displayName: 'Unit buyer', email: 'buyer@fixture.invalid', principalId, tenantId };
const tenantOnly = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: buyerBindingId,
  authContextRef: 'better-auth-session:fixture-tenant-session',
  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
  authMethod: 'session',
  principalId,
  tenantId,
});
const operator = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  ...tenantOnly,
  authContextRef: 'better-auth-session:fixture-session',
  legalEntityId,
});
const command = (body: Readonly<Record<string, string>>) => JSON.stringify({ protocol, ...body });
const createServiceKeys = command({ buyerPrincipalId: principalId, operation: 'CREATE_SERVICE_KEYS', tenantId });
const stop = command({ operation: 'STOP' });

/**
 * Scripted participants over the real service contracts. Each records the protocol step it served, so
 * the test reads the order the protocol drove them in.
 */
const participants = (options: { readonly boundBindingId?: string } = {}) => {
  const calls: string[] = [];
  const cookies: (string | null)[] = [];
  const createdPayloads: unknown[] = [];
  const managedPrincipalIds: (string | undefined)[] = [];
  let signIns = 0;
  const keys = makeApiKeyServiceDouble({
    verify: (rawKey) =>
      Effect.sync(() => {
        const name = /^inert-(?<name>.+)-key$/u.exec(rawKey)?.groups?.['name'];
        expect(name).toBeDefined();
        calls.push(`verify-${name}-key`);
        return { providerKeyId: `fixture-${name}-provider-key` };
      }),
  });
  const resolver = makePrincipalResolverDouble({
    resolveBetterAuthApiKey: (providerKeyId) =>
      Effect.sync(() => {
        expect(providerKeyId).toBe('fixture-Preproposal original buyer-provider-key');
        calls.push('resolve-buyer-binding');
        return {
          authBindingId: options.boundBindingId ?? buyerBindingId,
          displayName: 'Unit buyer',
          principalId,
          principalKind: 'human' as const,
          tenantId,
        };
      }),
  });
  const value: PreproposalIdentityParticipants = {
    authentication: {
      createFixtureUser: (email, name) =>
        Effect.sync(() => {
          calls.push('create-provider-user');
          expect(email).toMatch(/^preproposal-[0-9a-f-]{36}@fixture\.invalid$/u);
          expect(name).toBe('Preproposal native human buyer');
          return 'fixture-provider-user';
        }),
      resolveShellContext: (headers) =>
        Effect.sync(() => {
          calls.push('resolve-operator-context');
          cookies.push(headers.get('cookie'));
          return {
            availableLegalEntities: [],
            identity: { ...identity, legalEntityId, legalName: 'Fixture s.r.o.' },
            principal: operator,
            setCookieHeaders: [],
            state: 'authenticated' as const,
          };
        }),
      resolveTenantContext: (headers) =>
        Effect.sync(() => {
          calls.push('resolve-tenant-context');
          cookies.push(headers.get('cookie'));
          return { identity, principal: tenantOnly, setCookieHeaders: [], state: 'authenticated' as const };
        }),
      signIn: (_email, _password, headers) =>
        Effect.sync(() => {
          signIns += 1;
          calls.push(`sign-in-${signIns}`);
          expect(headers.get('origin')).toBe(origin);
          return { identity, setCookieHeaders: [`fixture=session-${signIns}; Path=/; HttpOnly`] };
        }),
    },
    keys,
    lifecycle: {
      createNonHumanPrincipal: (input) =>
        scriptedService(input.correlationId.split(':')[1]).pipe(
          Effect.map((service) => {
            calls.push('create');
            createdPayloads.push(input.payload);
            expect(input.principal).toBe(operator);
            return Schema.decodeUnknownSync(createNonHumanPrincipalAction.descriptor.resultSchema)({
              principalId: service.principalId,
              status: 'active',
            });
          }),
        ),
      issue: (input) =>
        (input.managedPrincipalId === undefined
          ? Effect.succeed(buyerBindingId)
          : scriptedService(input.name).pipe(Effect.map((service) => service.bindingId))
        ).pipe(
          Effect.map((authBindingId) => {
            calls.push('issue');
            managedPrincipalIds.push(input.managedPrincipalId);
            expect(input.principal).toBe(operator);
            return {
              authBindingId,
              cleanupPending: false,
              createdAt: '2026-11-01T00:00:00.000Z',
              enabled: true,
              expiresAt: null,
              name: input.name ?? null,
              secret: Redacted.make(`inert-${input.name}-key`),
              start: null,
            };
          }),
        ),
    },
    origin,
    resolver,
  };
  return { calls, cookies, createdPayloads, keys, managedPrincipalIds, resolver, value };
};

/** The services the session reads declare; the scripted participants never consult them. */
const sessionReadServices = Layer.mergeAll(
  makeTestAccessGateLayers(),
  Layer.succeed(LegalEntityContext, {
    listActiveForTenant: () => Effect.die('the protocol never lists companies'),
    validateSelection: () => Effect.die('the protocol never validates a selection'),
  }),
  NodeCrypto.layer,
);

const run = (value: PreproposalIdentityParticipants, commands: readonly string[]) => {
  const frames: string[] = [];
  return runPreproposalIdentityProtocol(value, {
    commands: Stream.fromIterable(commands),
    write: (line) => Effect.sync(() => frames.push(line)),
  }).pipe(Effect.as(frames), Effect.provide(sessionReadServices));
};

it.effect('creates the buyer user, answers one key command with five verified keys, and stops on STOP', () =>
  Effect.gen(function* fullProtocol() {
    const script = participants();
    const frames = yield* run(script.value, [createServiceKeys, stop]);
    expect(script.calls).toEqual([
      'create-provider-user',
      'sign-in-1',
      'resolve-operator-context',
      'issue',
      'verify-Preproposal original buyer-key',
      'resolve-buyer-binding',
      ...services.flatMap(({ name }) => ['create', 'issue', `verify-${name}-key`]),
      'sign-in-2',
      'resolve-tenant-context',
    ]);
    // Each session read presents only the cookie pair the preceding sign-in set.
    expect(script.cookies).toEqual(['fixture=session-1', 'fixture=session-2']);
    expect(script.managedPrincipalIds).toEqual([undefined, ...services.map((service) => service.principalId)]);
    expect(script.createdPayloads).toEqual(
      services.map(({ name }) => ({
        displayName: `Preproposal ${name}`,
        kind: 'service',
      })),
    );
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => frame.endsWith('\n'))).toBe(true);
    expect(frames[0]).toContain('"operation":"PROVIDER_USER_CREATED"');
    expect(frames[0]).toContain('"providerUserId":"fixture-provider-user"');
    expect(frames[1]).toContain('SERVICE_KEYS_CREATED');
    expect(frames[1]).toContain(`"buyer":{"authBindingId":"${buyerBindingId}","principalId":"${principalId}"`);
    expect(frames[1]).toContain('"tenant":{"authContextRef":"better-auth-session:fixture-tenant-session"}');
    for (const service of services) {
      expect(frames[1]).toContain(`fixture-${service.name}-provider-key`);
      expect(frames[1]).toContain(service.principalId);
      expect(frames[1]).toContain(service.bindingId);
    }
    expect(frames[2]).toContain('"operation":"STOPPED"');
  }),
);

/** The stage at which the protocol refused; completing, or failing any other way, fails the test. */
const refusal = (protocolRun: ReturnType<typeof run>) =>
  protocolRun.pipe(
    Effect.andThen(Effect.die('the identity protocol completed instead of refusing')),
    Effect.catchTag('PreproposalIdentityUnavailable', (refused) => Effect.succeed(refused.stage)),
    Effect.orDie,
  );

it.effect('refuses a buyer key the provider binds to another binding', () =>
  Effect.gen(function* foreignBuyerBinding() {
    const stage = yield* refusal(
      run(participants({ boundBindingId: '99999999-9999-4999-8999-999999999999' }).value, [createServiceKeys, stop]),
    );
    expect(stage).toBe('original-buyer-provider-binding');
  }),
);

it.effect('answers only one key command per child', () =>
  Effect.gen(function* repeatedSetup() {
    const stage = yield* refusal(run(participants().value, [createServiceKeys, createServiceKeys, stop]));
    expect(stage).toBe('single-setup-command');
  }),
);

it.effect('fails when the private input ends without STOP', () =>
  Effect.gen(function* missingStop() {
    const stage = yield* refusal(run(participants().value, [createServiceKeys]));
    expect(stage).toBe('stop-required');
  }),
);

/**
 * The context a construction or command saw: the staff registry with the audience the Shell admits,
 * beside Core's Actions and principal resolver. Core Actions read the registry from the fiber's
 * context, so a command that runs without it fails in production.
 */
const runtimeContext = Effect.gen(function* readRuntimeContext() {
  const registry = yield* Effect.serviceOption(AuthenticationNamespaceRegistry);
  const staff = Option.isSome(registry)
    ? yield* registry.value.lookup(STAFF_AUTHENTICATION_NAMESPACE_ID).pipe(Effect.orDie)
    : Option.none();
  return {
    actions: Option.isSome(yield* Effect.serviceOption(ActionRuntime)),
    resolver: Option.isSome(yield* Effect.serviceOption(PrincipalResolver)),
    staff: staff.pipe(
      Option.map(({ allowedAudiences, requiresOperationAdmission }) => ({
        allowedAudiences,
        requiresOperationAdmission,
      })),
    ),
  };
});

it.effect('builds Core with the staff registry and runs construction and every lifecycle command in it', () =>
  Effect.gen(function* identityRuntimeWiring() {
    const script = participants();
    const actions = makeActionRuntimeDouble([]).runtime;
    const seen: { readonly at: string; readonly context: Effect.Success<typeof runtimeContext> }[] = [];
    const observed = (at: string) =>
      runtimeContext.pipe(Effect.flatMap((context) => Effect.sync(() => seen.push({ at, context }))));
    const frames: string[] = [];
    yield* runPreproposalIdentityRuntime({
      authentication: observed('authentication-construction').pipe(Effect.as(script.value.authentication)),
      core: Layer.mergeAll(
        // Core's Action runtime takes the registry when it is built, as `makeActionRuntimeLive` does.
        Layer.effect(
          ActionRuntime,
          Effect.gen(function* actionRuntimeWithRegistry() {
            yield* AuthenticationNamespaceRegistry;
            return actions;
          }),
        ),
        Layer.succeed(PrincipalResolver, script.resolver),
        sessionReadServices,
      ),
      keys: script.keys,
      lifecycle: (actionRuntime, keys, resolver) => {
        expect(actionRuntime).toBe(actions);
        expect(keys).toBe(script.keys);
        expect(resolver).toBe(script.resolver);
        return {
          createNonHumanPrincipal: (input) =>
            observed('create').pipe(Effect.andThen(script.value.lifecycle.createNonHumanPrincipal(input))),
          issue: (input) => observed('issue').pipe(Effect.andThen(script.value.lifecycle.issue(input))),
        };
      },
      origin,
      transport: {
        commands: Stream.fromIterable([createServiceKeys, stop]),
        write: (line) => Effect.sync(() => frames.push(line)),
      },
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer));
    const staffShell = {
      actions: true,
      resolver: true,
      staff: Option.some({ allowedAudiences: ['shell-super-app'], requiresOperationAdmission: false }),
    };
    expect(seen).toEqual([
      { at: 'authentication-construction', context: staffShell },
      { at: 'issue', context: staffShell },
      ...services.flatMap(() => [
        { at: 'create', context: staffShell },
        { at: 'issue', context: staffShell },
      ]),
    ]);
    expect(frames).toHaveLength(3);
    expect(frames[2]).toContain('"operation":"STOPPED"');
  }),
);
