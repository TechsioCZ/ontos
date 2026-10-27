import { Console, DateTime, Effect, FileSystem, Match, Option, Result, Schema } from 'effect';

const DIAGNOSTIC_TIMEOUT = 'diagnostic-timeout';
const ADVISORY_READY = 'advisory-ready';
const PROVEN_BLOCKER = 'proven-blocker';
const WRITE_SUMMARY = 'write-summary';
const PENDING_WORK = 'pending-work';
const DIAGNOSTIC_UNAVAILABLE = 'diagnostic-unavailable';
const PHASE_TIMEOUT = 'phase-timeout';

export const StageDeployPhaseSchema = Schema.Literals([
  'preflight',
  'publication-lock',
  'close-admission',
  'drain',
  'durable-drain',
  'enter-draining',
  'outbox-drain',
  'seal',
  'child-migration',
  'migration',
  'mark-migrated',
  'migration-complete',
  'publication',
  'readiness',
  'unknown',
]);
export const StageDeployStatusSchema = Schema.Literals([
  'ready',
  'started',
  'waiting',
  'completed',
  'blocked',
  'failed',
  DIAGNOSTIC_TIMEOUT,
  'aborted',
  'unknown',
]);
export const StageDeployReasonSchema = Schema.Literals([
  PENDING_WORK,
  'authority-expired',
  'authority-sealed',
  'replacement-publication-required',
  'authority-missing',
  DIAGNOSTIC_TIMEOUT,
  DIAGNOSTIC_UNAVAILABLE,
  'drained',
  PHASE_TIMEOUT,
  'phase-failed',
  'interrupted',
  'unknown',
]);
const AuthorityPhaseSchema = Schema.Literals(['active', 'draining', 'sealed', 'migrated', 'absent', 'unknown']);
const MigrationObservationSchema = Schema.Union([Schema.Boolean, Schema.Literal('unknown')]);
const OwnerStateSchema = Schema.Literals(['pending', 'running', 'parked', 'settling', 'settled', 'failed', 'unknown']);
const LeaseSchema = Schema.Literals(['live', 'expired', 'absent', 'unknown']);
const RecoverySchema = Schema.Literals(['available', 'unavailable', 'unknown']);
const SettlementConditionSchema = Schema.Literals([
  'admission-open',
  'owner-outcome-unknown',
  'owner-checkpoint-incomplete',
  'lease-live',
  'recovery-unavailable',
  'revision-mismatch',
  'unknown',
]);
const BlockerKindSchema = Schema.Literals(['durable-work', 'outbox-message', 'outbox-delivery', 'unknown']);
const FailureCodeSchema = Schema.Literals(['authority-unavailable', 'migration-failed', 'unknown']);
export const STAGE_DEPLOY_DIAGNOSTIC_LIMITS = {
  blockers: 10,
  count: 11,
  durationMs: 86_400_000,
  // All emitted text uses ASCII and fixed categories. Tests enforce this byte ceiling per record.
  outputBytes: 16_384,
} as const;

const boundedNatural = (maximum: number) =>
  Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(maximum));
const NullableDuration = Schema.Union([boundedNatural(STAGE_DEPLOY_DIAGNOSTIC_LIMITS.durationMs), Schema.Null]);
const NullableCount = Schema.Union([boundedNatural(STAGE_DEPLOY_DIAGNOSTIC_LIMITS.count), Schema.Null]);
const OPAQUE_IDENTITY = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|sha256:[a-f0-9]{64})$/u;
const OpaqueIdentitySchema = Schema.String.check(Schema.isMaxLength(71), Schema.isPattern(OPAQUE_IDENTITY));
const RecoveryObservationSchema = Schema.Union([Schema.DateTimeUtcFromString, Schema.Null]);
const StageDeployBlockerSchema = Schema.Struct({
  failedSettlementCondition: SettlementConditionSchema,
  identity: Schema.Union([OpaqueIdentitySchema, Schema.Null]),
  kind: BlockerKindSchema,
  lastSuccessfulRecoveryAt: RecoveryObservationSchema,
  lease: LeaseSchema,
  ownerState: OwnerStateSchema,
  recovery: RecoverySchema,
});

