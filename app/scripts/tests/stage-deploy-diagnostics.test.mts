import { Console, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import {
  buildStageDeployDiagnostic,
  formatStageDeployDiagnostic,
  formatStageDeployFailure,
  STAGE_DEPLOY_DIAGNOSTIC_LIMITS,
  StageDeployDiagnosticError,
  StageDeployDiagnosticSchema,
  StageDeployPhaseSchema,
  StageDeployStatusSchema,
  stageDeployDiagnosticError,
  writeStageDeployDiagnostic,
} from '../stage-deploy-diagnostics.mts';
import type { StageDeployDiagnosticInput } from '../stage-deploy-diagnostics.mts';
import { StageDemoMigrationError } from '../stage-demo-migrate.mts';

const workId = '12345678-1234-4234-8234-123456789abc';
const observedAt = '2026-10-27T00:00:00.000Z';
const baseline: StageDeployDiagnosticInput = {
  authorityPhase: 'active',
  budgetMs: 300_000,
  childMigrationBudgetMs: 840_000,
  counts: { deliveries: 0, durable: 1, messages: 0 },
  diagnosticBudgetMs: 50_000,
  drainBudgetMs: 300_000,
  elapsedMs: 15_000,
  migrationsCompleted: false,
  migrationStarted: false,
  phase: 'drain',
  reason: 'pending-work',
  status: 'waiting',
  totalBudgetMs: 1_200_000,
};
const blocker = {
  failedSettlementCondition: 'owner-outcome-unknown',
  identity: workId,
  kind: 'durable-work',
  lastSuccessfulRecoveryAt: observedAt,
  lease: 'expired',
  ownerState: 'running',
  recovery: 'available',
} as const;

const capturedConsole = () => {
  const stderr: unknown[] = [];
  const stdout: unknown[] = [];
  const service: Console.Console = {
    ...console,
    error: (...values: readonly unknown[]) => {
      stderr.push(...values);
    },
    log: (...values: readonly unknown[]) => {
      stdout.push(...values);
    },
  };
  return { service, stderr, stdout };
};

it('keeps a stable bounded phase record and the same observations in stderr and the job summary', () => {
  const result = formatStageDeployDiagnostic({ ...baseline, blockers: [blocker] });
  expect(Schema.encodeSync(StageDeployDiagnosticSchema)(result.diagnostic)).toMatchInlineSnapshot(`
    {
      "advisoryOnly": true,
      "authorityPhase": "active",
      "blockers": [
        {
          "failedSettlementCondition": "owner-outcome-unknown",
          "identity": "12345678-1234-4234-8234-123456789abc",
          "kind": "durable-work",
          "lastSuccessfulRecoveryAt": "2026-10-27T00:00:00.000Z",
          "lease": "expired",
          "ownerState": "running",
          "recovery": "available",
        },
      ],
      "blockersTruncated": false,
      "budgetMs": 300000,
      "budgets": {
        "childMigrationMs": 840000,
        "diagnosticMs": 50000,
        "drainMs": 300000,
        "totalMs": 1200000,
      },
      "classification": "proven-blocker",
      "counts": {
        "deliveries": 0,
        "durable": 1,
        "messages": 0,
      },
      "elapsedMs": 15000,
      "failureCode": "unknown",
      "message": "Pending work prevents drain completion; this does not prove abandoned work or failed recovery.",
      "migrationStarted": false,
      "migrationsCompleted": false,
      "nextStep": "Inspect native owner recovery evidence and rerun bounded read-only readiness. Keep the authoritative migration gate; do not clear leases or markers by age.",
      "phase": "drain",
      "reason": "pending-work",
      "schemaVersion": 1,
      "status": "waiting",
    }
  `);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(StageDeployDiagnosticSchema))(
      result.stderr.split('\n').at(-1) ?? '',
    ),
  ).toEqual(result.diagnostic);
  expect(result.summary).toContain(`\`\`\`json\n${result.json}\n\`\`\``);
  expect(result.annotation).toContain(result.diagnostic.message);
  expect(result.annotation).not.toMatch(/[\r\n]/u);
  expect(Schema.is(StageDeployDiagnosticSchema)(result.diagnostic)).toBe(true);
});

