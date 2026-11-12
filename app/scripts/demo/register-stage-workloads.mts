/// <reference types="node" />
/**
 * Registers stage machine workloads (O73) and the company each one acts for (D6) through Core's own writers.
 *
 *   node scripts/demo/register-stage-workloads.mts --registrations <file> --mode dry-run
 *   node scripts/demo/register-stage-workloads.mts --registrations <file> --mode apply --reviewed-plan-sha256 <sha>
 *   node scripts/demo/register-stage-workloads.mts --registrations <file> --mode verify
 *
 * The operator file lives outside the repository (ADR-0028) and names, per Tenant, its current human owner (the
 * installer scope) and each `{ principalId, workloadKey, legalEntityId }` to register. Only keys the deployed
 * composition declares (`topology/authorization-catalog.json`), only active machine principals and only active
 * companies of that Tenant are accepted. Identifiers are derived exactly as the stage bootstrap derives them, so a
 * re-run is a no-op and an already active binding is reused instead of duplicated. Nothing else is written: no
 * Role, grant, membership or key. The run connects with the runtime identity (`DATABASE_URL`) only.
 *
 * It is for storefront and other external workloads. A module's own internal workload (`MODULE_INTERNAL_WORKLOADS`) is
 * the platform's: `release-internal-workloads.mts` registers it per company at release, and a registration made here
 * for one is never keyed.
 */
import { createHash } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { Config, Console, DateTime, Effect, Exit, FileSystem, Layer, Option, Redacted, Result, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { APP_DATABASE_IDENTITY_ENROLLMENT as enrollment } from '../../database/identity-enrollment.ts';
import { stableUuid } from '../../packages/core-runtime/src/access/catalog/stable-id.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { runScopedRead } from '../../packages/core-runtime/src/access/intent/persistence.ts';
import type { AccessIntentDatabase } from '../../packages/core-runtime/src/access/intent/persistence.ts';
import { writeWorkloadBindings } from '../../packages/core-runtime/src/access/workloads/binding-store.ts';
import { makeDrizzleAccessWorkloadBindings } from '../../packages/core-runtime/src/access/workloads/bindings.ts';
import { writeWorkloadCompanyBindings } from '../../packages/core-runtime/src/access/workloads/company-bindings.ts';
import { AccessWorkloadCompanyBindingIdSchema } from '../../packages/core-runtime/src/access/workloads/company-store.ts';
import { AccessWorkloadBindingIdSchema } from '../../packages/core-runtime/src/access/workloads/store.ts';
import { WorkloadKeySchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import { CoreDatabase, CoreDatabaseLive } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import {
  accessMemberships,
  accessScopes,
  accessWorkloadBindings,
  accessWorkloadCompanyBindings,
  legalEntities,
  principals,
} from '../../packages/core-runtime/src/db/schema.ts';
import { stageScopeOf } from '../../packages/core-runtime/src/install/stage-context-bootstrap.ts';

const modes = ['dry-run', 'apply', 'verify'] as const;
/** Machine principal kinds a workload binding may name; a person or an agent is never bound (O73). */
const WORKLOAD_PRINCIPAL_KINDS: ReadonlySet<string> = new Set(['service', 'integration', 'system']);
/** Reads hold no unique index to name; a driver failure is reported as unreadable state. */
const NO_CONSTRAINTS: ReadonlySet<string> = new Set();
const CATALOG_ARTIFACT = new URL('../../topology/authorization-catalog.json', import.meta.url);

export const StageWorkloadRegistrationsFileSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  tenants: Schema.NonEmptyArray(
    Schema.Struct({
      /** The Tenant's current human owner: the installer scope the registrations are written in. */
      ownerPrincipalId: PrincipalIdSchema,
      tenantId: TenantIdSchema,
      workloads: Schema.NonEmptyArray(
        Schema.Struct({
          legalEntityId: LegalEntityIdSchema,
          principalId: PrincipalIdSchema,
          workloadKey: WorkloadKeySchema,
        }),
      ),
    }),
  ),
});
export type StageWorkloadRegistrationsFile = typeof StageWorkloadRegistrationsFileSchema.Type;

