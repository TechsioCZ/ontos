import { TenantIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
/**
 * Release step: canonical access readiness for every active Tenant, proven read-only before the release
 * takes the authority.
 *
 * Authorization v2 owns the engine (`ADR-0030`, `app/docs/architecture/AUTHORIZATION.md`): PostgreSQL holds
 * intent, one Core writer projects it, and nothing else writes a relationship. The retired release step
 * derived legacy `action` edges from the composition and reconciled them for every active Tenant; that
 * mechanism no longer exists and has no import path.
 *
 * What a release still must prove before it is published is that the Tenants it is about to serve carry
 * canonical authority: every active Tenant has its scopes, its owner membership and its published release,
 * and the engine projection equals that intent. The proof is read-only — it never writes, revokes or re-grants
 * — so a release that cannot be proven stops before publication with the exact Tenant and the remediation,
 * instead of taking the authority and locking its people out.
 *
 * A Tenant created by the retired demo tooling has no canonical intent at all; that is the lockout this gate
 * refuses. The remediation names the canonical bootstrap, because the legacy SpiceDB scoped-role and
 * action-grant policy has no migration or import step (ADR-0030).
 */
import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import {
  Array as EffectArray,
  Config,
  Console,
  Duration,
  Effect,
  FileSystem,
  Order,
  Redacted,
  Schedule,
  Schema,
} from 'effect';
import type { ConfigProvider } from 'effect';

import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../packages/core-runtime/src/access/compiler/spice-db-compiler.ts';
import type { AccessProjectionCompiler } from '../../packages/core-runtime/src/access/intent/projection-compiler.ts';
import type { TenantIntentLoader } from '../../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { loadDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../packages/core-runtime/src/db/database-identity-manifest.ts';
import { PLATFORM_TENANT } from '../../packages/core-runtime/src/auth/module-credentials.ts';
import { accessMemberships, tenants } from '../../packages/core-runtime/src/db/schema.ts';
import { stageScopeOf } from '../../packages/core-runtime/src/install/stage-context-bootstrap.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import type { SpiceDbConfigValue } from '../../packages/core-runtime/src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { ReleaseAccessIntentReader } from './release-access-intent-reader.mts';

export class ReleaseAccessVerificationError extends Schema.TaggedError<ReleaseAccessVerificationError>()(
  'ReleaseAccessVerificationError',
  { reason: Schema.String, remediation: Schema.String, tenantId: Schema.optional(Schema.toEncoded(TenantIdSchema)) },
) {}

/** The canonical bootstrap a Tenant without v2 intent must be created through; it is the only remediation. */
export const RELEASE_ACCESS_BOOTSTRAP_REMEDIATION =
  'Create the Tenant through the canonical access bootstrap (locally `pnpm local:initialize`, on stage `apps/shell-super-app/scripts/bootstrap-stage-accounts.mts`) and assign its people through Roles and Assignments. The retired SpiceDB scoped-role and action-grant policy has no migration or import step (ADR-0030).';

/**
 * The engine schema a release needs is **not** installed by this host. SpiceDB reads a bootstrap file only
 * when its datastore is empty (`scripts/run-zerops-spicedb.sh` gates it on `namespace_config`), so an engine
 * that already holds data keeps whatever schema it was given. Bringing a live engine to the canonical v2
 * schema is therefore its own approved operation, done before a release that reads it.
 */
export const SCHEMA_CUTOVER_REMEDIATION =
  'Apply the canonical v2 schema to the live engine as a separately approved operation (`scripts/demo/reconcile-stage-service-grants.mts --apply`, or the SpiceDB operator) and re-run the release. The deployment bootstrap file is read only when the datastore is empty, so a live engine never picks the schema up on its own.';

const schemaRefusal = (reason: string): ReleaseAccessVerificationError =>
  new ReleaseAccessVerificationError({ reason, remediation: SCHEMA_CUTOVER_REMEDIATION });

const refusal = (reason: string, tenantId?: string): ReleaseAccessVerificationError =>
  new ReleaseAccessVerificationError(
    tenantId === undefined
      ? { reason, remediation: RELEASE_ACCESS_BOOTSTRAP_REMEDIATION }
      : { reason, remediation: RELEASE_ACCESS_BOOTSTRAP_REMEDIATION, tenantId },
  );

export interface ReleaseAccessTenantInventory {
  readonly status: string;
  readonly tenantId: string;
}

export interface ReleaseAccessInventory {
  readonly tenants: readonly ReleaseAccessTenantInventory[];
}

export interface ReleaseAccessVerificationResult {
  /** The active Tenants the release is about to serve. */
  readonly tenants: number;
  /** Projected tuples the verification compared with intent, across every active Tenant. */
  readonly tuples: number;
  readonly verified: number;
}

/**
 * The intent facts a release gate reads. `TenantProjectionIntent` satisfies it structurally, so the gate can be
 * exercised over a fabricated intent without building a whole projection.
 */
export interface ReleaseAccessIntentFacts {
  readonly members: readonly unknown[];
  readonly owners: readonly unknown[];
  readonly scopes: readonly unknown[];
}

/** The verification facts a release gate reads. `ProjectionVerification` satisfies it structurally. */
export interface ReleaseAccessProjectionFacts {
  readonly drift: readonly unknown[];
  readonly ok: boolean;
  readonly tupleCount: number;
}

const SPICEDB_TIMEOUT_MILLISECONDS = 30_000;
const STEP_BUDGET = Duration.minutes(5);

/**
 * Stage only, against the fixed stage SpiceDB, as the canonical bootstrap requires. app-host passes the owner
 * secrets layered over the container environment, the same settings the owner processes receive.
 */
export const loadReleaseAccessConfiguration = (provider: ConfigProvider.ConfigProvider) =>
  Effect.gen(function* loadConfiguration() {
    const environment = yield* Config.all({
      SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
      SPICEDB_ENDPOINT: Config.schema(Schema.Literal('spicedb:50051'), 'SPICEDB_ENDPOINT'),
      SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    })
      .parse(provider)
      .pipe(
        Effect.mapError(() =>
          refusal('Release access verification runs only on stage against the fixed stage SpiceDB'),
        ),
      );
    return yield* parseSpiceDbConfig({
      ...environment,
      SPICEDB_PRESHARED_KEY: Redacted.value(environment.SPICEDB_PRESHARED_KEY),
    }).pipe(Effect.mapError(() => refusal('The stage SpiceDB configuration is invalid; values withheld')));
  });

/** Every Tenant the release will serve: active only, because a suspended Tenant's authority is intent the runtime subtracts. */
export const readReleaseAccessInventory = Effect.gen(function* readInventory() {
  const database = yield* CoreDatabase;
  const rows = yield* database.executor
    .select({ status: tenants.status, tenantId: tenants.tenantId })
    .from(tenants)
    .pipe(Effect.mapError(() => refusal('The active Tenants could not be read for release verification')));
  return { tenants: rows } satisfies ReleaseAccessInventory;
});

/**
 * One Tenant's canonical authority as intent. A Tenant whose intent carries no scope, no owner or no member was
 * never bootstrapped by v2 — the legacy tooling wrote its rights straight into the engine — so the release refuses
 * instead of publishing a release that answers nobody.
 */
export const verifyTenantAccessIntent = (input: {
  readonly intent: ReleaseAccessIntentFacts;
  readonly tenantId: string;
  readonly verification: ReleaseAccessProjectionFacts;
}): ReleaseAccessVerificationError | undefined => {
  if (input.intent.scopes.length === 0) {
    return refusal(
      `Active Tenant ${input.tenantId} has no canonical access scope; the release would serve it with no authority`,
      input.tenantId,
    );
  }
  if (input.intent.owners.length === 0 || input.intent.members.length === 0) {
    return refusal(
      `Active Tenant ${input.tenantId} has no canonical owner membership; the release would serve it with no administrator`,
      input.tenantId,
    );
  }
  if (!input.verification.ok) {
    return refusal(
      `Active Tenant ${input.tenantId} projects ${String(input.verification.drift.length)} tuple(s) that differ from its intent; the engine and PostgreSQL disagree`,
      input.tenantId,
    );
  }
  return undefined;
};

/** The Tenant's canonical owner: the one management relation the bootstrap writes before any assignment. */
export const readTenantOwner = (tenantId: string) =>
  Effect.gen(function* readOwner() {
    const database = yield* CoreDatabase;
    const rows = yield* database.executor
      .select({ principalId: accessMemberships.principalId })
      .from(accessMemberships)
      .where(
        and(
          eq(accessMemberships.tenantId, tenantId),
          eq(accessMemberships.kind, 'owner'),
          eq(accessMemberships.status, 'active'),
        ),
      )
      .pipe(
        Effect.mapError(() =>
          refusal(`The canonical owner membership of Tenant ${tenantId} could not be read`, tenantId),
        ),
      );
    return rows[0]?.principalId ?? undefined;
  });

/**
 * The live engine must serve the canonical v2 schema before a release reads it. The check is read-only
 * (`ReadSchema` + `DiffSchema` at one revision) and never writes a schema: a release that found a stale engine
 * stops with the separately-approved schema cutover named, instead of publishing against a graph it cannot read.
 */
export const verifyReleaseSchema = (configuration: SpiceDbConfigValue) =>
  Effect.gen(function* verifySchema() {
    const rpc = yield* Effect.acquireRelease(
      Effect.try({
        catch: () => schemaRefusal('The live SpiceDB schema could not be read for release verification'),
        try: () => openSpiceDbGrpcRpc(configuration, SPICEDB_TIMEOUT_MILLISECONDS),
      }),
      (client) => Effect.sync(() => client.close()),
    );
    const live = yield* rpc
      .readSchema(v1.ReadSchemaRequest.create({}))
      .pipe(Effect.mapError(() => schemaRefusal('The live SpiceDB schema could not be read for release verification')));
    if (live.readAt === undefined || live.readAt.token.length === 0) {
      return yield* schemaRefusal('The live SpiceDB schema has no verifiable read revision');
    }
    const diff = yield* rpc
      .diffSchema(
        v1.DiffSchemaRequest.create({
          comparisonSchema: ONTOS_SPICEDB_SCHEMA,
          consistency: { requirement: { atExactSnapshot: live.readAt, oneofKind: 'atExactSnapshot' } },
        }),
      )
      .pipe(
        Effect.mapError(() => schemaRefusal('The live SpiceDB schema could not be compared with the canonical one')),
      );
    if (diff.diffs.length > 0) {
      return yield* schemaRefusal(
        `The live SpiceDB schema differs from the canonical v2 schema in ${String(diff.diffs.length)} place(s); the release would read an engine it does not match`,
      );
    }
    return yield* Effect.void;
  });

/**
 * Verifies every active Tenant's projection against its intent, read-only. Nothing here writes: the engine is read
 * through `AccessProjectionCompiler.verify`, and intent is read through the one loader. A failure stops the release
 * before publication with the Tenant and the remediation.
 */
export const verifyReleaseAccessWith = <Requirements,>(input: {
  readonly inventory: ReleaseAccessInventory;
  readonly verifyTenant: (
    tenantId: string,
  ) => Effect.Effect<{ readonly tuples: number }, ReleaseAccessVerificationError, Requirements>;
}) =>
  Effect.gen(function* verifyAllTenants() {
    // The platform tenant serves no person: it holds only the module credential principals the platform itself
    // provisions, so it has, and must have, no owner, scope or Role to prove.
    const active = EffectArray.sortWith(
      input.inventory.tenants.filter(
        ({ status, tenantId }) => status === 'active' && tenantId !== PLATFORM_TENANT.tenantId,
      ),
      ({ tenantId }) => tenantId,
      Order.String,
    );
    const results = yield* Effect.forEach(active, ({ tenantId }) => input.verifyTenant(tenantId), {
      concurrency: 2,
    });
    return {
      tenants: active.length,
      tuples: results.reduce((total, result) => total + result.tuples, 0),
      verified: results.length,
    } satisfies ReleaseAccessVerificationResult;
  });

/** One Tenant's read-only verification: owner, scope, intent, projection. */
const verifyOneTenant = (
  tenantId: string,
  loader: (typeof TenantIntentLoader)['Service'],
  engine: (typeof AccessProjectionCompiler)['Service'],
) =>
  Effect.gen(function* verifyTenant() {
    const owner = yield* readTenantOwner(tenantId);
    if (owner === undefined) {
      return yield* refusal(
        `Active Tenant ${tenantId} has no canonical owner membership; the release would serve it with no administrator`,
        tenantId,
      );
    }
    const scope = yield* stageScopeOf({ principalId: owner, tenantId }).pipe(
      Effect.mapError(() => refusal(`The verification scope of Tenant ${tenantId} is invalid`, tenantId)),
    );
    const intent = yield* loader
      .loadProjection(scope)
      .pipe(Effect.mapError(() => refusal(`The access intent of Tenant ${tenantId} could not be read`, tenantId)));
    const verification = yield* engine
      .verify({ tenants: [intent] })
      .pipe(
        Effect.mapError(() => refusal(`The SpiceDB projection of Tenant ${tenantId} could not be verified`, tenantId)),
      );
    const problem = verifyTenantAccessIntent({ intent, tenantId, verification });
    if (problem !== undefined) {
      return yield* problem;
    }
    return { tuples: verification.tupleCount };
  });

/** The scoped reader must connect as the enrolled runtime role, never the publication administrator. */
export const loadReleaseAccessDatabaseConfiguration = (provider: ConfigProvider.ConfigProvider) =>
  Config.Redacted('DATABASE_URL')
    .parse(provider)
    .pipe(
      Effect.flatMap((url) =>
        loadDatabaseConfig({
          environment: { DATABASE_URL: Redacted.value(url) },
          envPath: '/dev/null',
          identity: SHARED_RUNTIME_IDENTITY,
        }),
      ),
      Effect.mapError(() =>
        refusal('Release access verification requires the configured shared runtime database identity'),
      ),
    );

/**
 * The engine transport and scoped runtime reader belong to this step. Inventory and owner discovery still use the
 * publication administrator. Verification retries twice; a final refusal prevents publication and writes no access.
 */
export const verifyReleaseAccess = (provider: ConfigProvider.ConfigProvider) =>
  Effect.gen(function* verifyRelease() {
    const configuration = yield* loadReleaseAccessConfiguration(provider);
    // The engine must already serve the canonical v2 schema. This host never installs it: a live engine
    // keeps whatever schema it was given, so the schema cutover is its own approved operation (see
    // `SCHEMA_CUTOVER_REMEDIATION`). Proving it here stops a release that would read a stale graph.
    yield* verifyReleaseSchema(configuration);
    const inventory = yield* readReleaseAccessInventory;
    const transport = yield* Effect.acquireRelease(
      Effect.sync(() => makeAccessProjectionTransport(configuration, SPICEDB_TIMEOUT_MILLISECONDS)),
      (engine) => Effect.sync(() => engine.close()),
    );
    const engine = makeAccessProjectionCompiler(transport);
    const loader = yield* ReleaseAccessIntentReader;
    return yield* verifyReleaseAccessWith({
      inventory,
      verifyTenant: (tenantId) => verifyOneTenant(tenantId, loader, engine),
    }).pipe(Effect.retry({ schedule: Schedule.spaced(Duration.seconds(5)), times: 2 }));
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: STEP_BUDGET,
      orElse: () => Effect.fail(refusal('Release access verification exceeded its time budget')),
    }),
  );

