#!/usr/bin/env node
/** Stage-only additive service grants and native isolated verification account provisioning. */
import { reconcileStageServicePrincipals } from '@app/core-runtime/install/stage-context-bootstrap';
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Console, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';

import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { toLegalEntityAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import type { SpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-rpc.ts';
import { OpsShellLive } from '../ops/ops-shell.mts';
import { readZeropsValue } from '../ops/stage-operations.mts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';
import {
  commercePortalPrincipal,
  commercePortalRelationships,
  privacyConsentAuthorityRelationships,
  privacyConsentPrincipal,
} from './commerce-portal.mts';
import { akrosDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { akrosStorefrontPrincipal, eshopDemoRoles, principalRelationships } from './permissions.mts';
import type { DemoAction } from './permissions.mts';
import { ensureStageVerification } from './ensure-stage-verification.mts';
import { verificationContext } from './verification-context.mts';

export class ServiceGrantError extends Schema.TaggedError<ServiceGrantError>()('ServiceGrantError', {
  reason: Schema.String,
}) {}
export type ServiceGrantRpc = Pick<SpiceDbRpc, 'readRelationships' | 'writeRelationships'>;
export const ServiceGrantModeSchema = Schema.Literals(['apply', 'check', 'verify']);
export type ServiceGrantMode = typeof ServiceGrantModeSchema.Type;
const consistent = v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });
// These are native SpiceDB object ids and relation names: none can contain a NUL separator.
const tupleKey = (relationship: v1.Relationship): string =>
  [
    relationship.resource?.objectType,
    relationship.resource?.objectId,
    relationship.relation,
    relationship.subject?.object?.objectType,
    relationship.subject?.object?.objectId,
    relationship.subject?.optionalRelation ?? '',
  ].join('\0');
const relationshipFrom = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
  subjectRelation?: string,
) =>
  v1.Relationship.create({
    relation,
    resource: { objectId: resourceId, objectType: resourceType },
    subject: { object: { objectId: subjectId, objectType: subjectType }, optionalRelation: subjectRelation ?? '' },
  });
const requestFor = (relationship: v1.Relationship) => {
  const { resource } = relationship;
  const subject = relationship.subject?.object;
  if (resource === undefined || subject === undefined || resource.objectId === '' || subject.objectId === '') {
    return Effect.fail(new ServiceGrantError({ reason: 'Refusing an unscoped authorization relationship read' }));
  }
  return Effect.succeed(
    v1.ReadRelationshipsRequest.create({
      consistency: consistent,
      relationshipFilter: v1.RelationshipFilter.create({
        optionalRelation: relationship.relation,
        optionalResourceId: resource.objectId,
        optionalSubjectFilter: v1.SubjectFilter.create({
          optionalSubjectId: subject.objectId,
          subjectType: subject.objectType,
        }),
        resourceType: resource.objectType,
      }),
    }),
  );
};
const isPresent = (rows: readonly v1.ReadRelationshipsResponse[], expected: v1.Relationship) =>
  rows.some(
    ({ relationship }) =>
      relationship !== undefined &&
      relationship.optionalCaveat === undefined &&
      relationship.optionalExpiresAt === undefined &&
      tupleKey(relationship) === tupleKey(expected),
  );

export const stageServicePrincipals = () =>
  [akrosStorefrontPrincipal, commercePortalPrincipal, privacyConsentPrincipal].map(
    ({ displayName, legalEntityId, principalId }) => ({
      displayName,
      legalEntityId,
      principalId,
      tenantId: demoTenantId,
    }),
  );

export const serviceGrantMemberships = (): readonly v1.Relationship[] => {
  const legalEntity = toLegalEntityAccessObjectId(demoTenantId, akrosDemoLegalEntityId);
  if (legalEntity === undefined) {
    return [];
  }
  return [akrosStorefrontPrincipal, commercePortalPrincipal, privacyConsentPrincipal].map(({ principalId }) =>
    relationshipFrom('legal_entity', legalEntity, 'member', 'principal', principalId),
  );
};
/** Missing memberships may be provisioned; conditional/expiring memberships must never be overwritten. */
export const assertServiceMembershipsCompatible = Effect.fn('Stage.assertServiceMembershipsCompatible')(
  function* assertServiceMembershipsCompatible(rpc: ServiceGrantRpc) {
    for (const membership of serviceGrantMemberships()) {
      const rows = yield* rpc.readRelationships(yield* requestFor(membership));
      if (
        rows.some(
          ({ relationship }) =>
            relationship !== undefined &&
            tupleKey(relationship) === tupleKey(membership) &&
            (relationship.optionalCaveat !== undefined || relationship.optionalExpiresAt !== undefined),
        )
      ) {
        return yield* new ServiceGrantError({
          reason: 'Existing service membership has a caveat or expiration; no grants changed',
        });
      }
    }
    return yield* Effect.void;
  },
);

