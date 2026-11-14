import { createRequire } from 'node:module';
import {
  classifyPriceGroupReadDiagnostic,
  classifyPriceGroupReadResultDiagnostic,
  PriceGroupCatalogDatabaseCertificateSchema,
  projectPriceGroupCatalogDatabaseCertificate,
} from '../support/price-group-current-receiver.fixture.ts';
import { fileURLToPath } from 'node:url';
import {
  PriceGroupOwnedDatabaseCertificateSchema,
  priceGroupTemporalProtocol,
  PriceGroupPreparedArtifactSchema,
  priceGroupPreparedArtifactMatches,
  priceGroupDedicatedUrlMatches,
} from '../support/price-group-temporal-protocol.ts';
import { ReadResultValidationError, ReadEvidenceValidationError, ReadHandlerExecutionError } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import {
  Cause,
  Clock,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  SchemaIssue,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';
import { CustomerPriceGroupResolutionCurrentnessEvidenceSchema } from '../../shared/apis/customer-price-group-resolution.ts';
import { CustomerPriceGroupResolutionSchema } from '../../shared/domain/price-group-contracts.ts';
import {
  assignmentReceiptScenario,
  bootstrapByteBudgetScenario,
  decodeChildDiagnosticStage,
  executorDeniedScenario,
  fail,
  observe,
  preservedReadResultFailure,
  temporalArtifactsLayer,
  temporalCaseLayer,
} from './price-group-effective-period-postgres.fixture.ts';

it.effect('forwards only exact fixed Price Group child diagnostic stages', () =>
  Effect.sync(() => {
    expect(Option.getOrUndefined(decodeChildDiagnosticStage('C_PARTY_HTTP_READY'))).toBe('C_PARTY_HTTP_READY');
    expect(Option.getOrUndefined(decodeChildDiagnosticStage('C_CATALOG_BOOTSTRAP_SEND_DONE'))).toBe(
      'C_CATALOG_BOOTSTRAP_SEND_DONE',
    );
    for (const stage of [
      'BOOTSTRAP_OWNED_DATABASE',
      'BOOTSTRAP_CONFIGURATION',
      'BOOTSTRAP_MIGRATION',
      'BOOTSTRAP_RUNTIME',
      'BOOTSTRAP_OTHER',
    ]) {
      expect(Option.getOrUndefined(decodeChildDiagnosticStage(stage))).toBe(stage);
    }
    for (const line of [
      'BOOTSTRAP_RUNTIME extra',
      ' BOOTSTRAP_RUNTIME',
      'BOOTSTRAP_RUNTIME\r',
      'BOOTSTRAP_UNREVIEWED',
      '{"stage":"BOOTSTRAP_RUNTIME"}',
      'C_PARTY_HTTP_READY extra',
      'C_CATALOG_SPAWNED:at_ms=123',
      ' C_PARTY_HTTP_READY',
      'C_PARTY_HTTP_READY\r',
      'P_BEGIN',
      'Bearer fixture-only',
      '{"stage":"C_PARTY_HTTP_READY"}',
      'arbitrary child output',
    ]) {
      expect(Option.isNone(decodeChildDiagnosticStage(line))).toBe(true);
    }
  }),
);

it.effect('classifies Price Group Read failures with only closed diagnostic stages', () =>
  Effect.sync(() => {
    const failures = [
      new ReadResultValidationError({ code: 'read_result_invalid', reason: 'fixture-only' }),
      new ReadEvidenceValidationError({ code: 'read_evidence_invalid', reason: 'fixture-only' }),
      new ReadHandlerExecutionError({ code: 'read_handler_execution_failed', reason: 'fixture-only' }),
    ];
    const expected = ['READ_RESULT_INVALID', 'READ_EVIDENCE_INVALID', 'READ_HANDLER_FAILED'];
    for (const [index, failure] of failures.entries()) {
      const stage = classifyPriceGroupReadDiagnostic(Cause.fail(failure));
      expect(stage).toBe(expected[index]);
      expect(Option.getOrUndefined(decodeChildDiagnosticStage(stage))).toBe(stage);
    }
    expect(classifyPriceGroupReadDiagnostic(Cause.fail({ reason: 'private fixture-only value' }))).toBe(
      'READ_OTHER_TYPED',
    );
    expect(classifyPriceGroupReadDiagnostic(Cause.die(new Error('private fixture-only defect')))).toBe('READ_DEFECT');
    expect(classifyPriceGroupReadDiagnostic(Cause.combine(Cause.fail(failures[0]), Cause.die('fixture-only')))).toBe(
      'READ_DEFECT',
    );
    for (const stage of ['READ_OTHER_TYPED', 'READ_DEFECT']) {
      expect(Option.getOrUndefined(decodeChildDiagnosticStage(stage))).toBe(stage);
    }
    for (const line of ['READ_DEFECT private', 'READ_UNKNOWN', 'READ_RESULT_INVALID\n', 'P_OPEN_FINITE_NONE_BEGIN']) {
      expect(Option.isNone(decodeChildDiagnosticStage(line))).toBe(true);
    }
  }),
);

it.effect('classifies only whitelisted Price Group result fields and predicates', () =>
  Effect.sync(() => {
    const cases = [
      {
        flag: 'READ_RESULT_TIMESTAMP_SHAPE',
        message: 'timestamp must be one canonical UTC instant with millisecond precision',
        path: ['observedAt'],
      },
      {
        flag: 'READ_RESULT_CURRENTNESS_TIMELINE',
        message: 'Customer Price Group Current-set evidence must be observed and revalidated after evaluation',
        path: ['currentnessEvidence'],
      },
      {
        flag: 'READ_RESULT_PREDICATE_BINDING',
        message: 'Customer Price Group owner evidence must bind the exact Profile and evaluation instant',
        path: [],
      },
      {
        flag: 'READ_RESULT_ENVELOPE_TIMES',
        message: 'Customer Price Group owner evidence must preserve one evaluation and observation timeline',
        path: [],
      },
      {
        flag: 'READ_RESULT_GENERATION_REVISION',
        message: 'Customer Price Group owner evidence must bind one generation and owner Revision',
        path: [],
      },
      {
        flag: 'READ_RESULT_NEXT_BOUNDARY',
        message: 'Customer Price Group verification must precede the next applicability boundary',
        path: [],
      },
    ];
    for (const entry of cases) {
      const leaf = new SchemaIssue.InvalidValue({ message: entry.message });
      const failure = preservedReadResultFailure(new SchemaIssue.Pointer(entry.path, leaf));
      const originalCause = 'cause' in failure ? failure.cause : undefined;
      expect(classifyPriceGroupReadResultDiagnostic(failure)).toEqual([entry.flag]);
      expect('cause' in failure ? failure.cause : undefined).toBe(originalCause);
      expect(Option.getOrUndefined(decodeChildDiagnosticStage(entry.flag))).toBe(entry.flag);
      expect(Option.isNone(decodeChildDiagnosticStage(`${entry.flag} private`))).toBe(true);
    }
    const timelineError = Schema.decodeUnknownExit(
      Schema.toType(CustomerPriceGroupResolutionCurrentnessEvidenceSchema),
    )({
      evaluatedAt: '2026-10-27T00:00:02.000Z',
      generation: 'fixture-generation',
      observedAt: '2026-10-27T00:00:01.000Z',
      ownerRevision: 'fixture-revision',
      predicateRef: 'fixture-predicate',
      revalidatedAt: '2026-10-27T00:00:01.000Z',
      verificationMode: 'OWNER_CURRENT_SET_REVALIDATED',
    });
    if (Exit.isSuccess(timelineError)) {
      throw new Error('Expected invalid pure currentness fixture');
    }
    for (const reason of timelineError.cause.reasons) {
      if (Cause.isFailReason(reason)) {
        expect(
          classifyPriceGroupReadResultDiagnostic(
            preservedReadResultFailure(new SchemaIssue.Pointer(['currentnessEvidence'], reason.error.issue)),
          ),
        ).toContain('READ_RESULT_CURRENTNESS_TIMELINE');
      }
    }
    const resolutionError = Schema.decodeUnknownExit(CustomerPriceGroupResolutionSchema)({ _tag: 'PRIVATE_UNKNOWN' });
    if (Exit.isSuccess(resolutionError)) {
      throw new Error('Expected invalid pure resolution fixture');
    }
    for (const reason of resolutionError.cause.reasons) {
      if (Cause.isFailReason(reason)) {
        expect(
          classifyPriceGroupReadResultDiagnostic(
            preservedReadResultFailure(new SchemaIssue.Pointer(['resolution'], reason.error.issue)),
          ),
        ).toContain('READ_RESULT_RESOLUTION_SHAPE');
      }
    }
    for (const issue of [
      new SchemaIssue.Pointer(['foreign'], new SchemaIssue.InvalidValue({ message: cases[0]?.message })),
      new SchemaIssue.Pointer(['observedAt'], new SchemaIssue.InvalidValue({ message: 'private unknown predicate' })),
      new SchemaIssue.Pointer(['foreign'], new SchemaIssue.InvalidValue({ message: cases[1]?.message })),
    ]) {
      expect(classifyPriceGroupReadResultDiagnostic(preservedReadResultFailure(issue))).toEqual([
        'READ_RESULT_UNCLASSIFIED',
      ]);
    }
    expect(
      classifyPriceGroupReadResultDiagnostic(
        Object.assign(new ReadResultValidationError({ code: 'read_result_invalid', reason: 'fixture-only' }), {
          cause: { issue: new SchemaIssue.InvalidValue() },
        }),
      ),
    ).toEqual(['READ_RESULT_UNCLASSIFIED']);
    expect(
      classifyPriceGroupReadResultDiagnostic(
        new ReadResultValidationError({ code: 'read_result_invalid', reason: 'fixture-only' }),
      ),
    ).toEqual(['READ_RESULT_UNCLASSIFIED']);
    expect(Option.getOrUndefined(decodeChildDiagnosticStage('READ_RESULT_UNCLASSIFIED'))).toBe(
      'READ_RESULT_UNCLASSIFIED',
    );
  }),
);

it.effect('projects the exact strict Catalog certificate without creator-only fields', () =>
  Effect.sync(() => {
    const name = `ontos_test_party_gateway_${'1'.repeat(32)}`;
    const expanded = {
      adminRole: 'postgres',
      adminUrl: `postgresql://postgres@localhost:5432/${name}`,
      creatorPid: 1,
      name,
      oid: 1,
      owner: 'postgres',
      runtimeRole: 'ontos_runtime',
      runtimeUrl: `postgresql://ontos_runtime@localhost:5432/${name}`,
      serverAddress: '127.0.0.1',
      serverPort: 5432,
      systemIdentifier: '123',
    };
    const projected = projectPriceGroupCatalogDatabaseCertificate(expanded);
    expect(Object.keys(projected)).toEqual([
      'adminRole',
      'adminUrl',
      'name',
      'oid',
      'owner',
      'runtimeRole',
      'runtimeUrl',
      'serverAddress',
      'serverPort',
    ]);
    const decode = Schema.decodeUnknownOption(PriceGroupCatalogDatabaseCertificateSchema, {
      onExcessProperty: 'error',
    });
    expect(Option.isSome(decode(projected))).toBe(true);
    expect(Option.isNone(decode(expanded))).toBe(true);
    expect(Option.isNone(decode({ ...projected, creatorPid: 1 }))).toBe(true);
    expect(Option.isNone(decode({ ...projected, systemIdentifier: '123' }))).toBe(true);
    const { creatorPid: _creatorPid, systemIdentifier: _systemIdentifier, ...catalogFields } = expanded;
    expect(projected).toEqual(catalogFields);
  }),
);

it.effect('rejects changed prepared artifact owner build path and hash observations', () =>
  Effect.sync(() => {
    const artifact = Schema.decodeUnknownSync(PriceGroupPreparedArtifactSchema)({
      appId: 'party-registry',
      artifact: '/fixture/party/.cache/ontos-1248/11111111-1111-1111-1111-111111111111.mjs',
      buildMarker: 'party-build',
      description: '{"appId":"party-registry","buildMarker":"party-build"}',
      directory: '/fixture/party',
      sha256: '1'.repeat(64),
    });
    expect(priceGroupPreparedArtifactMatches(artifact, artifact)).toBe(true);
    for (const changed of [
      { ...artifact, appId: 'price-group-catalog' as const },
      { ...artifact, buildMarker: 'other-build' },
      { ...artifact, artifact: '/foreign/owner.mjs' },
      { ...artifact, directory: '/foreign' },
      { ...artifact, sha256: '2'.repeat(64) },
    ]) {
      expect(priceGroupPreparedArtifactMatches(artifact, changed)).toBe(false);
    }
  }),
);

it.effect('rejects a foreign Price Group dedicated database URL or role without fallback', () =>
  Effect.sync(() => {
    const name = `ontos_test_party_gateway_${'1'.repeat(32)}`;
    const certificate = Schema.decodeUnknownSync(PriceGroupOwnedDatabaseCertificateSchema)({
      adminRole: 'postgres',
      adminUrl: `postgresql://postgres@localhost:5432/${name}`,
      creatorPid: 1,
      name,
      oid: 1,
      owner: 'postgres',
      runtimeRole: 'ontos_runtime',
      runtimeUrl: `postgresql://ontos_runtime@localhost:5432/${name}`,
      serverAddress: '127.0.0.1',
      serverPort: 5432,
      systemIdentifier: '123',
    });
    const party = `postgresql://party_registry_runtime@localhost:5432/${name}`;
    const issuer = `postgresql://shell_gateway_issuer@localhost:5432/${name}`;
    expect(priceGroupDedicatedUrlMatches(party, certificate, 'party_registry_runtime')).toBe(true);
    expect(priceGroupDedicatedUrlMatches(issuer, certificate, 'shell_gateway_issuer')).toBe(true);
    for (const address of [
      party.replace(name, 'foreign_database'),
      party.replace('localhost', 'remote.invalid'),
      party.replace(':5432', ':5433'),
      party.replace('party_registry_runtime', 'ontos_runtime'),
      party.replace('postgresql:', 'https:'),
      `${party}?role=party_registry_runtime`,
      `${party}#scope`,
      'invalid',
      party.replace('party_registry_runtime', '%ZZ'),
    ]) {
      expect(priceGroupDedicatedUrlMatches(address, certificate, 'party_registry_runtime')).toBe(false);
    }
    expect(priceGroupDedicatedUrlMatches(party, certificate, 'shell_gateway_issuer')).toBe(false);
    expect(priceGroupDedicatedUrlMatches(issuer, certificate, 'party_registry_runtime')).toBe(false);
  }),
);

it.effect('waits for the observed Price Group boundary after an early timer completion', () =>
  Effect.gen(function* observeEarlyTimerCompletion() {
    const clock = yield* Clock.Clock;
    const boundary = DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-27T00:00:00.000Z'));
    let now = boundary - 100;
    let observations = 0;
    const sleeps: number[] = [];
    const earlyTimerClock: Clock.Clock = {
      currentTimeMillis: Effect.sync(() => {
        observations += 1;
        return now;
      }),
      currentTimeMillisUnsafe: () => now,
      currentTimeNanos: clock.currentTimeNanos,
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      sleep: (duration) =>
        Effect.sync(() => {
          sleeps.push(Duration.toMillis(duration));
          now = sleeps.length === 1 ? boundary - 80 : boundary;
        }),
    };
    yield* observe(DateTime.formatIso(DateTime.makeUnsafe(boundary))).pipe(
      Effect.provideService(Clock.Clock, earlyTimerClock),
    );
    expect(now).toBe(boundary);
    expect(observations).toBe(3);
    expect(sleeps).toEqual([100, 80]);
    yield* observe(DateTime.formatIso(DateTime.makeUnsafe(boundary))).pipe(
      Effect.provideService(Clock.Clock, earlyTimerClock),
    );
    expect(observations).toBe(4);
    expect(sleeps).toEqual([100, 80]);
  }),
);

const temporalArtifactMemoMap = Layer.makeMemoMapUnsafe();

it.layer(temporalArtifactsLayer, { excludeTestServices: true, memoMap: temporalArtifactMemoMap, timeout: 120_000 })(
  () => {
    it.layer(temporalCaseLayer('current').pipe(Layer.provideMerge(temporalArtifactsLayer)), {
      excludeTestServices: true,
      memoMap: temporalArtifactMemoMap,
      timeout: 120_000,
    })((caseIt) => {
      caseIt.effect(
        'recovers an explicit original Price Group Assignment through real public owner receivers without replaying its mutation',
        () => Effect.scoped(assignmentReceiptScenario()),
        120_000,
      );
      // The native runner's AbortSignal interrupts the Effect Scope and cleans up both real children.
      // This is one 20-second case budget, distinct from the owned fixture's setup-hook budget.
      caseIt.effect(
        'accepts the exact actual Price Group bootstrap byte budget and rejects the next byte',
        () => Effect.scoped(bootstrapByteBudgetScenario()),
        20_000,
      );
    });

    it.layer(temporalCaseLayer('current', 'without-catalog-create').pipe(Layer.provideMerge(temporalArtifactsLayer)), {
      excludeTestServices: true,
      memoMap: temporalArtifactMemoMap,
      timeout: 120_000,
    })((caseIt) => {
      caseIt.effect(
        'keeps the real Price Group create executor gate independent of its granted business Permission',
        () => Effect.scoped(executorDeniedScenario()),
      );
    });
  },
);

it.live('executes public Price Group process modes without receiver database startup', () =>
  Effect.scoped(
    Effect.gen(function* processModeControls() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = fileURLToPath(new URL('../../', import.meta.url));
      const entry = createRequire(new URL('../../package.json', import.meta.url)).resolve(
        '@app/commerce-customer-context/testing/price-group-current-receiver',
      );
      const cache = path.join(directory, '.cache');
      yield* fs.makeDirectory(cache, { recursive: true });
      const temporary = yield* fs.makeTempDirectoryScoped({ directory: cache, prefix: 'price-group-mode-' });
      const artifact = path.join(temporary, 'receiver.mjs');
      const bundle = yield* ChildProcess.make(
        '../../node_modules/esbuild/bin/esbuild',
        [entry, '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${artifact}`],
        {
          cwd: directory,
          env: { APP_ENV_PATH: '/dev/null' },
          extendEnv: false,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
        },
      );
      const [bundleCode] = yield* Effect.all(
        [bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)],
        { concurrency: 3 },
      );
      expect(bundleCode).toBe(0);
      const execute = Effect.fn('PriceGroupTemporal.modeControl')(function* modeControl(args: readonly string[]) {
        const child = yield* ChildProcess.make(process.execPath, [artifact, ...args], {
          cwd: directory,
          env: { APP_ENV_PATH: '/dev/null' },
          extendEnv: false,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
        });
        const [code, stdout, stderr] = yield* Effect.all(
          [
            child.exitCode,
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          ],
          { concurrency: 3 },
        );
        return { code, stderr, stdout };
      });
      const described = yield* execute(['--describe-price-group-current']);
      expect(described.code).toBe(0);
      yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            appId: Schema.Literal('commerce-customer-context'),
            type: Schema.Literal('description'),
            version: Schema.Literal(priceGroupTemporalProtocol),
          }),
        ),
      )(described.stdout.trim());
      const conflict = yield* execute(['--describe-price-group-current', '--serve-price-group-current']);
      expect(conflict.code).not.toBe(0);
      expect(conflict.stderr).toContain('PRICE_GROUP_FIXTURE_MODE_CONFLICT\n');
      expect(conflict.stdout).not.toContain('"type":"description"');
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
