#!/usr/bin/env node
/** Local sales-demo fixture repair: original Siampark bootstrap accounts belong in Siampark, not Obchodní firma.
 * Remove ONLY their four stale commercial legal_entity#member edges; all company 0021 grants remain untouched.
 * Run after both reset baselines and reset-permissions. No accounts, records, or other grants are reset.
 */
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { toLegalEntityAccessObjectId } from '@app/core-runtime';
import { Cause, Config, ConfigProvider, Console, Effect, Exit, Layer, Runtime, Schema } from 'effect';
import { bootstrapRelationshipRequest } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { demoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { siamparkRentalPersonas } from './permissions.mts';

class CompanyMembershipRepairInvalid extends Schema.TaggedError<CompanyMembershipRepairInvalid>()(
  'CompanyMembershipRepairInvalid',
  {
    message: Schema.String,
  },
) {}

const program = Effect.gen(function* repairCompanyMemberships() {
  const envPath = yield* Config.String('ONTOS_DEMO_ENV_FILE').pipe(
    Config.withDefault(new URL('../../.env', import.meta.url).pathname),
  );
  const configuration = yield* loadSpiceDbConfig({
    envPath,
  });
  if (
    configuration.deploymentEnvironment !== 'development' ||
    !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/u.test(configuration.endpoint)
  ) {
    return yield* new CompanyMembershipRepairInvalid({
      message: 'Company fixture repair requires local development SpiceDB',
    });
  }
  const resourceId = toLegalEntityAccessObjectId(demoTenantId, demoLegalEntityId);
  if (resourceId === undefined) {
    return yield* new CompanyMembershipRepairInvalid({ message: 'Invalid fixed demo company identity' });
  }
  const request = bootstrapRelationshipRequest(
    siamparkRentalPersonas.map(({ principalId }) => ({
      relation: 'member',
      resourceId,
      resourceType: 'legal_entity',
      subjectId: principalId,
      subjectType: 'principal',
    })),
  );
  for (const update of request.updates) {
    update.operation = v1.RelationshipUpdate_Operation.DELETE;
  }
  const client = yield* Effect.acquireRelease(
    Effect.try(() => openSpiceDbGrpcRpc(configuration, 5000)),
    (value) => Effect.sync(() => value.close()),
  );
  yield* client.writeRelationships(request);
  yield* Console.log(
    'Company fixture repair: removed four stale Siampark memberships in Obchodní firma; Siampark retained.',
  );
  return yield* Effect.void;
});

const executableLayer = Layer.effectDiscard(program).pipe(
  Layer.provide(
    Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
  ),
);

const abort = new AbortController();
const interrupt = (): void => {
  abort.abort();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const exit = await Effect.runPromiseExit(
  Effect.scoped(Layer.build(executableLayer)).pipe(
    Effect.tapCause((cause) =>
      Runtime.getErrorReported(Cause.squash(cause)) ? Console.error(Cause.pretty(cause)) : Effect.void,
    ),
  ),
  { signal: abort.signal },
);
process.off('SIGINT', interrupt);
process.off('SIGTERM', interrupt);
const outcomeCode = Exit.match(exit, {
  onFailure: (cause) => (Cause.hasInterruptsOnly(cause) ? 130 : Runtime.getErrorExitCode(Cause.squash(cause))),
  onSuccess: () => 0,
});
process.exitCode = outcomeCode;
