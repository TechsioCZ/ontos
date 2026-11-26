import { getReadServiceFactory } from '@app/core-runtime/testing/reads';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SourceSyncProcessingPolicySchema } from '@app/privacy-contracts/domain/source-sync-processing-policy';
import { sourceProcessingEligibilityRead } from '../../src/api/source-processing-eligibility.read.ts';
import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../../../database/identity-enrollment.ts';
import { installOperationalScopeAt } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { makeSourceSyncProcessingFixture } from '../support/source-sync-processing.fixture.ts';

const policy = Schema.decodeUnknownSync(SourceSyncProcessingPolicySchema)({
  active: true,
  callers: [{ authMethod: 'api_key', principalId: '72000000-0000-4000-8000-000000000021' }],
  customerRouteId: '5158ef08-7315-57e1-a9ed-b0fef8cd9ac1',
  dataUse: 'SOURCE_CUSTOMER_SYNC',
  effectiveFrom: '2026-11-23T00:00:00.000Z',
  groupRouteId: '5a6fb39a-c26e-4186-9dc2-5e410210d36c',
  issuer: 'symmy-akros',
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
  namespace: 'akros-erp',
  policyId: 'akros-symmy-source-sync-v2',
  purpose: 'CUSTOMER_IMPORT',
  reason: 'Operator-approved synthetic import testing',
  revision: 'v2',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
  validUntil: '2026-12-23T00:00:00.000Z',
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '72000000-0000-4000-8000-000000000025',
    authContextRef: 'sourceSync:test:actual-caller',
    authMethod: 'api_key',
    legalEntityId: policy.legalEntityId,
    principalId: '72000000-0000-4000-8000-000000000021',
    tenantId: policy.tenantId,
  }),
  correlationId: 'sourceSync-test',
};
const at = '2026-11-23T01:00:00.000Z';

it.effect(
  'loads the stage sourceSync policy through the real registered factory and native restricted scoped executor',
  () => {
    const { layer, statements } = makeSourceSyncProcessingFixture(scope, at, policy);
    return Effect.gen(function* registeredFactory() {
      const executor = yield* testCoreDatabase;
      const actual = yield* executor.transaction((transaction) =>
        Effect.gen(function* nativeScopedFactory() {
          const { scoped } = yield* installOperationalScopeAt(transaction, scope, APP_DATABASE_IDENTITY_ENROLLMENT);
          expect('execute' in scoped).toBe(false);
          return yield* getReadServiceFactory(sourceProcessingEligibilityRead)(scoped, scope, 'offline-composition');
        }),
      );
      expect(actual.sourceSync?.policy).toEqual(policy);
      const query = statements.find(({ sql }) => sql.includes('demo_source_processing_policies'));
      expect(query?.sql.trimStart().startsWith('select')).toBe(true);
      expect(query?.parameters).toContain(scope.tenantId);
      expect(query?.parameters).toContain(scope.legalEntityId);
      expect(query?.parameters).toContain('akros-symmy-source-sync-v2');
      expect(statements.some(({ sql }) => sql.includes('anti_resurrection_protections'))).toBe(false);
    }).pipe(Effect.provide(layer));
  },
);
