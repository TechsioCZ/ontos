import type { OperationalScope } from '@app/core-runtime';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import type { SourceSyncProcessingPolicy } from '../../shared/domain/source-sync-processing-policy.ts';

export const makeSourceSyncProcessingFixture = (
  scope: OperationalScope,
  at: string,
  policy: SourceSyncProcessingPolicy,
) => {
  const statements: { readonly parameters: readonly unknown[]; readonly sql: string }[] = [];
  const connection = testSqlConnection((sql, parameters) => {
    statements.push({ parameters, sql });
    if (/^(?:begin|commit|rollback|savepoint|release savepoint)\b/iu.test(sql.trim())) {
      return Effect.succeed([]);
    }
    if (sql.includes('current_user')) {
      return Effect.succeed([
        {
          legal_entity_id: scope.legalEntityId,
          operation_at: new Date(at),
          role: 'ontos_runtime',
          tenant_id: scope.tenantId,
        },
      ]);
    }
    if (sql.includes('demo_source_processing_policies')) {
      return Effect.succeed([{ record: policy }]);
    }
    if (sql.startsWith('select ') && sql.includes('anti_resurrection_protections')) {
      return Effect.succeed([]);
    }
    return Effect.die('Unexpected SQL in readonly sourceSync-policy fixture');
  });
  const layer = Layer.mergeAll(
    scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer)),
    NodeCrypto.layer,
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED: true,
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
      }),
    ),
  );
  return { layer, statements };
};
