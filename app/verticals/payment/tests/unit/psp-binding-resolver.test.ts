import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { ScopedRoutineInvocationError } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Effect, Exit, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ConfigureProviderAccountBindingPayloadSchema,
  ConfigureProviderAccountBindingResultSchema,
} from '../../shared/actions/configure-provider-account-binding.ts';
import { RotateProviderCredentialResultSchema } from '../../shared/actions/rotate-provider-credential.ts';
import { GatewayProviderAccountRefSchema } from '../../shared/domain/psp-configuration.ts';
import { GatewayBindingResolver } from '../../src/integrations/psp/binding-resolver.ts';
import { GatewayBindingResolverLive } from '../../src/integrations/psp/binding-resolver-live.ts';

/**
 * #1155 worker-side binding resolution over a scripted routine invoker, and the public configuration contracts.
 * The native routines are proven in `psp-binding-configuration-postgres.test.ts`.
 */

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
const accountRef = Schema.decodeUnknownSync(GatewayProviderAccountRefSchema)(`pab_${'a'.repeat(32)}`);

interface RoutineCall {
  readonly args: readonly unknown[];
  readonly name: string;
}

interface TargetOverrides {
  readonly credentialStatus?: string;
  readonly returnUrl?: string;
  readonly status?: string;
}

const targetRow = (overrides: TargetOverrides = {}) => ({
  result: {
    bindingId,
    credentialRevision: 2,
    credentialSecretRef: 'gopay-sandbox-2',
    credentialStatus: 'ACTIVE',
    environment: 'SANDBOX',
    merchantIdentity: { _tag: 'GOPAY', goid: '8123456789' },
    notificationUrl: 'https://hooks.example.test/psp',
    providerAccountRef: accountRef,
    providerFamily: 'GOPAY',
    status: 'CURRENT',
    ...overrides,
  },
});

/** Answers each routine by name and environment argument; records every call. */
const scriptedScope = (
  answer: (name: string, args: readonly unknown[]) => readonly unknown[] | 'fail',
  calls: RoutineCall[],
): OutboxWorkerLegalEntityScope => {
  const routineInvoker: ScopedRoutineInvoker = {
    invoke: (routine, args) =>
      Effect.suspend(() => {
        calls.push({ args, name: routine.name });
        const rows = answer(routine.name, args);
        return rows === 'fail'
          ? Effect.fail(
              new ScopedRoutineInvocationError({
                code: 'scoped_routine_invocation_failed',
                constraint: Option.none(),
                ownerModuleKey: 'payment.core',
                postgresCode: Option.none(),
                reason: 'scripted failure',
                routineKey: routine.routineKey,
              }),
            )
          : Effect.succeed(Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(rows));
      }),
  };
  return {
    completionPublisher: { publish: () => Effect.die('unused completion publisher') },
    legalEntityId,
    routineInvoker,
    tenantId,
  };
};

const resolver = Effect.gen(function* liveResolver() {
  return yield* GatewayBindingResolver;
}).pipe(Effect.provide(GatewayBindingResolverLive));