export class StageWorkloadRegistrationFailure extends Schema.TaggedError<StageWorkloadRegistrationFailure>()(
  'StageWorkloadRegistrationFailure',
  { reason: Schema.String },
) {}
const fail = (reason: string) => new StageWorkloadRegistrationFailure({ reason });
const isRegistrationFailure = Schema.is(StageWorkloadRegistrationFailure);

/** One requested registration with the identifiers the stage bootstrap derives for it (D27). */
export interface StageWorkloadRegistration {
  readonly bindingId: string;
  readonly bindingIncarnation: string;
  readonly legalEntityId: string;
  readonly ownerPrincipalId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly workloadKey: string;
}

/** The binding id the stage bootstrap writes for a principal and key (`stage-context-bootstrap.ts`). */
export const stageWorkloadBindingIds = (tenantId: string, principalId: string, workloadKey: string) => ({
  bindingId: stableUuid(['ontos.access.stage.workload-binding', tenantId, principalId, workloadKey].join(':')),
  bindingIncarnation: stableUuid(
    ['ontos.access.stage.workload-incarnation', tenantId, principalId, workloadKey].join(':'),
  ),
});

/** The registration id of one company for one binding; the binding id is the one actually live in the Tenant. */
export const stageWorkloadCompanyIds = (tenantId: string, bindingId: string, legalEntityId: string) => ({
  companyBindingId: stableUuid(['ontos.access.workload-company-binding', tenantId, bindingId, legalEntityId].join(':')),
  companyIncarnation: stableUuid(
    ['ontos.access.workload-company-incarnation', tenantId, bindingId, legalEntityId].join(':'),
  ),
});

/**
 * The registrations an operator file asks for, refused as a whole when one names a key the composition does not
 * declare, a principal and key twice in a Tenant (a binding selects exactly one company, D6), or the owner itself.
 */
export const planStageWorkloadRegistrations = (
  file: StageWorkloadRegistrationsFile,
  declaredWorkloadKeys: ReadonlySet<string>,
): Result.Result<readonly StageWorkloadRegistration[], string> => {
  if (new Set(file.tenants.map(({ tenantId }) => tenantId)).size !== file.tenants.length) {
    return Result.fail('Every Tenant may appear only once');
  }
  const seen = new Set<string>();
  const registrations: StageWorkloadRegistration[] = [];
  for (const tenant of file.tenants) {
    for (const workload of tenant.workloads) {
      if (!declaredWorkloadKeys.has(workload.workloadKey)) {
        return Result.fail(`The deployed composition does not declare workload ${workload.workloadKey}`);
      }
      if (workload.principalId === tenant.ownerPrincipalId) {
        return Result.fail('A workload principal can never be the Tenant owner');
      }
      const key = `${tenant.tenantId}:${workload.principalId}:${workload.workloadKey}`;
      if (seen.has(key)) {
        return Result.fail('A Tenant may register each workload key for a principal only once');
      }
      seen.add(key);
      registrations.push({
        ...stageWorkloadBindingIds(tenant.tenantId, workload.principalId, workload.workloadKey),
        legalEntityId: workload.legalEntityId,
        ownerPrincipalId: tenant.ownerPrincipalId,
        principalId: workload.principalId,
        tenantId: tenant.tenantId,
        workloadKey: workload.workloadKey,
      });
    }
  }
  return Result.succeed(registrations);
};

/** One reviewed step: the live binding to use, the registration to hold, and which of the two are written. */
export const StageWorkloadStepSchema = Schema.Struct({
  bindingId: AccessWorkloadBindingIdSchema,
  companyBindingId: AccessWorkloadCompanyBindingIdSchema,
  legalEntityId: LegalEntityIdSchema,
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
  workloadKey: WorkloadKeySchema,
  writeBinding: Schema.Boolean,
  writeRegistration: Schema.Boolean,
});
export type StageWorkloadStep = typeof StageWorkloadStepSchema.Type;
const encodePlan = Schema.encodeResult(Schema.fromJsonString(Schema.Array(StageWorkloadStepSchema)));
const stepOrder = (step: StageWorkloadStep) => `${step.tenantId}:${step.principalId}:${step.workloadKey}`;