it('formats every phase and exit without inventing migration progress', () => {
  for (const phase of StageDeployPhaseSchema.literals) {
    for (const status of StageDeployStatusSchema.literals) {
      const result = formatStageDeployDiagnostic({ phase, status });
      expect(Schema.is(StageDeployDiagnosticSchema)(result.diagnostic)).toBe(true);
      expect(result.diagnostic.phase).toBe(phase);
      expect(result.diagnostic.status).toBe(status);
      expect(result.diagnostic.migrationStarted).toBe('unknown');
      expect(result.diagnostic.migrationsCompleted).toBe('unknown');
      expect(result.diagnostic.authorityPhase).toBe('unknown');
      expect(result.diagnostic.budgetMs).toBeNull();
      expect(result.diagnostic.elapsedMs).toBeNull();
      expect(result.diagnostic.advisoryOnly).toBe(true);
      expect(result.stderr).not.toMatch(/\d+%/u);
      for (const channel of [result.json, result.stderr, result.annotation, result.summary]) {
        expect(Buffer.byteLength(channel)).toBeLessThan(STAGE_DEPLOY_DIAGNOSTIC_LIMITS.outputBytes);
      }
    }
  }
});

it('keeps advisory readiness separate from the authoritative migration decision', () => {
  const result = buildStageDeployDiagnostic({
    ...baseline,
    counts: { deliveries: 0, durable: 0, messages: 0 },
    phase: 'readiness',
    reason: 'drained',
    status: 'ready',
  });
  expect(result.classification).toBe('advisory-ready');
  expect(result.message).toContain('repeat the authoritative gate under the publication lock');
  expect(result.migrationStarted).toBe(false);
  expect(buildStageDeployDiagnostic({ ...baseline, reason: 'drained', status: 'unknown' }).classification).toBe(
    'unknown',
  );
  expect(buildStageDeployDiagnostic({ ...baseline, reason: 'unknown', status: 'blocked' }).classification).toBe(
    'unknown',
  );
});

it('reports only explicit proven authority blockers and never derives recovery health from lease age', () => {
  for (const reason of [
    'authority-expired',
    'authority-sealed',
    'replacement-publication-required',
    'authority-missing',
  ] as const) {
    expect(buildStageDeployDiagnostic({ ...baseline, reason, status: 'blocked' }).classification).toBe(
      'proven-blocker',
    );
    expect(buildStageDeployDiagnostic({ ...baseline, reason, status: 'unknown' }).classification).toBe('unknown');
  }
  const result = buildStageDeployDiagnostic({
    ...baseline,
    blockers: [blocker],
    reason: 'unknown',
    status: 'waiting',
  });
  expect(result.classification).toBe('progress');
  expect(result.blockers[0]?.lease).toBe('expired');
  expect(result.blockers[0]?.recovery).toBe('available');
  expect(result.message).toContain('recovery health are not inferred');
});

it('preserves last known lifecycle and recovery observations on timeout or abort without suggesting another migration', () => {
  for (const status of ['diagnostic-timeout', 'aborted', 'failed'] as const) {
    for (const authorityPhase of ['active', 'draining', 'sealed', 'migrated', 'unknown'] as const) {
      const result = buildStageDeployDiagnostic({
        ...baseline,
        authorityPhase,
        blockers: [blocker],
        migrationStarted: true,
        phase: 'child-migration',
        reason: status === 'failed' ? 'phase-timeout' : 'pending-work',
        status,
      });
      expect(result.classification).toBe('unknown');
      expect(result.authorityPhase).toBe(authorityPhase);
      expect(result.migrationStarted).toBe(true);
      expect(result.migrationsCompleted).toBe(false);
      expect(Schema.encodeSync(StageDeployDiagnosticSchema)(result).blockers[0]?.lastSuccessfulRecoveryAt).toBe(
        observedAt,
      );
      expect(result.nextStep).toContain('do not start a second migration');
      expect(result.nextStep).toContain('native owner outcome');
    }
  }
  const migrated = buildStageDeployDiagnostic({
    ...baseline,
    authorityPhase: 'migrated',
    migrationsCompleted: true,
    migrationStarted: true,
    phase: 'publication',
    reason: 'phase-failed',
    status: 'failed',
  });
  expect(migrated.nextStep).toContain('Do not rerun migrations');
});

