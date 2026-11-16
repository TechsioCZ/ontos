import type { DatabaseConnectionPair } from '@app/core-runtime';
import { configureDatabasePool, parseDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Crypto, DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import {
  OwnerExecutionOutcomeSchema,
  PrivacyMeasureHandoffSchema,
} from '../../shared/domain/privacy-measure-handoff.ts';
import {
  PrivacyDispositionDecisionSchema,
  PrivacyLegalHoldSchema,
  ProcessedRetentionEvaluationWorkSchema,
} from '../../shared/domain/privacy-retention-disposition.ts';
import { AuthoritativePrivacyRetentionRuleVersionSchema } from '../../shared/domain/privacy-retention-rule.ts';
import {
  dispositionDecisions,
  legalHolds,
  ownerExecutionOutcomes,
  privacyMeasureDispatches,
  privacyRelations,
  retentionEvaluationWork,
  retentionRules,
} from '../../src/database/schema.ts';

const Uuid = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PrivacyMeasureFixtureUuid'),
  Schema.decodeTo(Schema.String),
);
const SeedSchema = Schema.Struct({
  contentScopeRef: Schema.String,
  governancePrincipalId: Uuid,
  legalEntityId: Uuid,
  resourceRef: Schema.String.check(
    Schema.isPattern(/^integration\.symmy\.job:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u),
  ),
  tenantId: Uuid,
}).check(
  Schema.makeFilter((seed) =>
    seed.contentScopeRef === `${seed.resourceRef}#integration.symmy.job-intent`
      ? undefined
      : 'Exact resource-qualified intent scope is required',
  ),
);
export class MeasureExecutionNativeFixtureError extends Schema.TaggedError<MeasureExecutionNativeFixtureError>()(
  'MeasureExecutionNativeFixtureError',
  {
    cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
    reason: Schema.String,
  },
) {}
const unavailable = (cause?: unknown) => {
  const reason = 'The isolated Privacy measure fixture is unavailable';
  if (cause === undefined) {
    return new MeasureExecutionNativeFixtureError({ reason });
  }
  return new MeasureExecutionNativeFixtureError({ cause: Redacted.make(cause), reason });
};
export type MeasureExecutionNativeFixtureInput = typeof SeedSchema.Type & {
  readonly connections: DatabaseConnectionPair;
};
type Seed = typeof SeedSchema.Type;
type PrivacyExecutor = Effect.Success<ReturnType<typeof makeWithDefaults<typeof privacyRelations>>>;
type PrivacyTransaction = Parameters<Parameters<PrivacyExecutor['transaction']>[0]>[0];
const asDate = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const IdentitySchema = Schema.Struct({
  address: Schema.OptionFromNullOr(Schema.String),
  bypass: Schema.Boolean,
  database: Schema.String,
  databaseOid: Schema.String,
  port: Schema.OptionFromNullOr(Schema.Number),
  role: Schema.String,
  roleOid: Schema.String,
  superuser: Schema.Boolean,
});
const sameNativePair = (
  administrative: readonly (typeof IdentitySchema.Type)[],
  operational: readonly (typeof IdentitySchema.Type)[],
  connections: DatabaseConnectionPair,
) => {
  const a = administrative.at(0);
  const r = operational.at(0);
  return (
    administrative.length === 1 &&
    operational.length === 1 &&
    a !== undefined &&
    r !== undefined &&
    a.database === connections.admin.database &&
    r.database === connections.runtime.database &&
    a.databaseOid === r.databaseOid &&
    a.role === connections.admin.user &&
    r.role === connections.runtime.user &&
    a.roleOid !== r.roleOid &&
    (a.superuser || a.bypass) &&
    !r.superuser &&
    !r.bypass &&
    Option.getOrElse(a.address, () => '') === Option.getOrElse(r.address, () => '') &&
    Option.getOrElse(a.port, () => 0) === Option.getOrElse(r.port, () => 0)
  );
};
const assertIsolatedConnections = Effect.fn('PrivacyMeasureNativeFixture.assertIsolatedConnections')(
  function* assertIsolatedConnections(connections: DatabaseConnectionPair) {
    const deployment = yield* Config.option(Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'));
    const { admin, runtime } = connections;
    const parsed = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: admin.connectionString,
      DATABASE_URL: runtime.connectionString,
    }).pipe(Effect.mapError(unavailable));
    const metadataMatches = (actual: typeof admin, declared: typeof admin) =>
      actual.database === declared.database &&
      actual.host === declared.host &&
      actual.port === declared.port &&
      actual.user === declared.user;
    if (!metadataMatches(parsed.admin, admin) || !metadataMatches(parsed.runtime, runtime)) {
      return yield* unavailable();
    }
    if (
      (Option.isSome(deployment) && ['stage', 'production'].includes(deployment.value)) ||
      !/^ontos_test_party_gateway_[a-f\d]{32}$/u.test(admin.database) ||
      admin.database !== runtime.database ||
      admin.user === runtime.user ||
      admin.host !== runtime.host ||
      admin.port !== runtime.port ||
      !['localhost', '127.0.0.1'].includes(admin.host)
    ) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  },
);

