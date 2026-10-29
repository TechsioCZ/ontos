#!/usr/bin/env node
/** Stage-only canonical schema, additive service/admin role policy and isolated verification provisioning. */
import { reconcileStageServicePrincipals } from '@app/core-runtime/install/stage-context-bootstrap';
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Console, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { toLegalEntityAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
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
  akrosStorefrontPrincipal,
  eshopDemoRoles,
  principalRelationships,
  companyAdministratorWorkforceRelationships,
} from './permissions.mts';
import { administrators } from './accounts-admin-grants.mts';
import { akrosDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';

import type { DemoAction } from './permissions.mts';
import { ensureStageVerification } from './ensure-stage-verification.mts';
import { verificationContext } from './verification-context.mts';

export class ServiceGrantError extends Schema.TaggedError<ServiceGrantError>()('ServiceGrantError', {
  reason: Schema.String,
}) {}
export type ServiceGrantRpc = Pick<SpiceDbRpc, 'readRelationships' | 'writeRelationships'>;
export const ServiceGrantModeSchema = Schema.Literals(['apply', 'check', 'verify']);
export type ServiceGrantMode = typeof ServiceGrantModeSchema.Type;
export type StagePermissionSchemaRpc = Pick<SpiceDbRpc, 'diffSchema' | 'readSchema' | 'writeSchema'>;

/** Native WriteSchema atomically refuses removals still used by live relationships, including subjects. */
export const reconcileStagePermissionSchema = Effect.fn('Stage.reconcilePermissionSchema')(
  function* reconcileStagePermissionSchemaEffect(rpc: StagePermissionSchemaRpc, mode: ServiceGrantMode) {
    const read = rpc
      .readSchema(v1.ReadSchemaRequest.create({}))
      .pipe(
        Effect.mapError(() => new ServiceGrantError({ reason: 'Unable to read the live stage permission schema' })),
      );
    // Compare the exact snapshot just read with the native compiler. Text comparison is unsafe:
    // ReadSchema normalizes definition order, formatting and parentheses using SpiceDB precedence.
    const readDiff = Effect.gen(function* readCanonicalSchemaDiff() {
      const live = yield* read;
      if (live.readAt === undefined || live.readAt.token.length === 0) {
        return yield* new ServiceGrantError({ reason: 'Live stage permission schema has no verifiable read revision' });
      }
      return yield* rpc
        .diffSchema(
          v1.DiffSchemaRequest.create({
            comparisonSchema: ONTOS_SPICEDB_SCHEMA,
            consistency: { requirement: { atExactSnapshot: live.readAt, oneofKind: 'atExactSnapshot' } },
          }),
        )
        .pipe(
          Effect.mapError(
            () => new ServiceGrantError({ reason: 'Unable to compare the live stage permission schema natively' }),
          ),
        );
    });
    const { diffs } = yield* readDiff;
    const differs = diffs.length > 0;
    yield* Console.log(`Stage permission schema ${mode}: differs=${String(differs)}`);
    if (!differs) {
      return { applied: false, differs: false };
    }
    if (mode === 'verify') {
      return yield* new ServiceGrantError({ reason: 'Live stage permission schema differs from the canonical schema' });
    }
    if (mode === 'check') {
      return { applied: false, differs: true };
    }
    const removals = diffs.flatMap(({ diff }) => {
      if (diff.oneofKind === 'relationRemoved') {
        return [`${diff.relationRemoved.parentDefinitionName}#${diff.relationRemoved.name}`];
      }
      if (diff.oneofKind === 'definitionRemoved') {
        return [diff.definitionRemoved.name];
      }
      if (diff.oneofKind === 'relationSubjectTypeRemoved' && diff.relationSubjectTypeRemoved.relation !== undefined) {
        const { relation } = diff.relationSubjectTypeRemoved;
        return [`${relation.parentDefinitionName}#${relation.name} (subject type)`];
      }
      return [];
    });
    yield* rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })).pipe(
      Effect.mapError(
        ({ code }) =>
          new ServiceGrantError({
            reason: Option.exists(code, (status) => status === 3 || status === 9)
              ? `Native WriteSchema refused the canonical stage schema: incompatible schema or live relationships still use a removed relation/subject type. Proposed removals: ${removals.slice(0, 10).join(', ') || 'none'}. Reconcile explicitly; no relationships were deleted.`
              : 'Native WriteSchema failed; stage grants were not applied and credentials were not logged',
          }),
      ),
    );
    if ((yield* readDiff).diffs.length > 0) {
      return yield* new ServiceGrantError({
        reason: 'Stage permission schema readback differs from the canonical schema; no grants applied',
      });
    }
    yield* Console.log('Stage permission schema verified against the canonical schema');
    return { applied: true, differs: false };
  },
);
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
const requestFor = (relationship: v1.Relationship): Effect.Effect<v1.ReadRelationshipsRequest, ServiceGrantError> => {
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

/** Reconcile only role policy: absent or revoked human memberships must stay absent. */
export const desiredCompanyAdministratorWorkforceGrants = (): readonly v1.Relationship[] =>
  [...new Set(administrators.map(({ legalEntityId }) => legalEntityId))].flatMap((legalEntityId) =>
    companyAdministratorWorkforceRelationships(legalEntityId).map((item) =>
      relationshipFrom(
        item.resourceType,
        item.resourceId,
        item.relation,
        item.subjectType,
        item.subjectId,
        item.subjectRelation,
      ),
    ),
  );

const GRANT_SCAN_PAGE_SIZE = 256;
const GRANT_SCAN_MAX_PAGES = 128;

const matchesGrantFilter = (relationship: v1.Relationship, filter: v1.RelationshipFilter) =>
  relationship.resource?.objectType === filter.resourceType &&
  relationship.relation === filter.optionalRelation &&
  relationship.subject?.object?.objectType === filter.optionalSubjectFilter?.subjectType &&
  relationship.subject?.object?.objectId === filter.optionalSubjectFilter?.optionalSubjectId;

/** Cursor hashes include consistency: acquire a fresh revision before starting the exact-snapshot scan. */
const readGrantRevision = (rpc: ServiceGrantRpc, relationshipFilter: v1.RelationshipFilter) =>
  Effect.gen(function* readGrantRevisionEffect() {
    const rows = yield* rpc.readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency: consistent,
        optionalLimit: 1,
        relationshipFilter,
      }),
    );
    if (rows.length === 0) {
      return Option.none<v1.ZedToken>();
    }
    const [first] = rows;
    if (rows.length !== 1 || first.readAt === undefined || first.readAt.token === '') {
      return yield* new ServiceGrantError({ reason: 'Service grant scan has no verifiable read revision' });
    }
    return Option.some(first.readAt);
  });