export const StageDeployDiagnosticSchema = Schema.Struct({
  advisoryOnly: Schema.Literal(true),
  authorityPhase: AuthorityPhaseSchema,
  blockers: Schema.Array(StageDeployBlockerSchema).check(Schema.isMaxLength(STAGE_DEPLOY_DIAGNOSTIC_LIMITS.blockers)),
  blockersTruncated: Schema.Boolean,
  budgetMs: NullableDuration,
  budgets: Schema.Struct({
    childMigrationMs: NullableDuration,
    diagnosticMs: NullableDuration,
    drainMs: NullableDuration,
    totalMs: NullableDuration,
  }),
  classification: Schema.Literals([ADVISORY_READY, 'complete', 'progress', PROVEN_BLOCKER, 'unknown']),
  counts: Schema.Struct({ deliveries: NullableCount, durable: NullableCount, messages: NullableCount }),
  elapsedMs: NullableDuration,
  failureCode: FailureCodeSchema,
  message: Schema.String.check(Schema.isMaxLength(512)),
  migrationsCompleted: MigrationObservationSchema,
  migrationStarted: MigrationObservationSchema,
  nextStep: Schema.String.check(Schema.isMaxLength(512)),
  phase: StageDeployPhaseSchema,
  reason: StageDeployReasonSchema,
  schemaVersion: Schema.Literal(1),
  status: StageDeployStatusSchema,
});
export type StageDeployDiagnostic = typeof StageDeployDiagnosticSchema.Type;
export type StageDeployPhase = typeof StageDeployPhaseSchema.Type;
export type StageDeployStatus = typeof StageDeployStatusSchema.Type;

/** Only opaque native work UUIDs or SHA-256 references, never a tenant/principal/payload value. */
export type StageDeployBlockerInput = Partial<typeof StageDeployBlockerSchema.Encoded> &
  Pick<typeof StageDeployBlockerSchema.Encoded, 'kind'>;

/** Observations only. This helper neither checks authority nor grants permission to migrate. */
export interface StageDeployDiagnosticInput {
  readonly authorityPhase?: typeof AuthorityPhaseSchema.Type;
  readonly blockers?: readonly StageDeployBlockerInput[];
  readonly budgetMs?: number | null;
  readonly childMigrationBudgetMs?: number | null;
  readonly counts?: {
    readonly deliveries?: number | null;
    readonly durable?: number | null;
    readonly messages?: number | null;
  };
  readonly diagnosticBudgetMs?: number | null;
  readonly drainBudgetMs?: number | null;
  readonly elapsedMs?: number | null;
  readonly migrationsCompleted?: typeof MigrationObservationSchema.Type;
  readonly migrationStarted?: typeof MigrationObservationSchema.Type;
  readonly phase: StageDeployPhase;
  readonly reason?: typeof StageDeployReasonSchema.Type;
  readonly status: StageDeployStatus;
  readonly totalBudgetMs?: number | null;
}

const category = <Value extends string>(value: Value | undefined, values: readonly Value[], fallback: Value): Value =>
  values.find((candidate) => candidate === value) ?? fallback;
const boundedNumber = (value: number | null | undefined, maximum: number): number | null =>
  Schema.is(Schema.Finite)(value) && value >= 0 ? Math.min(Math.floor(value), maximum) : null;
const duration = (value: number | null | undefined) => (Schema.is(NullableDuration)(value) ? value : null);
const migrationObservation = (
  value: typeof MigrationObservationSchema.Type | undefined,
): typeof MigrationObservationSchema.Type => (Schema.is(MigrationObservationSchema)(value) ? value : 'unknown');
const opaqueIdentity = (value: StageDeployBlockerInput['identity']) =>
  Schema.is(OpaqueIdentitySchema)(value) ? value : null;
const observationTime = (value: StageDeployBlockerInput['lastSuccessfulRecoveryAt']) =>
  Schema.decodeUnknownOption(RecoveryObservationSchema)(value).pipe(
    Option.filter((instant) => instant === null || DateTime.formatIso(instant) === value),
    Option.getOrElse(() => null),
  );