const withNativeTransaction = <A, E, R>(
  connections: DatabaseConnectionPair,
  work: (transaction: PrivacyTransaction) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* verifiedTransaction() {
    yield* assertIsolatedConnections(connections);
    const { admin, runtime } = connections;
    const [adminConfiguration, runtimeConfiguration] = yield* Effect.all([
      configureDatabasePool(Redacted.make(admin.connectionString)),
      configureDatabasePool(Redacted.make(runtime.connectionString)),
    ]).pipe(Effect.mapError(unavailable));
    const adminClient = yield* PgClient.make({ ...adminConfiguration, maxConnections: 1 }).pipe(
      Effect.mapError(unavailable),
    );
    const runtimeClient = yield* PgClient.make({ ...runtimeConfiguration, maxConnections: 1 }).pipe(
      Effect.mapError(unavailable),
    );
    const [adminRows, runtimeRows] = yield* Effect.all([
      adminClient`select current_database() as database, current_user as role,
        d.oid::text as "databaseOid", r.oid::text as "roleOid", r.rolsuper as superuser,
        r.rolbypassrls as bypass, inet_server_addr()::text as address, inet_server_port() as port
        from pg_database d cross join pg_roles r where d.datname=current_database() and r.rolname=current_user`,
      runtimeClient`select current_database() as database, current_user as role,
        d.oid::text as "databaseOid", r.oid::text as "roleOid", r.rolsuper as superuser,
        r.rolbypassrls as bypass, inet_server_addr()::text as address, inet_server_port() as port
        from pg_database d cross join pg_roles r where d.datname=current_database() and r.rolname=current_user`,
    ]).pipe(Effect.mapError(unavailable));
    const [administrative, operational] = yield* Effect.all([
      Schema.decodeUnknownEffect(Schema.Array(IdentitySchema))(adminRows),
      Schema.decodeUnknownEffect(Schema.Array(IdentitySchema))(runtimeRows),
    ]).pipe(Effect.mapError(unavailable));
    if (!sameNativePair(administrative, operational, connections)) {
      return yield* unavailable();
    }
    const database = yield* makeWithDefaults({ relations: privacyRelations }).pipe(
      Effect.provideService(PgClient.PgClient, adminClient),
    );

    return yield* database.transaction((transaction) =>
      Effect.gen(function* verifiedWork() {
        const challengeRows = yield* transaction.execute(
          sql`select hashtextextended(gen_random_uuid()::text, 0)::text as key`,
          'objects',
        );
        const challenges = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ key: Schema.String.check(Schema.isPattern(/^-?\d+$/u)) })),
        )(challengeRows);
        const challenge = challenges.at(0);
        if (challenges.length !== 1 || challenge === undefined) {
          return yield* unavailable();
        }
        yield* transaction.execute(sql`select pg_advisory_xact_lock(${challenge.key}::bigint)`, 'objects');
        const response = yield* runtimeClient.withTransaction(
          runtimeClient`select pg_try_advisory_xact_lock(${challenge.key}::bigint) as acquired`,
        );
        const matched = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ acquired: Schema.Literal(false) })),
        )(response);
        if (matched.length !== 1) {
          return yield* unavailable();
        }

        return yield* work(transaction);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(Reactivity.layer), Effect.mapError(unavailable));