/** Bound each type/relation scan to one desired subject, never the entire stage population. */
const readGrantSlice = (rpc: ServiceGrantRpc, relationshipFilter: v1.RelationshipFilter) =>
  Effect.gen(function* readGrantSliceEffect() {
    const present = new Set<string>();
    const cursors = new Set<string>();
    const revision = yield* readGrantRevision(rpc, relationshipFilter);
    if (Option.isNone(revision)) {
      return present;
    }
    let cursor: v1.Cursor | undefined;
    for (let page = 0; page < GRANT_SCAN_MAX_PAGES; page += 1) {
      const rows = yield* rpc.readRelationships(
        v1.ReadRelationshipsRequest.create({
          consistency: { requirement: { atExactSnapshot: revision.value, oneofKind: 'atExactSnapshot' } },
          optionalCursor: cursor,
          optionalLimit: GRANT_SCAN_PAGE_SIZE,
          relationshipFilter,
        }),
      );
      if (rows.length > GRANT_SCAN_PAGE_SIZE) {
        return yield* new ServiceGrantError({ reason: 'Service grant scan exceeded its page limit' });
      }
      for (const row of rows) {
        const { readAt, relationship } = row;
        if (
          readAt === undefined ||
          readAt.token.length === 0 ||
          readAt.token !== revision.value.token ||
          relationship === undefined ||
          !matchesGrantFilter(relationship, relationshipFilter)
        ) {
          return yield* new ServiceGrantError({ reason: 'Service grant scan returned unverifiable evidence' });
        }
        if (relationship.optionalCaveat === undefined && relationship.optionalExpiresAt === undefined) {
          present.add(tupleKey(relationship));
        }
      }
      if (rows.length < GRANT_SCAN_PAGE_SIZE) {
        return present;
      }
      cursor = rows.at(-1)?.afterResultCursor;
      if (cursor === undefined || cursor.token.length === 0 || cursors.has(cursor.token)) {
        return yield* new ServiceGrantError({ reason: 'Service grant scan did not advance' });
      }
      cursors.add(cursor.token);
    }
    return yield* new ServiceGrantError({ reason: 'Service grant scan exceeded its page budget' });
  });