type DiagnosticOutcome = Pick<StageDeployDiagnostic, 'classification' | 'message'>;
const authorityBlockerMessage = (reason: typeof StageDeployReasonSchema.Type) =>
  Match.value(reason).pipe(
    Match.when('authority-expired', () => 'The observed authority lease is expired; migration remains fenced.'),
    Match.when('authority-sealed', () => 'The observed authority is sealed; normal admission remains fenced.'),
    Match.when(
      'replacement-publication-required',
      () => 'The observed authority requires verified replacement publication.',
    ),
    Match.when('authority-missing', () => 'No authority was observed; the native cutover gate is required.'),
    Match.whenOr(
      DIAGNOSTIC_TIMEOUT,
      DIAGNOSTIC_UNAVAILABLE,
      'drained',
      'interrupted',
      PENDING_WORK,
      'phase-failed',
      PHASE_TIMEOUT,
      'unknown',
      () => null,
    ),
    Match.exhaustive,
  );

const outcomeMessage = (status: StageDeployStatus, reason: typeof StageDeployReasonSchema.Type): DiagnosticOutcome => {
  if (status === DIAGNOSTIC_TIMEOUT || reason === DIAGNOSTIC_TIMEOUT) {
    return {
      classification: 'unknown',
      message: 'Diagnostic deadline reached; readiness and recovery health are unknown.',
    };
  }
  if (status === 'unknown' || reason === DIAGNOSTIC_UNAVAILABLE) {
    return {
      classification: 'unknown',
      message: 'Observation unavailable; no blocker or recovery health conclusion is proven.',
    };
  }
  if (status === 'aborted') {
    return {
      classification: 'unknown',
      message: 'Execution was interrupted; the last reported lifecycle observations are retained.',
    };
  }
  if (reason === PHASE_TIMEOUT) {
    return {
      classification: 'unknown',
      message: 'The phase budget expired; the owner side-effect outcome remains unproven.',
    };
  }
  if (reason === PENDING_WORK) {
    return {
      classification: PROVEN_BLOCKER,
      message: 'Pending work prevents drain completion; this does not prove abandoned work or failed recovery.',
    };
  }
  const authorityMessage = authorityBlockerMessage(reason);
  if (status === 'blocked' && authorityMessage !== null) {
    return { classification: PROVEN_BLOCKER, message: authorityMessage };
  }
  if (status === 'completed') {
    return {
      classification: 'complete',
      message: 'The reported phase completed; this record does not authorize the next phase.',
    };
  }
  if (status === 'ready' && reason === 'drained') {
    return {
      classification: ADVISORY_READY,
      message:
        'Read-only readiness observed no pending work; repeat the authoritative gate under the publication lock.',
    };
  }
  if (status === 'started' || status === 'waiting') {
    return {
      classification: 'progress',
      message: 'The reported phase is in progress; owner outcome and recovery health are not inferred.',
    };
  }
  return {
    classification: 'unknown',
    message: 'The phase did not establish completion; inspect native owner evidence without changing durable state.',
  };
};

const nextStep = (
  input: Pick<StageDeployDiagnostic, 'authorityPhase' | 'migrationStarted' | 'migrationsCompleted'>,
): string => {
  if (input.migrationsCompleted === true) {
    return 'Verify the completed migration identity and authority state, then use the reviewed publication path. Do not rerun migrations.';
  }
  if (input.migrationStarted === true || input.migrationStarted === 'unknown') {
    return 'Preserve the authority fence. Verify the child process and native owner outcome before retrying; do not start a second migration or clear leases or markers.';
  }
  if (input.authorityPhase === 'sealed' || input.authorityPhase === 'migrated') {
    return 'Preserve the authority fence and verify native migration and publication evidence. Do not reopen admission or force a terminal state.';
  }
  return 'Inspect native owner recovery evidence and rerun bounded read-only readiness. Keep the authoritative migration gate; do not clear leases or markers by age.';
};