const prepare = Effect.fn('PrivacyMeasureNativeFixture.prepare')(function* prepare(
  transaction: PrivacyTransaction,
  seed: Seed,
) {
  const crypto = yield* Crypto.Crypto;
  const id = yield* crypto.randomUUIDv4();
  const now = yield* DateTime.now;
  const from = DateTime.formatIso(DateTime.subtract(now, { days: 4 }));
  const start = DateTime.formatIso(DateTime.subtract(now, { days: 3 }));
  const due = DateTime.formatIso(DateTime.subtract(now, { days: 2 }));
  const evaluatedAt = DateTime.formatIso(DateTime.subtract(now, { minutes: 1 }));
  const scope = { legalEntityId: seed.legalEntityId, tenantId: seed.tenantId };
  const policyRef = 'INTERNAL_SYMMY_INTENT_RETENTION_FIXTURE_V1';
  const ruleRef = `internal:measure-rule:${id}`;
  const workRef = `internal:measure-evaluation:${id}`;
  const decisionRef = `internal:measure-decision:${id}`;
  const evidenceRefs = [`internal:explicit-fixture-governance:${id}`];
  const common = {
    controllerRef: seed.legalEntityId,
    evidenceRefs,
    policyRef,
    policyVersion: 1,
    provenanceRef: `internal:measure-provenance:${id}`,
  };
  const rule = yield* Schema.decodeUnknownEffect(AuthoritativePrivacyRetentionRuleVersionSchema)({
    ...common,
    applicability: 'PROSPECTIVE_ONLY',
    authorityRef: seed.governancePrincipalId,
    businessStartAt: start,
    businessStartRef: seed.resourceRef,
    contentScopeRef: seed.contentScopeRef,
    dispositionOutcome: 'DELETE',
    effectiveFrom: from,
    effectiveTo: null,
    retentionWindow: { durationDays: 1, kind: 'DURATION' },
    retroactiveApprovalRef: null,
    ruleRef,
    ruleVersion: 1,
    ruleVersionId: `internal:measure-rule-version:${id}`,
  });
  const evaluation = {
    ...common,
    blockerRefs: [],
    evaluatedAt,
    evaluationRef: workRef,
    outcome: 'DELETE',
    ownerOutcomeRef: null,
  };
  const work = yield* Schema.decodeUnknownEffect(ProcessedRetentionEvaluationWorkSchema)({
    ...common,
    businessStartAt: start,
    businessStartRef: seed.resourceRef,
    contentScopeRefs: [seed.contentScopeRef],
    dispositionOutcome: 'DELETE',
    dueAt: due,
    evaluatedAt,
    idempotencyRef: `internal:measure-work-key:${id}`,
    ruleAuthorityRef: rule.authorityRef,
    ruleRef,
    ruleVersion: 1,
    ruleVersionId: rule.ruleVersionId,
    source: 'PERIODIC',
    status: 'READY',
    workerEvaluation: { ...evaluation, messageId: yield* crypto.randomUUIDv4() },
    workRef,
  });
  const decision = yield* Schema.decodeUnknownEffect(PrivacyDispositionDecisionSchema)({
    ...common,
    actorPrincipalRef: seed.governancePrincipalId,
    authorityRef: seed.governancePrincipalId,
    blockerRefs: [],
    contentScopeRefs: [seed.contentScopeRef],
    decidedAt: evaluatedAt,
    decisionRef,
    evaluationRef: workRef,
    outcome: 'DELETE',
    ownerExecutionOutcomeRef: null,
    reasonRefs: [`internal:explicit-retention-end:${id}`],
    ruleRef,
    ruleVersion: 1,
    ruleVersionId: rule.ruleVersionId,
  });
  const handoff = yield* Schema.decodeUnknownEffect(PrivacyMeasureHandoffSchema)({
    contentScopeRefs: [seed.contentScopeRef],
    controllerObligationRef: null,
    dispositionDecision: 'DELETE',
    expectedEvidenceRefs: [],
    idempotencyKey: `internal:measure-key:${id}`,
    kind: 'DELETE',
    measureId: `internal:measure:${id}`,
    owningCapability: 'integration.symmy',
    preconditionRefs: [workRef],
    requestedAt: evaluatedAt,
    requestedResult: 'INTENT_PURGED',
    resourceRefs: [seed.resourceRef],
    right: null,
    sourceDecisionRef: decisionRef,
    sourceDecisionRevision: 1,
    subjectRef: seed.resourceRef,
    taskId: `internal:retention-task:${id}`,
    tenantId: seed.tenantId,
  });
  yield* transaction.insert(retentionRules).values({
    ...scope,
    actionInvocationId: yield* crypto.randomUUIDv4(),
    contentScopeRef: seed.contentScopeRef,
    effectiveFrom: asDate(from),
    ruleRecord: yield* Schema.encodeEffect(AuthoritativePrivacyRetentionRuleVersionSchema)(rule),
    ruleRef,
    ruleVersion: 1,
  });
  yield* transaction.insert(retentionEvaluationWork).values({
    ...scope,
    dueAt: asDate(due),
    evaluatedAt: asDate(evaluatedAt),
    idempotencyRef: work.idempotencyRef,
    ruleRef,
    ruleVersion: 1,
    status: 'READY',
    workRecord: yield* Schema.encodeEffect(ProcessedRetentionEvaluationWorkSchema)(work),
    workRef,
  });
  yield* transaction.insert(dispositionDecisions).values({
    ...scope,
    decidedAt: asDate(evaluatedAt),
    decisionRecord: yield* Schema.encodeEffect(PrivacyDispositionDecisionSchema)(decision),
    decisionRef,
    outcome: 'DELETE',
    ruleRef,
    ruleVersion: 1,
  });
  return { handoff, holdRef: `internal:measure-hold:${id}`, policyRef };
});
type Identity = Effect.Success<ReturnType<typeof prepare>>;
const changeHold = Effect.fn('PrivacyMeasureNativeFixture.setHold')(function* changeHold(
  transaction: PrivacyTransaction,
  seed: Seed,
  identity: Identity,
  active: boolean,
) {
  const scope = { legalEntityId: seed.legalEntityId, tenantId: seed.tenantId };
  yield* transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity.holdRef},0))`, 'objects');
  const history = yield* transaction
    .select({ record: legalHolds.holdRecord, recordedAt: legalHolds.recordedAt })
    .from(legalHolds)
    .where(
      and(
        eq(legalHolds.tenantId, seed.tenantId),
        eq(legalHolds.legalEntityId, seed.legalEntityId),
        eq(legalHolds.holdRef, identity.holdRef),
      ),
    )
    .orderBy(asc(legalHolds.recordedAt));
  const last = history.at(-1);
  const previous =
    last === undefined ? undefined : yield* Schema.decodeUnknownEffect(PrivacyLegalHoldSchema)(last.record);
  if (
    (previous === undefined && !active) ||
    (previous !== undefined && Option.isNone(previous.releasedAt) === active)
  ) {
    return active;
  }
  // A released hold is never resurrected under an existing history identity.
  if (previous !== undefined && active) {
    return yield* unavailable();
  }
  const now = yield* DateTime.now;
  if (last !== undefined && DateTime.toEpochMillis(now) <= last.recordedAt.getTime()) {
    return yield* unavailable();
  }
  const at = DateTime.formatIso(now);
  const crypto = yield* Crypto.Crypto;
  const release = active
    ? {
        releaseConditionRef: null,
        releasedAt: null,
        releasedByPrincipalRef: null,
        releaseEvidenceRefs: [],
        releaseReasonRef: null,
        releaseRef: null,
      }
    : {
        releaseConditionRef: 'internal:acceptance-review-complete',
        releasedAt: at,
        releasedByPrincipalRef: seed.governancePrincipalId,
        releaseEvidenceRefs: ['internal:acceptance-release-evidence'],
        releaseReasonRef: 'internal:acceptance-release-reason',
        releaseRef: `${identity.holdRef}:release`,
      };
  const record = yield* Schema.decodeUnknownEffect(PrivacyLegalHoldSchema)({
    ...release,
    actorPrincipalRef: seed.governancePrincipalId,
    authorityKind: 'LEGAL_HOLD_AUTHORITY',
    authorityRef: seed.governancePrincipalId,
    contentScopeRefs: [seed.contentScopeRef],
    controllerRef: seed.legalEntityId,
    effectiveFrom: previous?.effectiveFrom ?? DateTime.formatIso(DateTime.subtract(now, { minutes: 1 })),
    effectiveTo: previous?.effectiveTo ?? DateTime.formatIso(DateTime.add(now, { days: 1 })),
    evidenceRefs: [identity.holdRef],
    holdRef: identity.holdRef,
    policyRef: identity.policyRef,
    policyVersion: 1,
    provenanceRef: identity.holdRef,
    reasonTypeRef: 'internal:measure-acceptance-hold',
    reasonTypeVersion: 1,
    reviewDueAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
    reviewedAt: null,
    reviewEvidenceRefs: [],
    reviewRef: `${identity.holdRef}:review`,
  });
  yield* transaction.insert(legalHolds).values({
    ...scope,
    actionInvocationId: yield* crypto.randomUUIDv4(),
    effectiveFrom: asDate(record.effectiveFrom),
    effectiveTo: asDate(record.effectiveTo),
    holdRecord: yield* Schema.encodeEffect(PrivacyLegalHoldSchema)(record),
    holdRef: identity.holdRef,
    recordedAt: asDate(at),
    releasedAt: active ? null : asDate(at),
  });
  return active;
});
const observe = Effect.fn('PrivacyMeasureNativeFixture.observe')(function* observe(
  transaction: PrivacyTransaction,
  seed: Seed,
  identity: Identity,
) {
  const [dispatch] = yield* transaction
    .select({
      compositionRevision: privacyMeasureDispatches.dispatchCompositionRevision,
      invocationId: privacyMeasureDispatches.dispatchActionInvocationId,
      status: privacyMeasureDispatches.status,
    })
    .from(privacyMeasureDispatches)
    .where(
      and(
        eq(privacyMeasureDispatches.tenantId, seed.tenantId),
        eq(privacyMeasureDispatches.legalEntityId, seed.legalEntityId),
        eq(privacyMeasureDispatches.measureId, identity.handoff.measureId),
      ),
    )
    .limit(1);
  const rows = yield* transaction
    .select({ record: ownerExecutionOutcomes.outcomeRecord })
    .from(ownerExecutionOutcomes)
    .where(
      and(
        eq(ownerExecutionOutcomes.tenantId, seed.tenantId),
        eq(ownerExecutionOutcomes.legalEntityId, seed.legalEntityId),
        eq(ownerExecutionOutcomes.measureId, identity.handoff.measureId),
      ),
    )
    .orderBy(asc(ownerExecutionOutcomes.attempt))
    .limit(16);
  const outcomes = yield* Schema.decodeUnknownEffect(Schema.Array(OwnerExecutionOutcomeSchema))(
    rows.map(({ record }) => record),
  );
  return {
    dispatch: Option.fromUndefinedOr(dispatch),
    outcomes: outcomes.map(
      ({ attempt, evidenceRefs, includedResourceRefs, outcomeId, remainingResourceRefs, status }) => ({
        attempt,
        evidenceRefs,
        includedResourceRefs,
        outcomeId,
        remainingResourceRefs,
        status,
      }),
    ),
  };
});
/** INTERNAL ONLY. Seeds native governance, never a dispatch, authorization grant or owner receipt.
 * Every operation proves the two live connections address the same isolated physical database.
 */
export const seedMeasureExecutionNativeFixture = Effect.fn('PrivacyMeasureNativeFixture.seed')(
  function* seedMeasureExecutionNativeFixture(input: MeasureExecutionNativeFixtureInput) {
    const seed = yield* Schema.decodeUnknownEffect(SeedSchema)(input).pipe(Effect.mapError(unavailable));
    const identity = yield* withNativeTransaction(input.connections, (transaction) => prepare(transaction, seed));
    return {
      handoff: identity.handoff,
      observe: () => withNativeTransaction(input.connections, (transaction) => observe(transaction, seed, identity)),
      setHold: (active: boolean) =>
        withNativeTransaction(input.connections, (transaction) => changeHold(transaction, seed, identity, active)),
    };
  },
);