describe('#1155 GatewayBindingResolver over the scoped routines', () => {
  it.effect('#1155 resolves the exact binding with its current ACTIVE credential and the enablement return URL', () =>
    Effect.gen(function* resolvesExactBinding() {
      const calls: RoutineCall[] = [];
      const scope = scriptedScope(
        () => [targetRow({ returnUrl: 'https://shop.example.test/return', status: 'RETIRED_FOR_NEW_INTENTS' })],
        calls,
      );
      const service = yield* resolver;
      const target = yield* service.resolveExecutionTarget({
        customerConfigurationId: Option.some(Schema.decodeUnknownSync(Schema.String)('cc-1')),
        environment: 'SANDBOX',
        providerAccountRef: accountRef,
        providerFamily: 'GOPAY',
        scope,
      });
      // A retired binding is still resolved for its historical operations; nothing else is substituted.
      expect(target.bindingId).toBe(bindingId);
      expect([target.binding.environment, target.binding.providerAccountRef, target.binding.providerFamily]).toEqual([
        'SANDBOX',
        accountRef,
        'GOPAY',
      ]);
      expect(target.credentialRevision).toBe(2);
      expect(target.credentialSecretRef).toBe('gopay-sandbox-2');
      expect([target.tenantId, target.legalEntityId]).toEqual([tenantId, legalEntityId]);
      expect(Option.getOrNull(target.returnUrl)).toBe('https://shop.example.test/return');
      expect(calls).toEqual([{ args: [accountRef, 'SANDBOX', 'cc-1'], name: 'psp_resolve_execution_target' }]);
    }),
  );

  it.effect('#1155 notification resolution never carries a return URL', () =>
    Effect.gen(function* notificationWithoutReturn() {
      const calls: RoutineCall[] = [];
      const service = yield* resolver;
      const target = yield* service.resolveForNotification({
        environment: 'SANDBOX',
        providerAccountRef: accountRef,
        providerFamily: 'GOPAY',
        scope: scriptedScope(() => [targetRow()], calls),
      });
      expect(Option.isNone(target.returnUrl)).toBe(true);
      expect(calls).toEqual([{ args: [accountRef, 'SANDBOX'], name: 'psp_resolve_notification_binding' }]);
    }),
  );

  it.effect('#1155 PSP environment is not interchangeable: a SANDBOX ref asked for LIVE is UNAVAILABLE', () =>
    Effect.gen(function* environmentMismatch() {
      const calls: RoutineCall[] = [];
      const scope = scriptedScope((_name, args) => (args[1] === 'SANDBOX' ? [targetRow()] : []), calls);
      const service = yield* resolver;
      const failure = yield* service
        .resolveExecutionTarget({
          customerConfigurationId: Option.none(),
          environment: 'LIVE',
          providerAccountRef: accountRef,
          providerFamily: 'GOPAY',
          scope,
        })
        .pipe(Effect.flip);
      expect([failure.code, failure.family, failure.reason]).toEqual([
        'gateway_provider_unavailable',
        'GOPAY',
        'environment_mismatch',
      ]);
      // The SANDBOX binding was only read to name the reason; it never became the target.
      expect(calls.map(({ args }) => args[1])).toEqual(['LIVE', 'SANDBOX']);
    }),
  );

  it.effect('#1155 a non-ACTIVE credential revision never authenticates', () =>
    Effect.gen(function* inactiveCredential() {
      const service = yield* resolver;
      const failure = yield* service
        .resolveForNotification({
          environment: 'SANDBOX',
          providerAccountRef: accountRef,
          providerFamily: 'GOPAY',
          scope: scriptedScope(() => [targetRow({ credentialStatus: 'RETIRED' })], []),
        })
        .pipe(Effect.flip);
      expect([failure.family, failure.reason]).toEqual(['GOPAY', 'credential_not_active']);
    }),
  );

  it.effect('#1155 an unknown ref, a binding of another family and an unreadable routine are UNAVAILABLE', () =>
    Effect.gen(function* unresolvable() {
      const service = yield* resolver;
      const unknown = yield* service
        .resolveForNotification({
          environment: 'SANDBOX',
          providerAccountRef: accountRef,
          providerFamily: 'STRIPE',
          scope: scriptedScope(() => [], []),
        })
        .pipe(Effect.flip);
      expect([unknown.family, unknown.reason]).toEqual(['STRIPE', 'binding_unknown']);
      const otherFamily = yield* service
        .resolveForNotification({
          environment: 'SANDBOX',
          providerAccountRef: accountRef,
          providerFamily: 'STRIPE',
          scope: scriptedScope(() => [targetRow()], []),
        })
        .pipe(Effect.flip);
      expect([otherFamily.family, otherFamily.reason]).toEqual(['STRIPE', 'binding_mismatch']);
      const unreadable = yield* service
        .resolveExecutionTarget({
          customerConfigurationId: Option.none(),
          environment: 'SANDBOX',
          providerAccountRef: accountRef,
          providerFamily: 'GOPAY',
          scope: scriptedScope(() => 'fail', []),
        })
        .pipe(Effect.flip);
      expect([unreadable.family, unreadable.reason]).toEqual(['GOPAY', 'resolver_routine_failed']);
    }),
  );
});