/** Pick known fields rather than redact arbitrary text. Unknown keys, causes and payloads never enter output. */
export const buildStageDeployDiagnostic = (input: StageDeployDiagnosticInput): StageDeployDiagnostic => {
  const phase = category(input.phase, StageDeployPhaseSchema.literals, 'unknown');
  const status = category(input.status, StageDeployStatusSchema.literals, 'unknown');
  const reason = category(input.reason, StageDeployReasonSchema.literals, 'unknown');
  const lifecycle = {
    authorityPhase: category(input.authorityPhase, AuthorityPhaseSchema.literals, 'unknown'),
    migrationsCompleted: migrationObservation(input.migrationsCompleted),
    migrationStarted: migrationObservation(input.migrationStarted),
  };
  const blockers = input.blockers ?? [];
  return {
    ...lifecycle,
    ...outcomeMessage(status, reason),
    advisoryOnly: true,
    blockers: blockers.slice(0, STAGE_DEPLOY_DIAGNOSTIC_LIMITS.blockers).map((blocker) => ({
      failedSettlementCondition: category(
        blocker?.failedSettlementCondition,
        SettlementConditionSchema.literals,
        'unknown',
      ),
      identity: opaqueIdentity(blocker?.identity),
      kind: category(blocker?.kind, BlockerKindSchema.literals, 'unknown'),
      lastSuccessfulRecoveryAt: observationTime(blocker?.lastSuccessfulRecoveryAt),
      lease: category(blocker?.lease, LeaseSchema.literals, 'unknown'),
      ownerState: category(blocker?.ownerState, OwnerStateSchema.literals, 'unknown'),
      recovery: category(blocker?.recovery, RecoverySchema.literals, 'unknown'),
    })),
    blockersTruncated: blockers.length > STAGE_DEPLOY_DIAGNOSTIC_LIMITS.blockers,
    budgetMs: duration(input.budgetMs),
    budgets: {
      childMigrationMs: duration(input.childMigrationBudgetMs),
      diagnosticMs: duration(input.diagnosticBudgetMs),
      drainMs: duration(input.drainBudgetMs),
      totalMs: duration(input.totalBudgetMs),
    },
    counts: {
      deliveries: boundedNumber(input.counts?.deliveries, STAGE_DEPLOY_DIAGNOSTIC_LIMITS.count),
      durable: boundedNumber(input.counts?.durable, STAGE_DEPLOY_DIAGNOSTIC_LIMITS.count),
      messages: boundedNumber(input.counts?.messages, STAGE_DEPLOY_DIAGNOSTIC_LIMITS.count),
    },
    elapsedMs: duration(input.elapsedMs),
    failureCode: 'unknown',
    nextStep: nextStep(lifecycle),
    phase,
    reason,
    schemaVersion: 1,
    status,
  };
};

const knownAuthorityFailure = Schema.is(
  Schema.Struct({
    _tag: Schema.Literal('ApplicationCompositionAuthorityError'),
    code: Schema.Literal('application_composition_authority_unavailable'),
  }),
);
const knownMigrationFailure = Schema.is(Schema.Struct({ _tag: Schema.Literal('StageDemoMigrationError') }));

export interface StageDeployFailure {
  readonly _tag: string;
  readonly code?: string;
}
const failureCode = (failure: StageDeployFailure): typeof FailureCodeSchema.Type => {
  if (knownAuthorityFailure(failure)) {
    return 'authority-unavailable';
  }
  if (knownMigrationFailure(failure)) {
    return 'migration-failed';
  }
  return 'unknown';
};

/** Recognize only stable tags/codes. Never inspect or stringify an Effect cause, reason or message. */
export const buildStageDeployFailure = (
  input: StageDeployDiagnosticInput,
  failure: StageDeployFailure,
): StageDeployDiagnostic => ({
  ...buildStageDeployDiagnostic(input),
  failureCode: failureCode(failure),
});

const countText = (value: number | null) => {
  if (value === null) {
    return 'unknown';
  }
  return value === STAGE_DEPLOY_DIAGNOSTIC_LIMITS.count ? `>=${value}` : String(value);
};
const numberText = (value: number | null) => (value === null ? 'unknown' : `${value}ms`);
const escapeAnnotation = (value: string) =>
  value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