/** The fingerprint an operator reviews after a dry run; apply refuses any other plan. */
export const stageWorkloadPlanFingerprint = (steps: readonly StageWorkloadStep[]): Result.Result<string, string> =>
  Result.mapBoth(encodePlan(steps.toSorted((left, right) => stepOrder(left).localeCompare(stepOrder(right)))), {
    onFailure: () => 'The plan could not be encoded for review',
    onSuccess: (encoded) => createHash('sha256').update(encoded).digest('hex'),
  });

const ArtifactSchema = Schema.Struct({ declaredWorkloadKeys: Schema.Array(WorkloadKeySchema) });

const readDeclaredWorkloadKeys = Effect.gen(function* readDeclaredKeys() {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* fileSystem
    .readFileString(CATALOG_ARTIFACT.pathname)
    .pipe(Effect.mapError(() => fail('The access catalog artifact could not be read')));
  const artifact = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ArtifactSchema))(source).pipe(
    Effect.mapError(() => fail('The access catalog artifact does not name its declared workload keys')),
  );
  return new Set<string>(artifact.declaredWorkloadKeys);
});

const readRegistrationsFile = Effect.fn('StageWorkloads.readFile')(function* readFile(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* fileSystem
    .readFileString(path)
    .pipe(Effect.mapError(() => fail('The registrations file could not be read')));
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StageWorkloadRegistrationsFileSchema), {
    onExcessProperty: 'error',
  })(source).pipe(Effect.mapError(() => fail('The registrations file does not match the documented schema')));
});