it('drops multiline secrets, PII, SQL diagnostics, raw Effect causes and workflow-command payloads', () => {
  const malicious = [
    'postgresql://ontos_admin:db-secret@example.test/db',
    'Bearer signing-secret',
    'session=cookie-secret',
    'person@example.test',
    'SELECT payload FROM owner_journal',
    '\n::error title=pwned::injected\n::set-env name=TOKEN::stolen',
    '\r\nEOF\n```<script>alert(1)</script>',
    '\u001B[31mterminal-injection\u001B[0m',
    '%0A::add-mask::mask-injection',
  ].join('\n');
  const failure = new ApplicationCompositionAuthorityError({
    cause: { cookies: malicious, payload: malicious, sql: malicious },
    code: 'application_composition_authority_unavailable',
    reason: malicious,
  });
  const hostile = { ...baseline, blockers: [{ ...blocker }] };
  for (const key of ['phase', 'status', 'reason', 'authorityPhase', 'message', 'nextStep', 'payload', 'cause']) {
    Reflect.set(hostile, key, malicious);
  }
  for (const key of Object.keys(blocker)) {
    Reflect.set(hostile.blockers[0] ?? {}, key, malicious);
  }
  const result = formatStageDeployFailure(hostile, failure);
  const text = [result.json, result.stderr, result.annotation, result.summary].join('\n');
  for (const forbidden of [
    'db-secret',
    'signing-secret',
    'cookie-secret',
    'person@',
    'SELECT',
    'pwned',
    'stolen',
    'script>',
    'terminal-injection',
    'mask-injection',
  ]) {
    expect(text).not.toContain(forbidden);
  }
  expect(result.diagnostic.failureCode).toBe('authority-unavailable');
  expect(result.diagnostic.classification).toBe('unknown');
  expect(result.diagnostic.blockers[0]).toEqual({
    failedSettlementCondition: 'unknown',
    identity: null,
    kind: 'unknown',
    lastSuccessfulRecoveryAt: null,
    lease: 'unknown',
    ownerState: 'unknown',
    recovery: 'unknown',
  });
  expect(result.annotation.split('::')).toHaveLength(3);
  expect(result.annotation).not.toMatch(/[\r\n]/u);
});

it('recognizes actual migration error contracts without including their secret-bearing description', () => {
  const result = formatStageDeployFailure(
    { ...baseline, phase: 'child-migration', reason: 'phase-failed', status: 'failed' },
    new StageDemoMigrationError({ exitCode: 1, message: 'postgresql://private:secret@host/db' }),
  );
  expect(result.diagnostic.failureCode).toBe('migration-failed');
  expect(result.json).not.toContain('secret');
  expect(formatStageDeployFailure(baseline, { _tag: 'OtherExpectedFailure' }).diagnostic.failureCode).toBe('unknown');
});

it('bounds arrays, identifiers, count categories and durations, and rejects invalid recovery dates', () => {
  const result = formatStageDeployDiagnostic({
    ...baseline,
    blockers: Array.from({ length: 1000 }, () => ({ ...blocker, identity: `sha256:${'a'.repeat(64)}` })),
    budgetMs: Number.POSITIVE_INFINITY,
    counts: { deliveries: Number.NaN, durable: 1000, messages: -1 },
    elapsedMs: Number.MAX_SAFE_INTEGER,
  });
  expect(result.diagnostic.blockers).toHaveLength(10);
  expect(result.diagnostic.blockersTruncated).toBe(true);
  expect(result.diagnostic.counts).toEqual({ deliveries: null, durable: 11, messages: null });
  expect(result.summary).toContain('durable >=11');
  expect(result.diagnostic.budgetMs).toBeNull();
  expect(result.diagnostic.elapsedMs).toBeNull();
  for (const channel of [result.json, result.stderr, result.annotation, result.summary]) {
    expect(Buffer.byteLength(channel)).toBeLessThan(STAGE_DEPLOY_DIAGNOSTIC_LIMITS.outputBytes);
  }
  for (const lastSuccessfulRecoveryAt of [
    '2026-02-30T00:00:00.000Z',
    'not a date',
    '2026-10-27T00:00:00.000Z\nsecret',
  ]) {
    expect(
      buildStageDeployDiagnostic({
        ...baseline,
        blockers: [{ ...blocker, lastSuccessfulRecoveryAt }],
      }).blockers[0]?.lastSuccessfulRecoveryAt,
    ).toBeNull();
  }
  for (const identity of ['person@example.test', 'work-id-secret', 'a'.repeat(10_000)]) {
    expect(
      buildStageDeployDiagnostic({ ...baseline, blockers: [{ ...blocker, identity }] }).blockers[0]?.identity,
    ).toBeNull();
  }
  expect(
    Schema.is(StageDeployDiagnosticSchema)({
      ...result.diagnostic,
      blockers: Array.from({ length: 11 }, () => result.diagnostic.blockers[0]),
    }),
  ).toBe(false);
});