const annotationLevel = (diagnostic: StageDeployDiagnostic) => {
  if (diagnostic.classification === 'complete' || diagnostic.classification === ADVISORY_READY) {
    return 'notice';
  }
  return diagnostic.status === 'failed' || diagnostic.status === 'blocked' ? 'error' : 'warning';
};
const encodeDiagnostic = Schema.encodeResult(Schema.fromJsonString(StageDeployDiagnosticSchema));
const renderDiagnostic = (diagnostic: StageDeployDiagnostic) => {
  // Builder-owned values already satisfy this schema. A codec failure here is a programming defect.
  const json = Result.getOrThrow(encodeDiagnostic(diagnostic));
  const heading = `Stage deploy ${diagnostic.phase}: ${diagnostic.status} (${diagnostic.classification})`;
  const detail = [
    diagnostic.message,
    `Elapsed ${numberText(diagnostic.elapsedMs)}; budget ${numberText(diagnostic.budgetMs)}.`,
    `Authority ${diagnostic.authorityPhase}; migrationStarted ${diagnostic.migrationStarted}; migrationsCompleted ${diagnostic.migrationsCompleted}.`,
    `Next: ${diagnostic.nextStep}`,
  ].join(' ');
  const level = annotationLevel(diagnostic);
  const annotationText = escapeAnnotation(`${heading}. ${detail}`);
  const summary = [
    `### ${heading}`,
    '',
    detail,
    '',
    `Counts: durable ${countText(diagnostic.counts.durable)}, messages ${countText(diagnostic.counts.messages)}, deliveries ${countText(diagnostic.counts.deliveries)}. Counts are capped at ${STAGE_DEPLOY_DIAGNOSTIC_LIMITS.count}.`,
    '',
    '```json',
    json,
    '```',
    '',
  ].join('\n');
  return {
    annotation: `::${level} title=Stage deployment::${annotationText}`,
    diagnostic,
    json,
    stderr: `${heading}. ${detail}\n${json}`,
    summary,
  };
};

export const formatStageDeployDiagnostic = (input: StageDeployDiagnosticInput) =>
  renderDiagnostic(buildStageDeployDiagnostic(input));
export const formatStageDeployFailure = (input: StageDeployDiagnosticInput, failure: StageDeployFailure) =>
  renderDiagnostic(buildStageDeployFailure(input, failure));

export class StageDeployDiagnosticError extends Schema.TaggedError<StageDeployDiagnosticError>()(
  'StageDeployDiagnosticError',
  {
    diagnostic: StageDeployDiagnosticSchema,
    message: Schema.String,
    operation: Schema.Literals(['phase', WRITE_SUMMARY]),
  },
) {}

/** A useful typed error without retaining a raw cause or relying on Error's empty description. */
export const stageDeployDiagnosticError = (input: StageDeployDiagnosticInput) => {
  const diagnostic = buildStageDeployDiagnostic(input);
  return new StageDeployDiagnosticError({
    diagnostic,
    message: `${diagnostic.phase}: ${diagnostic.message} ${diagnostic.nextStep}`,
    operation: 'phase',
  });
};

/** summaryFile is a trusted runner-provided path, never owner data. No shell or environment-file access. */
export const writeStageDeployDiagnostic = (
  input: StageDeployDiagnosticInput,
  options: { readonly annotationStream?: 'stderr' | 'stdout'; readonly summaryFile?: string } = {},
): Effect.Effect<void, StageDeployDiagnosticError, FileSystem.FileSystem> =>
  Effect.gen(function* writeDiagnostic() {
    const output = formatStageDeployDiagnostic(input);
    yield* Console.error(output.stderr);
    yield* options.annotationStream === 'stderr' ? Console.error(output.annotation) : Console.log(output.annotation);
    if (options.summaryFile !== undefined) {
      if (
        options.summaryFile.length === 0 ||
        options.summaryFile.length > 4096 ||
        /[\0\r\n]/u.test(options.summaryFile) ||
        options.summaryFile.split(/[\\/]/u).some((part) => part === '.env' || part.startsWith('.env.'))
      ) {
        return yield* new StageDeployDiagnosticError({
          diagnostic: output.diagnostic,
          message: 'The stage deployment summary requires a dedicated runner output file.',
          operation: WRITE_SUMMARY,
        });
      }
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(options.summaryFile, output.summary, { flag: 'a' }).pipe(
        Effect.mapError(
          () =>
            new StageDeployDiagnosticError({
              diagnostic: output.diagnostic,
              message: 'The sanitized stage deployment summary could not be appended.',
              operation: WRITE_SUMMARY,
            }),
        ),
      );
    }
    return yield* Effect.void;
  });