/** Reads what the Tenant holds now, in the owner's installer scope, and refuses anything not exactly as declared. */
const resolveStep = Effect.fn('StageWorkloads.resolve')(function* resolve(
  database: AccessIntentDatabase,
  registration: StageWorkloadRegistration,
) {
  const scope = yield* stageScopeOf({
    principalId: registration.ownerPrincipalId,
    tenantId: registration.tenantId,
  }).pipe(Effect.mapError(() => fail('The installer scope is invalid')));
  const facts = yield* runScopedRead(database, scope, NO_CONSTRAINTS, (transaction) =>
    Effect.all({
      bindings: transaction
        .select({ bindingId: accessWorkloadBindings.bindingId })
        .from(accessWorkloadBindings)
        .where(
          and(
            eq(accessWorkloadBindings.tenantId, registration.tenantId),
            eq(accessWorkloadBindings.principalId, registration.principalId),
            eq(accessWorkloadBindings.workloadKey, registration.workloadKey),
            eq(accessWorkloadBindings.status, 'active'),
          ),
        ),
      companies: transaction
        .select({ status: legalEntities.status })
        .from(legalEntities)
        .where(
          and(
            eq(legalEntities.tenantId, registration.tenantId),
            eq(legalEntities.legalEntityId, registration.legalEntityId),
          ),
        ),
      owners: transaction
        .select({ principalId: accessMemberships.principalId })
        .from(accessMemberships)
        .innerJoin(
          accessScopes,
          and(
            eq(accessScopes.tenantId, accessMemberships.tenantId),
            eq(accessScopes.scopeId, accessMemberships.scopeId),
          ),
        )
        .innerJoin(
          principals,
          and(
            eq(principals.tenantId, accessMemberships.tenantId),
            eq(principals.principalId, accessMemberships.principalId),
          ),
        )
        .where(
          and(
            eq(accessMemberships.tenantId, registration.tenantId),
            isNull(accessScopes.legalEntityId),
            eq(accessMemberships.kind, 'owner'),
            eq(accessMemberships.status, 'active'),
            eq(principals.kind, 'human'),
            eq(principals.status, 'active'),
            lte(accessMemberships.validFrom, sql`clock_timestamp()`),
            or(isNull(accessMemberships.validUntil), gt(accessMemberships.validUntil, sql`clock_timestamp()`)),
          ),
        ),
      principal: transaction
        .select({ kind: principals.kind, status: principals.status })
        .from(principals)
        .where(
          and(eq(principals.tenantId, registration.tenantId), eq(principals.principalId, registration.principalId)),
        ),
    }),
  ).pipe(Effect.mapError(() => fail('The Tenant state could not be read')));
  const [principal] = facts.principal;
  if (principal === undefined || principal.status !== 'active' || !WORKLOAD_PRINCIPAL_KINDS.has(principal.kind)) {
    return yield* fail(`Principal ${registration.principalId} is not an active machine principal of its Tenant`);
  }
  const [company] = facts.companies;
  if (company?.status !== 'active') {
    return yield* fail(`Company ${registration.legalEntityId} is not an active company of its Tenant`);
  }
  const [owner, ...otherOwners] = facts.owners;
  if (owner?.principalId !== registration.ownerPrincipalId || otherOwners.length > 0) {
    return yield* fail(`The declared owner is not the unique current human owner of Tenant ${registration.tenantId}`);
  }
  // A binding already live under another derivation (an earlier bootstrap) is reused, never duplicated.
  const [liveBinding] = facts.bindings;
  const bindingId = liveBinding?.bindingId ?? registration.bindingId;
  const registrations = yield* runScopedRead(database, scope, NO_CONSTRAINTS, (transaction) =>
    transaction
      .select({
        companyBindingId: accessWorkloadCompanyBindings.companyBindingId,
        legalEntityId: accessWorkloadCompanyBindings.legalEntityId,
      })
      .from(accessWorkloadCompanyBindings)
      .where(
        and(
          eq(accessWorkloadCompanyBindings.tenantId, registration.tenantId),
          eq(accessWorkloadCompanyBindings.workloadBindingId, bindingId),
          eq(accessWorkloadCompanyBindings.status, 'active'),
        ),
      ),
  ).pipe(Effect.mapError(() => fail('The Tenant registrations could not be read')));
  if (registrations.some(({ legalEntityId }) => legalEntityId !== registration.legalEntityId)) {
    return yield* fail(`Binding ${bindingId} is already registered for another company`);
  }
  const [liveRegistration] = registrations;
  const derived = stageWorkloadCompanyIds(registration.tenantId, bindingId, registration.legalEntityId);
  const step: StageWorkloadStep = {
    bindingId: AccessWorkloadBindingIdSchema.make(bindingId),
    companyBindingId: AccessWorkloadCompanyBindingIdSchema.make(
      liveRegistration?.companyBindingId ?? derived.companyBindingId,
    ),
    legalEntityId: LegalEntityIdSchema.make(registration.legalEntityId),
    principalId: PrincipalIdSchema.make(registration.principalId),
    tenantId: TenantIdSchema.make(registration.tenantId),
    workloadKey: WorkloadKeySchema.make(registration.workloadKey),
    writeBinding: liveBinding === undefined,
    writeRegistration: liveRegistration === undefined,
  };
  return { companyIncarnation: derived.companyIncarnation, registration, scope, step };
});

type ResolvedStep = Effect.Success<ReturnType<typeof resolveStep>>;

const applyStep = Effect.fn('StageWorkloads.apply')(function* apply(
  database: AccessIntentDatabase,
  resolved: ResolvedStep,
  at: Date,
) {
  const { companyIncarnation, registration, scope, step } = resolved;
  if (step.writeBinding) {
    yield* writeWorkloadBindings(database, scope, {
      bindings: [
        {
          bindingId: step.bindingId,
          createdAt: at,
          incarnation: AccessWorkloadBindingIdSchema.make(registration.bindingIncarnation),
          principalId: step.principalId,
          tenantId: step.tenantId,
          workloadKey: step.workloadKey,
        },
      ],
    }).pipe(Effect.mapError((cause) => fail(`${cause.code}: ${cause.reason}`)));
  }
  if (step.writeRegistration) {
    yield* writeWorkloadCompanyBindings(database, scope, {
      bindings: [
        {
          companyBindingId: step.companyBindingId,
          createdAt: at,
          incarnation: AccessWorkloadCompanyBindingIdSchema.make(companyIncarnation),
          legalEntityId: step.legalEntityId,
          tenantId: step.tenantId,
          workloadBindingId: step.bindingId,
        },
      ],
    }).pipe(Effect.mapError((cause) => fail(`${cause.code}: ${cause.reason}`)));
  }
});