interface CreateFields {
  readonly environment: string;
  readonly merchantIdentity: Readonly<Record<string, string>>;
  readonly reason: string;
  readonly secretRef: string;
}

const createFields = (merchantIdentity: Readonly<Record<string, string>>): CreateFields => ({
  environment: 'SANDBOX',
  merchantIdentity,
  reason: 'Configure the sandbox account',
  secretRef: 'stripe-sandbox-1',
});

describe('#1155 configuration contracts', () => {
  it('#1155 the merchant identity must be the shape of its own family', () => {
    const decode = Schema.decodeUnknownExit(ConfigureProviderAccountBindingPayloadSchema);
    const accepted = (merchantIdentity: Readonly<Record<string, string>>, overrides: Partial<CreateFields> = {}) =>
      Exit.isSuccess(decode({ change: { _tag: 'CREATE', ...createFields(merchantIdentity), ...overrides } }));
    expect(accepted({ _tag: 'STRIPE', accountId: 'acct_1TestAccount' })).toBe(true);
    expect(accepted({ _tag: 'GOPAY', goid: '8123456789' })).toBe(true);
    expect(accepted({ _tag: 'COMGATE', merchantId: '123456' })).toBe(true);
    // Another family's identity field, a malformed id and an unknown family are all rejected.
    expect(accepted({ _tag: 'STRIPE', goid: '8123456789' })).toBe(false);
    expect(accepted({ _tag: 'GOPAY', goid: 'not-digits' })).toBe(false);
    expect(accepted({ _tag: 'PAYPAL', id: '1' })).toBe(false);
    // Secret refs with path characters are rejected.
    expect(accepted({ _tag: 'GOPAY', goid: '1' }, { secretRef: '../x' })).toBe(false);
    // N11: Payment builds the notification URL itself; a caller-supplied one is not part of the contract.
    const strict = Schema.decodeUnknownExit(ConfigureProviderAccountBindingPayloadSchema, {
      onExcessProperty: 'error',
    });
    const change = { _tag: 'CREATE', ...createFields({ _tag: 'GOPAY', goid: '1' }) };
    expect(Exit.isSuccess(strict({ change }))).toBe(true);
    expect(
      Exit.isSuccess(strict({ change: { ...change, notificationUrl: 'https://attacker.example.test/hook' } })),
    ).toBe(false);
  });

  it.effect('#1155 the binding view contains no secret_ref', () =>
    Effect.gen(function* viewHasNoSecret() {
      const binding = {
        bindingId,
        environment: 'SANDBOX',
        merchantIdentity: { _tag: 'GOPAY', goid: '8123456789' },
        providerAccountRef: accountRef,
        providerFamily: 'GOPAY',
        revision: 2,
        status: 'CURRENT',
      };
      const credential = { bindingId, credentialRevision: 2, status: 'ACTIVE' };
      const configured = yield* Schema.decodeUnknownEffect(ConfigureProviderAccountBindingResultSchema)({
        binding,
        configuredAt: '2026-11-12T10:00:00.000Z',
        credential,
      });
      const rotated = yield* Schema.decodeUnknownEffect(RotateProviderCredentialResultSchema)({
        binding,
        configuredAt: '2026-11-12T10:00:00.000Z',
        credential,
        retired: { bindingId, credentialRevision: 1, status: 'RETIRED' },
      });
      const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))([
        yield* Schema.encodeEffect(ConfigureProviderAccountBindingResultSchema)(configured),
        yield* Schema.encodeEffect(RotateProviderCredentialResultSchema)(rotated),
      ]);
      expect(encoded).not.toMatch(/secret/iu);
    }),
  );
});
