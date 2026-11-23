import { getReadServiceFactory } from '@app/core-runtime/testing/reads';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { Reactivity } from 'effect/reactivity';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { DemoSourceProcessingPolicySchema } from '../../shared/domain/demo-source-processing-policy.ts';
import { sourceProcessingEligibilityRead } from '../../src/api/source-processing-eligibility.read.ts';
import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../../../database/identity-enrollment.ts';
import { installOperationalScopeAt } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';

const policy = Schema.decodeUnknownSync(DemoSourceProcessingPolicySchema)({
  active: true,
  callers: [{ authMethod: 'api_key', principalId: '72000000-0000-4000-8000-000000000021' }],
  customerRouteId: '5158ef08-7315-57e1-a9ed-b0fef8cd9ac1',
  dataUse: 'DEMO_TEST_DATA_ONLY',
  effectiveFrom: '2026-11-23T00:00:00.000Z',
  groupRouteId: 'f637a6ec-865b-43bc-9c28-57783757f367',
  issuer: 'symmy-akros',
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
  namespace: 'akros-erp',
  policyId: 'akros-symmy-demo-test-data',
  purpose: 'DEMO_CUSTOMER_IMPORT_TESTING',
  reason: 'Operator-approved synthetic import testing',
  revision: 'v1',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
  validUntil: '2026-12-23T00:00:00.000Z',
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '72000000-0000-4000-8000-000000000025',
    authContextRef: 'demo:test:actual-caller',
    authMethod: 'api_key',
    legalEntityId: policy.legalEntityId,
    principalId: '72000000-0000-4000-8000-000000000021',
    tenantId: policy.tenantId,
  }),
  correlationId: 'demo-test',
};
const at = '2026-11-23T01:00:00.000Z';

it.effect('loads the stage demo policy through the real registered factory and native restricted scoped executor', () => {
  const statements: { readonly sql: string; readonly parameters: readonly unknown[] }[] = [];
  const connection = testSqlConnection((sql, parameters) => {
    statements.push({ sql, parameters });
    if (/^(?:begin|commit|rollback|savepoint|release savepoint)\b/iu.test(sql.trim())) return Effect.succeed([]);
    if (sql.includes('current_user')) {
      return Effect.succeed([{
        role: 'ontos_runtime',
        tenant_id: scope.tenantId,
        legal_entity_id: scope.legalEntityId,
        operation_at: new Date(at),
      }]);
    }
    if (sql.includes('demo_source_processing_policies')) return Effect.succeed([{ record: policy }]);
    return Effect.die('Unexpected SQL in readonly demo-policy factory proof');
  });
  const database = scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer));
  return Effect.gen(function* registeredFactory() {
    const executor = yield* testCoreDatabase;
    const actual = yield* executor.transaction((transaction) =>
      Effect.gen(function* nativeScopedFactory() {
        const { scoped } = yield* installOperationalScopeAt(transaction, scope, APP_DATABASE_IDENTITY_ENROLLMENT);
        expect('execute' in scoped).toBe(false);
        return yield* getReadServiceFactory(sourceProcessingEligibilityRead)(scoped, scope, 'offline-composition');
      }),
    );
    expect(actual.demo?.policy).toEqual(policy);
    const query = statements.find(({ sql }) => sql.includes('demo_source_processing_policies'));
    expect(query?.sql.trimStart().startsWith('select')).toBe(true);
    expect(query?.parameters).toContain(scope.tenantId);
    expect(query?.parameters).toContain(scope.legalEntityId);
    expect(query?.parameters).toContain('akros-symmy-demo-test-data');
  }).pipe(
    Effect.provide(database),
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({
      ONTOS_PRIVACY_DEMO_SOURCE_PROCESSING_ENABLED: true,
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    })),
  );
});