/** Reads one step back through the gate's own reader: the key is active and the company is selectable. */
const verifyStep = Effect.fn('StageWorkloads.verify')(function* verify(
  database: AccessIntentDatabase,
  resolved: ResolvedStep,
) {
  const { scope, step } = resolved;
  const reader = makeDrizzleAccessWorkloadBindings(database);
  const query = { principalId: step.principalId, scope, tenantId: step.tenantId };
  const active = yield* reader
    .readActiveWorkloadKeys(query)
    .pipe(Effect.mapError(() => fail('The registered workloads could not be read back')));
  const declaration = yield* reader
    .readCompanyDeclaration(query)
    .pipe(Effect.mapError(() => fail('The registered companies could not be read back')));
  const verified = active.has(step.workloadKey) && declaration.activeCompanyIds.has(step.legalEntityId);
  yield* Console.log({ principalId: step.principalId, verified, workloadKey: step.workloadKey });
  if (!verified) {
    return yield* fail(`Principal ${step.principalId} is not admitted for ${step.workloadKey} in its company`);
  }
  return step;
});

const main = Effect.fn('StageWorkloads.main')(function* run(
  mode: (typeof modes)[number],
  path: string,
  reviewed: Option.Option<string>,
) {
  const planned = planStageWorkloadRegistrations(yield* readRegistrationsFile(path), yield* readDeclaredWorkloadKeys);
  if (Result.isFailure(planned)) {
    return yield* fail(planned.failure);
  }
  const { executor } = yield* CoreDatabase;
  const database: AccessIntentDatabase = { enrollment, executor };
  const resolved = yield* Effect.all(planned.success.map((registration) => resolveStep(database, registration)));
  const steps = resolved.map(({ step }) => step);
  const encoded = stageWorkloadPlanFingerprint(steps);
  if (Result.isFailure(encoded)) {
    return yield* fail(encoded.failure);
  }
  const fingerprint = encoded.success;
  yield* Effect.all(steps.map((step) => Console.log({ mode, ...step })));
  if (mode === 'dry-run') {
    return yield* Console.log({ fingerprint, mode });
  }
  if (mode === 'apply') {
    if (Option.getOrUndefined(reviewed) !== fingerprint) {
      return yield* fail('The reviewed plan fingerprint does not match the current plan; run a new dry run');
    }
    const at = yield* DateTime.nowAsDate;
    yield* Effect.all(resolved.map((step) => applyStep(database, step, at)));
  }
  const verified = yield* Effect.all(resolved.map((step) => verifyStep(database, step)));
  return yield* Console.log({ mode, verified: verified.length });
});

const DatabaseLive = Layer.unwrap(
  Effect.gen(function* databaseLayer() {
    const url = yield* Config.Redacted('DATABASE_URL').pipe(Effect.mapError(() => fail('DATABASE_URL is required')));
    const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) }).pipe(
      Effect.mapError(() => fail('DATABASE_URL is not a runtime database address')),
    );
    return CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration)));
  }),
);

const command = Command.make(
  'register-stage-workloads',
  {
    mode: Flag.Literals('mode', modes).pipe(Flag.withDefault('dry-run')),
    registrations: Flag.String('registrations'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, registrations, reviewed }) =>
    main(mode, registrations, reviewed).pipe(
      Effect.tapError((failure) =>
        Console.error(
          isRegistrationFailure(failure)
            ? `Workload registration stopped: ${failure.reason}`
            : 'Workload registration stopped; database details withheld',
        ),
      ),
    ),
).pipe(Command.provide(DatabaseLive));

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)),
  );
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