/** Under the deployed workspace, readable for the container's whole life, so the result never races the log window. */
export const RELEASE_ACCESS_VERIFICATION_STATUS_FILE = '.zerops/runtime/release-access-verification.json';

const ReleaseAccessVerificationStatusSchema = Schema.Struct({
  finishedAt: Schema.DateTimeUtcFromString,
  outcome: Schema.Literals(['verified', 'failed']),
  reason: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  revision: Schema.String,
  tenants: Schema.optional(Schema.Number),
  tuples: Schema.optional(Schema.Number),
  verified: Schema.optional(Schema.Number),
});
export type ReleaseAccessVerificationStatus = typeof ReleaseAccessVerificationStatusSchema.Type;

/** Counts, revision and sanitized reason only. A write failure is logged and never changes the release outcome. */
export const recordReleaseAccessVerification = (workspace: string, status: ReleaseAccessVerificationStatus) =>
  Effect.gen(function* recordStatus() {
    const fs = yield* FileSystem.FileSystem;
    const directory = `${workspace}/.zerops/runtime`;
    yield* fs.makeDirectory(directory, { recursive: true });
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(ReleaseAccessVerificationStatusSchema))(status);
    yield* fs.writeFileString(`${workspace}/${RELEASE_ACCESS_VERIFICATION_STATUS_FILE}`, `${text}\n`);
  }).pipe(
    Effect.tapError(() =>
      Console.error(
        `[app-host] release access verification status ${RELEASE_ACCESS_VERIFICATION_STATUS_FILE} not written`,
      ),
    ),
    Effect.ignore,
  );

/** The proof of one verified release, tied to the composition revision it judged. */
export const releaseAccessVerificationStatus = (
  revision: string,
  result: ReleaseAccessVerificationResult,
): Omit<ReleaseAccessVerificationStatus, 'finishedAt'> => ({
  outcome: 'verified',
  revision,
  tenants: result.tenants,
  tuples: result.tuples,
  verified: result.verified,
});

/** The refusal of one failed release, tied to the composition revision it judged. */
export const releaseAccessVerificationFailure = (
  revision: string,
  problem: ReleaseAccessVerificationError,
): Omit<ReleaseAccessVerificationStatus, 'finishedAt'> => ({
  outcome: 'failed',
  reason: problem.reason,
  remediation: problem.remediation,
  revision,
});