export const readMissingServiceGrants = (rpc: ServiceGrantRpc, desired: readonly v1.Relationship[]) =>
  Effect.gen(function* readMissingServiceGrantsEffect() {
    const filters = new Map<string, v1.RelationshipFilter>();
    for (const relationship of desired) {
      const request = yield* requestFor(relationship);
      const filter = request.relationshipFilter;
      if (filter === undefined || filter.resourceType === '' || filter.optionalRelation === '') {
        return yield* new ServiceGrantError({ reason: 'Refusing an unscoped service grant scan' });
      }
      const slice = v1.RelationshipFilter.create({ ...filter, optionalResourceId: '' });
      filters.set(v1.RelationshipFilter.toJsonString(slice), slice);
    }
    const slices = yield* Effect.forEach([...filters.values()], (filter) => readGrantSlice(rpc, filter), {
      concurrency: 8,
    });
    const present = new Set(slices.flatMap((slice) => [...slice]));
    return desired.filter((relationship) => !present.has(tupleKey(relationship)));
  });

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
  const missing = yield* readMissingServiceGrants(rpc, desired);
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
  if ((yield* readMissingServiceGrants(rpc, desired)).length > 0) {
    return yield* new ServiceGrantError({ reason: 'A service grant could not be verified after apply' });
  }
  yield* Console.log(`Service grants verified: desired=${desired.length} applied=${missing.length} missing=0`);
  return { applied: missing.length, desired: desired.length, missing: 0 };
});

/** Run only after native principal/account provisioning; the remaining grant writes are SpiceDB-only. */
export const verifyDatabaseAndReconcileServiceGrants = <E, R>(
  rpc: ServiceGrantRpc,
  desired: readonly v1.Relationship[],
  verify: Effect.Effect<void, E, R>,
) => Effect.all([verify, reconcileServiceGrants(rpc, desired, 'apply')], { concurrency: 2, discard: true });

const verifyStageDatabase = Effect.gen(function* verifyStageDatabaseEffect() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* spawner.exitCode(
    ChildProcess.make(process.execPath, [new URL('../verify-application-db-schema.mts', import.meta.url).pathname], {
      stderr: 'inherit',
      stdout: 'inherit',
    }),
  );
  if (code !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new ServiceGrantError({ reason: 'Application database verification failed' });
  }
  return yield* Effect.void;
}).pipe(Effect.scoped);

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
    verifyDatabase: Flag.Boolean('verify-database').pipe(Flag.withDefault(false)),
    zerops: Flag.Boolean('zerops').pipe(Flag.withDefault(false)),
  },
  ({ apply, check, verify, verifyDatabase, zerops }) =>
    Effect.scoped(
      Effect.gen(function* reconcileStageServiceGrantsCommand() {
        if ([apply, check, verify].filter(Boolean).length > 1) {
          return yield* new ServiceGrantError({ reason: 'Select only one of --check, --apply or --verify' });
        }
        if (verifyDatabase && !apply) {
          return yield* new ServiceGrantError({ reason: '--verify-database requires --apply' });
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
        yield* reconcileStagePermissionSchema(rpc, mode);
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
          try: () => [...desiredServiceGrants(actions), ...desiredCompanyAdministratorWorkforceGrants()],
        });
        const grants = [...desired, ...verificationGrants];
        return yield* verifyDatabase
          ? verifyDatabaseAndReconcileServiceGrants(rpc, grants, verifyStageDatabase)
          : reconcileServiceGrants(rpc, grants, mode).pipe(Effect.asVoid);
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
