import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { ConfigProvider, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { requireOrderFinalizationWorker } from '../../src/services/order-commitment.service.ts';

const workerId = '20000000-0000-4000-8000-000000000001';
const namespace = 'order-finalization-admission-fixture';
const configuration = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    ONTOS_ORDER_FINALIZATION_WORKER_AUTHENTICATION_NAMESPACE_ID: namespace,
    ONTOS_ORDER_FINALIZATION_WORKER_PRINCIPAL_ID: workerId,
  }),
);
const principal = (overrides: Readonly<Record<string, string>> = {}) =>
  Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '10000000-0000-4000-8000-000000000001',
    authContextRef: 'api-key:worker-admission-fixture',
    authenticationNamespaceId: namespace,
    authMethod: 'api_key',
    legalEntityId: '30000000-0000-4000-8000-000000000001',
    principalId: workerId,
    tenantId: '40000000-0000-4000-8000-000000000001',
    ...overrides,
  });
const scope = (overrides: Readonly<Record<string, string>> = {}, verified = true) => {
  const context = { ...principal(overrides), correlationId: 'order-worker-admission-fixture' };
  return verified ? trustVerifiedGatewayPrincipalContext(context, 'a'.repeat(64)) : context;
};

// Pure admission tests use Core's explicit provenance seam. Genuine assertion
// issuance, signatures, replay redemption and native binding are integration gates.
describe('Order completion worker admission', () => {
  it.effect('does not turn matching raw API-key fields into a verified service caller', () =>
    Effect.gen(function* rejectRawApiKeyFields() {
      const failure = yield* requireOrderFinalizationWorker(scope({}, false)).pipe(Effect.flip);
      expect(failure.code).toBe('order_commitment_permission_denied');
    }).pipe(Effect.provide(configuration)),
  );
  it.effect('does not substitute a verified buyer session for the configured service', () =>
    Effect.gen(function* rejectBuyerSession() {
      const failure = yield* requireOrderFinalizationWorker(
        scope({ authContextRef: 'better-auth-session:buyer', authMethod: 'session' }),
      ).pipe(Effect.flip);
      expect(failure.code).toBe('order_commitment_permission_denied');
    }).pipe(Effect.provide(configuration)),
  );
  it.effect('binds configured service admission to both principal and authentication namespace', () =>
    Effect.gen(function* bindPrincipalAndNamespace() {
      const mismatches: readonly Readonly<Record<string, string>>[] = [
        { principalId: '50000000-0000-4000-8000-000000000001' },
        { authenticationNamespaceId: 'another-realm' },
      ];
      for (const selected of mismatches) {
        const failure = yield* requireOrderFinalizationWorker(scope(selected)).pipe(Effect.flip);
        expect(failure.code).toBe('order_commitment_permission_denied');
      }
    }).pipe(Effect.provide(configuration)),
  );
  it.effect('admits the exact verified API-key service without replacing its principal with a buyer', () =>
    Effect.gen(function* admitVerifiedApiKeyService() {
      expect(yield* requireOrderFinalizationWorker(scope())).toBe(workerId);
    }).pipe(Effect.provide(configuration)),
  );
  it.effect('fails unavailable when the worker identity is not configured', () =>
    Effect.gen(function* failUnavailableWithoutWorkerIdentity() {
      const failure = yield* requireOrderFinalizationWorker(scope()).pipe(Effect.flip);
      expect(failure.code).toBe('order_commitment_unavailable');
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
  );
});