it.effect('provides a useful typed expected error without an empty authority description or raw cause', () =>
  Effect.gen(function* usefulTypedFailure() {
    const error = stageDeployDiagnosticError({ ...baseline, reason: 'phase-timeout', status: 'failed' });
    const failure = yield* Effect.fail(error).pipe(Effect.flip);
    expect(Schema.is(StageDeployDiagnosticError)(failure)).toBe(true);
    expect(failure.message).toContain('phase budget expired');
    expect(failure.message).toContain('Inspect native owner recovery evidence');
    expect(failure.diagnostic.migrationStarted).toBe(false);
    expect(failure.cause).toBeUndefined();
  }),
);

it.effect(
  'writes identical sanitized observations directly to the summary and console without a shell or file read',
  () =>
    Effect.gen(function* writeSummaryAndAnnotation() {
      const output = capturedConsole();
      const writes: unknown[] = [];
      const fileSystem = FileSystem.makeNoop({
        writeFileString: (path, body, options) =>
          Effect.sync(() => {
            writes.push({ body, flag: options?.flag, path });
          }),
      });
      yield* writeStageDeployDiagnostic(baseline, { summaryFile: '/runner/summary' }).pipe(
        Effect.provideService(Console.Console, output.service),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
      const formatted = formatStageDeployDiagnostic(baseline);
      expect(writes).toEqual([{ body: formatted.summary, flag: 'a', path: '/runner/summary' }]);
      expect(output.stderr).toEqual([formatted.stderr]);
      expect(output.stdout).toEqual([formatted.annotation]);
    }),
);

it.effect('keeps summary IO failures typed and sanitized while retaining stderr diagnostics', () =>
  Effect.gen(function* summaryFailure() {
    const output = capturedConsole();
    // The native FileSystem no-op service fails unsupported writes with its real typed PlatformError.
    const failure = yield* writeStageDeployDiagnostic(baseline, { summaryFile: '/runner/private-path' }).pipe(
      Effect.provideService(Console.Console, output.service),
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Effect.flip,
    );
    expect(Schema.is(StageDeployDiagnosticError)(failure)).toBe(true);
    expect(failure.operation).toBe('write-summary');
    expect(failure.message).not.toContain('private-path');
    expect(failure.message).toContain('could not be appended');
    expect(failure.cause).toBeUndefined();
    expect(output.stderr).toEqual([formatStageDeployDiagnostic(baseline).stderr]);
  }),
);

it.effect('never touches an environment file or command-bearing summary path', () =>
  Effect.gen(function* rejectUnsafeSummaryDestination() {
    const output = capturedConsole();
    for (const summaryFile of ['/runner/.env', '/runner/.env.stage', '/runner/summary\n::error::injected', '']) {
      const failure = yield* writeStageDeployDiagnostic(baseline, { summaryFile }).pipe(
        Effect.provideService(Console.Console, output.service),
        Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
        Effect.flip,
      );
      expect(failure.message).toBe('The stage deployment summary requires a dedicated runner output file.');
    }
    yield* writeStageDeployDiagnostic(baseline).pipe(
      Effect.provideService(Console.Console, output.service),
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
    );
  }),
);