export const desiredServiceGrants = (actions: readonly DemoAction[]): readonly v1.Relationship[] => {
  const source = [
    ...principalRelationships(
      akrosStorefrontPrincipal.principalId,
      eshopDemoRoles.akrosStorefront,
      actions,
      akrosDemoLegalEntityId,
    ),
    ...commercePortalRelationships(actions),
    ...privacyConsentAuthorityRelationships(actions),
  ];
  return [
    ...new Map(
      source.map((item) => {
        const relationship = relationshipFrom(
          item.resourceType,
          item.resourceId,
          item.relation,
          item.subjectType,
          item.subjectId,
          item.subjectRelation,
        );
        return [tupleKey(relationship), relationship];
      }),
    ).values(),
  ];
};

export const reconcileServiceGrants = Effect.fn('Stage.reconcileServiceGrants')(function* reconcileServiceGrantsEffect(
  rpc: ServiceGrantRpc,
  desired: readonly v1.Relationship[],
  mode: ServiceGrantMode,
) {
  yield* assertServiceMembershipsCompatible(rpc);
  const memberships = serviceGrantMemberships();
  if (memberships.length !== 3) {
    return yield* new ServiceGrantError({ reason: 'Invalid service company scope' });
  }
  // Check reports gaps so a first deployment can reach native provisioning in apply.
  for (const membership of memberships) {
    if (!isPresent(yield* rpc.readRelationships(yield* requestFor(membership)), membership)) {
      const reason = `Initial service membership is missing for ${membership.subject?.object?.objectId}; no grants changed`;
      if (mode !== 'check') {
        return yield* new ServiceGrantError({ reason });
      }
      yield* Console.log(reason);
    }
  }
  const missing: v1.Relationship[] = [];
  for (const relationship of desired) {
    if (!isPresent(yield* rpc.readRelationships(yield* requestFor(relationship)), relationship)) {
      missing.push(relationship);
    }
  }
  yield* Console.log(`Service grants ${mode}: desired=${desired.length} missing=${missing.length}`);
  if (mode === 'verify' && missing.length > 0) {
    return yield* new ServiceGrantError({ reason: `${missing.length} service grants are missing` });
  }
  if (mode !== 'apply' || missing.length === 0) {
    return { applied: 0, desired: desired.length, missing: missing.length };
  }
  yield* rpc.writeRelationships(
    v1.WriteRelationshipsRequest.create({
      updates: missing.map((relationship) =>
        v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship }),
      ),
    }),
  );
  for (const relationship of desired) {
    if (!isPresent(yield* rpc.readRelationships(yield* requestFor(relationship)), relationship)) {
      return yield* new ServiceGrantError({ reason: 'A service grant could not be verified after apply' });
    }
  }
  yield* Console.log(`Service grants verified: desired=${desired.length} applied=${missing.length} missing=0`);
  return { applied: missing.length, desired: desired.length, missing: 0 };
});

const escapeWorkflowValue = (value: string): string =>
  value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const zeropsConfiguration = Effect.gen(function* zeropsConfigurationEffect() {
  const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
  if (environment !== 'stage') {
    return yield* new ServiceGrantError({ reason: 'Zerops service grant reconciliation requires stage' });
  }
  const project = yield* Config.String('ZEROPS_PROJECT_ID');
  const ca = yield* readZeropsValue(project, 'spicedb_SPICEDB_GRPC_TLS_CERT');
  const key = yield* readZeropsValue(project, 'spicedb_SPICEDB_GRPC_PRESHARED_KEY');
  if (Option.getOrUndefined(yield* Config.String('GITHUB_ACTIONS').pipe(Config.option)) === 'true') {
    // GitHub consumes these workflow commands; neither value is emitted as ordinary log text.
    yield* Console.log(`::add-mask::${escapeWorkflowValue(Redacted.value(ca))}`);
    yield* Console.log(`::add-mask::${escapeWorkflowValue(Redacted.value(key))}`);
  }
  return yield* parseSpiceDbConfig({
    SPICEDB_CA_CERT: Redacted.value(ca),
    SPICEDB_ENDPOINT: 'spicedb:50051',
    SPICEDB_PRESHARED_KEY: Redacted.value(key),
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
  });
});
const environmentConfiguration = Effect.gen(function* environmentConfigurationEffect() {
  const values = yield* Config.all({
    ca: Config.Redacted('SPICEDB_CA_CERT'),
    endpoint: Config.String('SPICEDB_ENDPOINT'),
    environment: Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    key: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  });
  return yield* parseSpiceDbConfig({
    SPICEDB_CA_CERT: Redacted.value(values.ca),
    SPICEDB_ENDPOINT: values.endpoint,
    SPICEDB_PRESHARED_KEY: Redacted.value(values.key),
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: values.environment,
  });
});
type ReconciliationFailure =
  | Effect.Error<(typeof ActiveApplicationCompositionService)['Service']['load']>
  | Effect.Error<ReturnType<typeof reconcileServiceGrants>>
  | Effect.Error<typeof zeropsConfiguration>
  | Effect.Error<typeof environmentConfiguration>
  | Effect.Error<ReturnType<typeof discoverCurrentActions>>
  | Effect.Error<ReturnType<typeof reconcileStageServicePrincipals>>
  | Effect.Error<ReturnType<typeof ensureStageVerification>>
  | Effect.Error<ReturnType<typeof verificationContext>>;
const reportFailure = (error: ReconciliationFailure) =>
  Console.error(
    Schema.is(ServiceGrantError)(error)
      ? error.reason
      : 'Stage service reconciliation failed; credentials were not logged',
  );
const command = Command.make(
  'reconcile-stage-service-grants',
  {
    apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
    check: Flag.Boolean('check').pipe(Flag.withDefault(false)),
    verify: Flag.Boolean('verify').pipe(Flag.withDefault(false)),
    zerops: Flag.Boolean('zerops').pipe(Flag.withDefault(false)),
  },
  ({ apply, check, verify, zerops }) =>
    Effect.scoped(
      Effect.gen(function* reconcileStageServiceGrantsCommand() {
        if ([apply, check, verify].filter(Boolean).length > 1) {
          return yield* new ServiceGrantError({ reason: 'Select only one of --check, --apply or --verify' });
        }
        const configuration = yield* zerops ? zeropsConfiguration : environmentConfiguration;
        if (configuration.deploymentEnvironment !== 'stage' || configuration.endpoint !== 'spicedb:50051') {
          return yield* new ServiceGrantError({
            reason: 'Requires stage and native private spicedb:50051 with its pinned CA',
          });
        }
        const rpc = yield* Effect.acquireRelease(
          Effect.try({
            catch: () => new ServiceGrantError({ reason: 'Unable to open pinned SpiceDB client' }),
            try: () => openSpiceDbGrpcRpc(configuration, 10_000),
          }),
          (client) => Effect.sync(() => client.close()),
        );
        const source = yield* ActiveApplicationCompositionService;
        const actions = yield* discoverCurrentActions(yield* source.load);
        let mode: ServiceGrantMode = 'check';
        if (apply) {
          mode = 'apply';
        } else if (verify) {
          mode = 'verify';
        }
        yield* assertServiceMembershipsCompatible(rpc);
        // Check/verify stay read-only; only apply invokes the guarded native stage installer.
        if (mode === 'apply') {
          const inherited = yield* ConfigProvider.ConfigProvider;
          const provider = ConfigProvider.fromUnknown({
            SPICEDB_CA_CERT: configuration.caCertificate,
            SPICEDB_ENDPOINT: configuration.endpoint,
            SPICEDB_PRESHARED_KEY: configuration.preSharedKey,
            ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: configuration.deploymentEnvironment,
          }).pipe(ConfigProvider.orElse(inherited));
          yield* reconcileStageServicePrincipals(stageServicePrincipals(), provider);
          yield* ensureStageVerification(configuration);
        }
        const verification = yield* verificationContext(actions);
        const verificationGrants = verification.relationships.map((item) =>
          relationshipFrom(
            item.resourceType,
            item.resourceId,
            item.relation,
            item.subjectType,
            item.subjectId,
            item.subjectRelation,
          ),
        );
        const desired = yield* Effect.try({
          catch: () => new ServiceGrantError({ reason: 'Published scoped service policy is invalid' }),
          try: () => desiredServiceGrants(actions),
        });
        return yield* reconcileServiceGrants(rpc, [...desired, ...verificationGrants], mode);
      }),
    ).pipe(Effect.tapError(reportFailure)),
);

if (import.meta.main) {
  const services = Layer.mergeAll(
    OpsShellLive,
    ZeropsPublicApiLive,
    ActiveApplicationCompositionConfigLive.pipe(Layer.provide(ActiveApplicationCompositionSourceLive)),
  ).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(NodeServices.layer));
  const exit = await Effect.runPromiseExit(
    Layer.build(
      Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
        Layer.provide(services),
        Layer.provide(NodeServices.layer),
      ),
    ).pipe(Effect.scoped),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
