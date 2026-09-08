#!/usr/bin/env node
import nodePath from 'node:path';
import {
  Array as EffectArray,
  Clock,
  Console,
  Effect,
  FileSystem,
  Order,
  Path,
  Result,
  Schema,
  Stream,
} from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { runQualityCli } from './quality-cli-lifecycle.mts';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import {
  buildKnipModel,
  KnipConfigSchema,
  KnipModelEvidenceSchema,
} from '../quality-audit/knip-model.mts';
import type { KnipModelEvidence } from '../quality-audit/knip-model.mts';

const FALLOW_FILES = 'fallow-files';
const FALLOW_HEALTH = 'fallow-health';
const FALLOW_SIMILARITY = 'fallow-similarity';
const TOOL_VERSIONS = { fallow: '3.22.0', jscpd: '5.1.2', knip: '6.34.0' } as const;
const TOOL_BINS = { fallow: 'bin/fallow', jscpd: 'run-jscpd.js', knip: 'bin/knip.js' } as const;
const COMPLEXITY_LIMITS = { cognitive: 15, cyclomatic: 10 } as const;
const SOURCE_GROUPS = {
  fixtures: 'fixtures',
  generated: 'generated-or-templates',
  runtime: 'runtime-tooling',
  tests: 'tests',
} as const;
const ToolSchema = Schema.Literals(['all', 'knip', 'jscpd', 'fallow']);
type AuditTool = typeof ToolSchema.Type;
const CountSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const ScopeSchema = Schema.Struct({
  exclude: Schema.Array(Schema.String),
  patterns: Schema.Array(Schema.String),
});
const KnipIssueSchema = Schema.Struct({
  binaries: Schema.Array(Schema.Unknown),
  dependencies: Schema.Array(Schema.Unknown),
  devDependencies: Schema.Array(Schema.Unknown),
  exports: Schema.Array(Schema.Unknown),
  file: Schema.String,
  files: Schema.Array(Schema.Unknown),
  types: Schema.Array(Schema.Unknown),
  unlisted: Schema.Array(
    Schema.Struct({
      col: Schema.optionalKey(CountSchema),
      line: Schema.optionalKey(CountSchema),
      name: Schema.String,
    }),
  ),
  unresolved: Schema.Array(Schema.Unknown),
});
const KnipSchema = Schema.Struct({ issues: Schema.Array(KnipIssueSchema) });
const KnipCoverageSchema = Schema.Struct({
  coverage: Schema.Struct({ processed: CountSchema, total: CountSchema }),
  findingCounts: Schema.Record(Schema.String, CountSchema),
  workspaces: Schema.Array(Schema.String),
});
const JscpdSchema = Schema.Struct({
  duplicates: Schema.Array(
    Schema.Struct({
      firstFile: Schema.Struct({ name: Schema.String, start: CountSchema }),
      lines: CountSchema,
      secondFile: Schema.Struct({ name: Schema.String, start: CountSchema }),
      tokens: CountSchema,
    }),
  ),
  statistics: Schema.Struct({
    total: Schema.Struct({ clones: CountSchema, sources: CountSchema }),
  }),
});
const DiagnosticSchema = Schema.Struct({
  kind: Schema.String,
  message: Schema.String,
  path: Schema.String,
});
const FallowFilesSchema = Schema.Struct({
  file_count: CountSchema,
  files: Schema.Array(Schema.String),
});
const FallowClonesSchema = Schema.Struct({
  clone_groups: Schema.Array(
    Schema.Struct({
      fingerprint: Schema.String,
      instances: Schema.Array(
        Schema.Struct({ end_line: CountSchema, file: Schema.String, start_line: CountSchema }),
      ).check(Schema.isMinLength(2)),
      line_count: CountSchema,
      token_count: CountSchema,
    }),
  ),
  kind: Schema.Literal('dupes'),
  schema_version: Schema.Literal(9),
  stats: Schema.Struct({ clone_groups: CountSchema, total_files: CountSchema }),
  version: Schema.Literal('3.22.0'),
  workspace_diagnostics: Schema.optionalKey(Schema.Array(DiagnosticSchema)),
});
const FallowHealthSchema = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({
      cognitive: CountSchema,
      contributions: Schema.Array(
        Schema.Struct({
          kind: Schema.String,
          metric: Schema.Literals(['cyclomatic', 'cognitive']),
          weight: CountSchema,
        }),
      ),
      cyclomatic: CountSchema,
      line: CountSchema,
      name: Schema.String,
      path: Schema.String,
    }),
  ),
  kind: Schema.Literal('health'),
  schema_version: Schema.Literal(11),
  summary: Schema.Struct({
    files_analyzed: CountSchema,
    functions_above_threshold: CountSchema,
    functions_analyzed: CountSchema,
    max_cognitive_threshold: Schema.Literal(COMPLEXITY_LIMITS.cognitive),
    max_crap_threshold: Schema.Literal(0),
    max_cyclomatic_threshold: Schema.Literal(COMPLEXITY_LIMITS.cyclomatic),
  }),
  version: Schema.Literal('3.22.0'),
  workspace_diagnostics: Schema.optionalKey(Schema.Array(DiagnosticSchema)),
});

class QualityAuditError extends Schema.TaggedError<QualityAuditError>()('QualityAuditError', {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

interface AuditStep {
  readonly args: readonly string[];
  readonly name: string;
  readonly report?: string;
  readonly tool: Exclude<AuditTool, 'all'>;
}
interface AuditResult {
  readonly coverage: {
    readonly analyzedFiles?: number;
    readonly analyzedFunctions?: number;
    readonly controlFlowFindings?: number;
    readonly discoveredFiles?: number;
    readonly findingCounts?: Readonly<Record<string, number>>;
    readonly modeledUsages?: number;
    readonly nativeFindingCounts?: Readonly<Record<string, number>>;
    readonly processed?: number;
    readonly tokenEligibleFiles?: number;
    readonly total?: number;
    readonly uiOnlyFindings?: number;
    readonly weightedFindings?: number;
    readonly workspaces?: readonly string[];
  };
  readonly diagnostic: string;
  readonly directory: string;
  readonly files: number;
  readonly findings: number;
  readonly name: string;
  readonly status: string;
}

const errorResult = (name: string, directory: string, diagnostic: string): AuditResult => ({
  coverage: {},
  diagnostic,
  directory,
  files: 0,
  findings: 0,
  name,
  status: 'error',
});

const failure = (reason: string): QualityAuditError => new QualityAuditError({ reason });
const jsonCodec = Schema.fromJsonString(Schema.Unknown, { space: 2 });

const writeJson = Effect.fn('qualityAudit.writeJson')(function* writeJsonEffect<A>(
  file: string,
  value: A,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* Schema.encodeEffect(jsonCodec)(value);
  yield* fs.writeFileString(file, `${source}\n`);
});

const decodeReport = <S extends Schema.Top>(
  schema: S,
  source: string,
  subject = 'analyzer report',
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(source).pipe(
    Effect.mapError((issue) => failure(`Malformed ${subject}: ${String(issue)}`)),
  );

const nonempty = (count: number, label: string) =>
  count > 0 ? Effect.void : Effect.fail(failure(`${label}: analysis contains no files`));

const sourceGroup = (file: string) => {
  if (`/${file}`.includes('/fixtures/')) {
    return SOURCE_GROUPS.fixtures;
  }
  if (`/${file}`.includes('/tests/') || /\.(?:test|spec)\./u.test(file)) {
    return SOURCE_GROUPS.tests;
  }
  if (`/${file}`.includes('/templates/') || file.includes('routeTree.gen.')) {
    return SOURCE_GROUPS.generated;
  }
  return SOURCE_GROUPS.runtime;
};

const validateKnip = Effect.fn('qualityAudit.validateKnip')(function* validateKnipEffect(
  name: string,
  source: string,
) {
  const records = source.trim().split('\n');
  if (records.length !== 2) {
    return yield* failure('Knip must emit findings and coverage records');
  }
  const [, coverage] = yield* Effect.all(
    [
      decodeReport(KnipSchema, records[0] ?? ''),
      decodeReport(KnipCoverageSchema, records[1] ?? ''),
    ],
    { concurrency: 'unbounded' },
  );
  yield* nonempty(coverage.coverage.processed, name);
  yield* nonempty(coverage.coverage.total, name);
  yield* nonempty(coverage.workspaces.length, 'Knip workspaces');
  return {
    coverage: {
      findingCounts: coverage.findingCounts,
      processed: coverage.coverage.processed,
      total: coverage.coverage.total,
      workspaces: coverage.workspaces,
    },
    files: coverage.coverage.processed,
    findings: Object.values(coverage.findingCounts).reduce((sum, count) => sum + count, 0),
  };
});

const modeledUsage = (
  file: string,
  issue: (typeof KnipIssueSchema.Type.unlisted)[number],
  evidence: readonly KnipModelEvidence[],
) =>
  evidence.find((entry) => {
    if (
      entry.source !== file ||
      entry.target !== issue.name ||
      entry.resolved === undefined ||
      entry.anchor === undefined
    ) {
      return false;
    }
    if (entry.kind === 'resolver') {
      return (
        entry.line === issue.line &&
        entry.column === issue.col &&
        entry.owningManifest !== undefined
      );
    }
    return entry.kind === 'compiler-option' && issue.line === undefined && issue.col === undefined;
  });

const calibrateKnip = Effect.fn('qualityAudit.calibrateKnip')(function* calibrateKnipEffect(
  source: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const report = yield* decodeReport(KnipSchema, source.trim().split('\n')[0] ?? '');
  const evidence = yield* decodeReport(
    Schema.Array(KnipModelEvidenceSchema),
    yield* fs.readFileString(path.join(path.dirname(directory), 'knip-model.json')),
  );
  const modeled = report.issues.flatMap((record) =>
    record.unlisted.flatMap((issue) => {
      const consumer = modeledUsage(record.file, issue, evidence);
      return consumer === undefined
        ? []
        : [{ category: 'unlisted', consumer, file: record.file, issue }];
    }),
  );
  yield* writeJson(path.join(directory, 'modeled-usages.json'), modeled);
  return modeled.length;
});

const evaluateKnip = Effect.fn('qualityAudit.evaluateKnip')(function* evaluateKnipEffect(
  report: string,
  directory: string,
) {
  const validated = yield* validateKnip('knip', report);
  const modeledUsages = yield* calibrateKnip(report, directory);
  const nativeFindingCounts = validated.coverage.findingCounts;
  const { unlisted: nativeUnlisted = 0 } = nativeFindingCounts;
  const unlisted = nativeUnlisted - modeledUsages;
  if (unlisted < 0) {
    return yield* failure('Knip modeled usages exceed raw unlisted count');
  }
  return {
    ...validated,
    coverage: {
      ...validated.coverage,
      findingCounts: { ...nativeFindingCounts, unlisted },
      modeledUsages,
      nativeFindingCounts,
    },
    findings: validated.findings - modeledUsages,
  };
});

const validateJscpd = Effect.fn('qualityAudit.validateJscpd')(function* validateJscpdEffect(
  name: string,
  source: string,
) {
  const report = yield* decodeReport(JscpdSchema, source);
  yield* nonempty(report.statistics.total.sources, name);
  if (report.statistics.total.clones !== report.duplicates.length) {
    return yield* failure('JSCPD clone count disagrees with report');
  }
  return {
    coverage: { tokenEligibleFiles: report.statistics.total.sources },
    files: report.statistics.total.sources,
    findings: report.duplicates.length,
  };
});

const validateDiscovery = Effect.fn('qualityAudit.validateDiscovery')(
  function* validateDiscoveryEffect(name: string, source: string) {
    const report = yield* decodeReport(FallowFilesSchema, source);
    yield* nonempty(report.file_count, name);
    if (report.file_count !== report.files.length) {
      return yield* failure('Fallow discovery count disagrees with file list');
    }
    return {
      coverage: { discoveredFiles: report.file_count },
      files: report.file_count,
      findings: 0,
    };
  },
);

const validateClones = Effect.fn('qualityAudit.validateClones')(function* validateClonesEffect(
  name: string,
  source: string,
) {
  const report = yield* decodeReport(FallowClonesSchema, source);
  yield* nonempty(report.stats.total_files, name);
  if ((report.workspace_diagnostics?.length ?? 0) > 0) {
    return yield* failure('Fallow reports incomplete workspace discovery; inspect raw report');
  }
  if (report.stats.clone_groups !== report.clone_groups.length) {
    return yield* failure('Fallow clone count disagrees with report');
  }
  return {
    coverage: { tokenEligibleFiles: report.stats.total_files },
    files: report.stats.total_files,
    findings: report.clone_groups.length,
  };
});

const validateHealth = Effect.fn('qualityAudit.validateHealth')(function* validateHealthEffect(
  name: string,
  source: string,
) {
  const report = yield* decodeReport(FallowHealthSchema, source);
  yield* nonempty(report.summary.files_analyzed, name);
  yield* nonempty(report.summary.functions_analyzed, 'Fallow functions');
  if ((report.workspace_diagnostics?.length ?? 0) > 0) {
    return yield* failure('Fallow reports incomplete workspace discovery; inspect raw report');
  }
  if (report.summary.functions_above_threshold !== report.findings.length) {
    return yield* failure('Fallow complexity count disagrees with report');
  }
  const complexity = report.findings.map((finding) => {
    const cyclomatic =
      1 +
      finding.contributions
        .filter((entry) => entry.metric === 'cyclomatic')
        .reduce((sum, entry) => sum + entry.weight, 0);
    const cognitive = finding.contributions
      .filter((entry) => entry.metric === 'cognitive')
      .reduce((sum, entry) => sum + entry.weight, 0);
    const hookDensityWeight = finding.contributions
      .filter((entry) => entry.metric === 'cognitive' && entry.kind === 'hook-density')
      .reduce((sum, entry) => sum + entry.weight, 0);
    const propCountWeight = finding.contributions
      .filter((entry) => entry.metric === 'cognitive' && entry.kind === 'prop-count')
      .reduce((sum, entry) => sum + entry.weight, 0);
    const controlFlowCognitive = cognitive - hookDensityWeight - propCountWeight;
    return {
      controlFlowCognitive,
      cyclomatic: finding.cyclomatic,
      exceedsControlFlowLimits:
        finding.cyclomatic > COMPLEXITY_LIMITS.cyclomatic ||
        controlFlowCognitive > COMPLEXITY_LIMITS.cognitive,
      hookDensityWeight,
      line: finding.line,
      name: finding.name,
      path: finding.path,
      propCountWeight,
      reconstructed: cyclomatic === finding.cyclomatic && cognitive === finding.cognitive,
      weightedCognitive: finding.cognitive,
    };
  });
  if (complexity.some((finding) => !finding.reconstructed)) {
    return yield* failure('Fallow complexity contributions disagree with function metrics');
  }
  if (
    report.findings.some(
      (finding) =>
        finding.cyclomatic <= COMPLEXITY_LIMITS.cyclomatic &&
        finding.cognitive <= COMPLEXITY_LIMITS.cognitive,
    )
  ) {
    return yield* failure('Fallow reported a function below both configured thresholds');
  }
  const controlFlowFindings = complexity.filter(
    (finding) => finding.exceedsControlFlowLimits,
  ).length;
  return {
    complexity,
    coverage: {
      analyzedFiles: report.summary.files_analyzed,
      analyzedFunctions: report.summary.functions_analyzed,
      controlFlowFindings,
      uiOnlyFindings: complexity.length - controlFlowFindings,
      weightedFindings: complexity.length,
    },
    files: report.summary.files_analyzed,
    findings: controlFlowFindings,
  };
});

export const validateReport = Effect.fn('qualityAudit.validateReport')(
  function* validateReportEffect(name: string, source: string) {
    switch (name) {
      case 'knip': {
        return yield* validateKnip(name, source);
      }
      case 'jscpd': {
        return yield* validateJscpd(name, source);
      }
      case FALLOW_FILES: {
        return yield* validateDiscovery(name, source);
      }
      case 'fallow-clones':
      case FALLOW_SIMILARITY: {
        return yield* validateClones(name, source);
      }
      case FALLOW_HEALTH: {
        return yield* validateHealth(name, source);
      }
      default: {
        return yield* failure(`Unknown analyzer report: ${name}`);
      }
    }
  },
);

const collectSourceFiles = Effect.fn('qualityAudit.collectSourceFiles')(
  function* collectSourceFilesEffect(root: string, output: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = yield* fs.readFileString(path.join(root, 'quality-audit/scope.json'));
    const scope = yield* decodeReport(ScopeSchema, source, 'quality-audit/scope.json');
    const [canonicalRoot, canonicalOutput] = yield* Effect.all([
      fs.realPath(root),
      fs.realPath(output),
    ]);
    const outputPaths = [
      path.relative(root, output),
      path.relative(canonicalRoot, canonicalOutput),
    ];
    if (
      outputPaths.some((directory) =>
        scope.patterns.some((pattern) =>
          nodePath.matchesGlob(path.join(directory, 'knip-consumers.mts'), pattern),
        ),
      )
    ) {
      return yield* failure(
        'Choose an output directory outside configured source roots, such as .codex/reports/quality-audit',
      );
    }
    const groups = yield* Effect.forEach(
      scope.patterns,
      (pattern) =>
        fs.glob(pattern, {
          exclude: scope.exclude,
          root,
        }),
      { concurrency: 'unbounded' },
    );
    const files = EffectArray.sort([...new Set(groups.flat())], Order.String);
    yield* nonempty(files.length, 'Source inventory');
    return files;
  },
);

const readSourceProvenance = Effect.fn('qualityAudit.readSourceProvenance')(
  function* readProvenance(root: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const git = (args: readonly string[]) =>
      spawner
        .string(ChildProcess.make('git', args, { cwd: root }))
        .pipe(Effect.timeout('10 seconds'), Effect.result);
    const [revision, status] = yield* Effect.all(
      [git(['rev-parse', 'HEAD']), git(['status', '--porcelain=v1', '--untracked-files=all'])],
      { concurrency: 'unbounded' },
    );
    return {
      sourceRevision: Result.isSuccess(revision)
        ? revision.success.trim()
        : 'unavailable (no Git HEAD)',
      sourceState: Result.match(status, {
        onFailure: () => 'unavailable',
        onSuccess: (output) => (output.trim().length > 0 ? 'modified' : 'clean'),
      }),
      workingTreeChanges: Result.isSuccess(status)
        ? status.success.trimEnd().split('\n').filter(Boolean)
        : [],
    };
  },
);

const snapshotConfiguration = Effect.fn('qualityAudit.snapshotConfiguration')(
  function* snapshotConfigurationEffect(
    root: string,
    directory: string,
    tool: AuditTool,
    consumerPath: string | undefined,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const selected = ['knip', 'jscpd', 'fallow'].filter((name) => tool === 'all' || tool === name);
    const configs = [
      'scope.json',
      ...selected.map((name) => `${name}.json`),
      ...(selected.includes('knip') ? ['knip-reporter.mts'] : []),
    ];
    yield* fs.makeDirectory(path.join(directory, 'configs'));
    yield* Effect.forEach(
      configs,
      (name) =>
        fs.copyFile(path.join(root, 'quality-audit', name), path.join(directory, 'configs', name)),
      { concurrency: 'unbounded' },
    );
    if (selected.includes('knip')) {
      const target = path.join(directory, 'configs/knip.json');
      yield* fs.copyFile(target, path.join(directory, 'configs/knip-base.json'));
      const source = yield* fs.readFileString(target);
      const config = yield* decodeReport(KnipConfigSchema, source, target);
      const model = yield* buildKnipModel(root, config, consumerPath);
      if (model.consumerSource !== undefined && consumerPath !== undefined) {
        yield* fs.writeFileString(consumerPath, model.consumerSource);
        yield* fs.copyFile(consumerPath, path.join(directory, 'knip-consumers.mts'));
      }
      yield* writeJson(target, model.config);
      yield* writeJson(path.join(directory, 'knip-model.json'), model.evidence);
    }
    if (selected.includes('fallow')) {
      const target = path.join(directory, 'configs/fallow.json');
      const source = yield* fs.readFileString(target);
      const config = yield* decodeReport(Schema.Record(Schema.String, Schema.Json), source, target);
      const ignores = yield* decodeReport(
        Schema.Struct({ ignorePatterns: Schema.Array(Schema.String) }),
        source,
        target,
      );
      const relativeOutput = path.relative(root, path.dirname(directory));
      const outputIsInsideRoot =
        relativeOutput !== '..' &&
        !relativeOutput.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeOutput);
      yield* writeJson(target, {
        ...config,
        ignorePatterns: outputIsInsideRoot
          ? [...ignores.ignorePatterns, `${relativeOutput}/**`]
          : ignores.ignorePatterns,
      });
    }
    return configs;
  },
);

const verifyFallowCounts = (results: readonly AuditResult[]) => {
  const discovery = results.find((result) => result.name === FALLOW_FILES);
  const health = results.find((result) => result.name === FALLOW_HEALTH);
  return discovery?.status === 'reported' &&
    health?.status === 'reported' &&
    discovery.files !== health.files
    ? Effect.fail(failure('Fallow discovery and complexity file counts disagree'))
    : Effect.void;
};

const reconcileFallowCoverage = Effect.fn('qualityAudit.reconcileFallowCoverage')(
  function* reconcileFallowCoverageEffect(
    directory: string,
    files: readonly string[],
    results: readonly AuditResult[],
    expectedWorkspaces: readonly string[],
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fallow = results.find(
      (result) => result.name === FALLOW_FILES && result.status === 'reported',
    );
    if (fallow !== undefined) {
      const report = yield* decodeReport(
        FallowFilesSchema,
        yield* fs.readFileString(path.join(fallow.directory, 'report.json')),
      );
      const discovered = new Set(report.files);
      const intended = new Set(files);
      const missing = files.filter((file) => !discovered.has(file));
      const extra = report.files.filter((file) => !intended.has(file));
      yield* writeJson(path.join(directory, 'coverage.json'), {
        expectedWorkspaces,
        extra,
        intendedSources: files.length,
        missing,
        note: 'Fallow additionally discovers CSS; clone statistics count only token-eligible files.',
      });
      const counts = yield* verifyFallowCounts(results).pipe(Effect.result);
      if (missing.length > 0 || extra.some((file) => !file.endsWith('.css'))) {
        const diagnostic = [
          'Fallow discovery differs from source inventory; inspect coverage.json',
          Result.isFailure(counts) ? String(counts.failure) : '',
        ]
          .filter(Boolean)
          .join('; ');
        return yield* failure(diagnostic);
      }
      if (Result.isFailure(counts)) {
        return yield* counts.failure;
      }
    }
    return yield* Effect.void;
  },
);

const reconcileCoverage = Effect.fn('qualityAudit.reconcileCoverage')(
  function* reconcileCoverageEffect(
    root: string,
    directory: string,
    files: readonly string[],
    results: readonly AuditResult[],
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalRoot = yield* fs.realPath(root);
    const expectedManifests = yield* fs.glob('{apps,verticals,packages}/*/package.json', {
      exclude: ['**/node_modules/**'],
      root,
    });
    const expectedWorkspaces = ['.', ...expectedManifests.map((file) => path.dirname(file))];
    const knip = results.find((result) => result.name === 'knip' && result.status === 'reported');
    if (knip !== undefined) {
      const observed = (knip.coverage.workspaces ?? []).map(
        (workspace) => path.relative(canonicalRoot, workspace) || '.',
      );
      if (
        observed.length !== expectedWorkspaces.length ||
        expectedWorkspaces.some((workspace) => !observed.includes(workspace))
      ) {
        return yield* failure(
          `Knip workspace coverage mismatch: expected ${expectedWorkspaces.join(', ')}, observed ${observed.join(', ')}`,
        );
      }
    }
    return yield* reconcileFallowCoverage(directory, files, results, expectedWorkspaces);
  },
);

const executeStep = Effect.fn('qualityAudit.executeStep')(function* executeStepEffect(
  root: string,
  directory: string,
  step: AuditStep,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* fs.makeDirectory(directory, { recursive: true });
  const stdoutPath = path.join(directory, 'stdout.txt');
  const stderrPath = path.join(directory, 'stderr.txt');
  yield* Effect.all([fs.writeFileString(stdoutPath, ''), fs.writeFileString(stderrPath, '')], {
    concurrency: 'unbounded',
  });
  const startedAt = yield* Clock.currentTimeMillis;
  const binary = path.join(root, 'node_modules', step.tool, TOOL_BINS[step.tool]);
  const command = [process.execPath, binary, ...step.args];
  const execution = yield* Effect.gen(function* launchAnalyzer() {
    if (!(yield* fs.exists(binary))) {
      return yield* failure(`Missing pinned local binary: ${binary}`);
    }
    const installed = yield* decodeReport(
      Schema.Struct({ version: Schema.String }),
      yield* fs.readFileString(path.join(root, 'node_modules', step.tool, 'package.json')),
    );
    if (installed.version !== TOOL_VERSIONS[step.tool]) {
      return yield* failure(
        `Expected ${step.tool} ${TOOL_VERSIONS[step.tool]}, found ${installed.version}`,
      );
    }
    const processHandle = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [binary, ...step.args], {
        cwd: root,
        env: { NO_COLOR: '1' },
        extendEnv: true,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      }),
    );
    const [exitCode] = yield* Effect.all(
      [
        processHandle.exitCode,
        Stream.run(processHandle.stdout, fs.sink(stdoutPath)),
        Stream.run(processHandle.stderr, fs.sink(stderrPath)),
      ],
      { concurrency: 'unbounded' },
    );
    return { exitCode: Number(exitCode), verifiedVersion: installed.version };
  }).pipe(Effect.scoped, Effect.timeout('5 minutes'), Effect.result);
  const endedAt = yield* Clock.currentTimeMillis;
  const executionError = Result.isFailure(execution) ? String(execution.failure) : '';
  const exitCode = Result.isSuccess(execution) ? execution.success.exitCode : -1;
  yield* writeJson(path.join(directory, 'metadata.json'), {
    command,
    cwd: root,
    endedAt,
    executionError,
    exitCode,
    expectedVersion: TOOL_VERSIONS[step.tool],
    startedAt,
    verifiedVersion: Result.isSuccess(execution) ? execution.success.verifiedVersion : '',
  });
  const evaluated = yield* Effect.gen(function* evaluateAnalyzer() {
    if (executionError.length > 0) {
      return yield* failure(executionError);
    }
    if (exitCode !== 0) {
      return yield* failure(`Analyzer exited ${exitCode}; inspect stdout.txt and stderr.txt`);
    }
    const stderr = yield* fs.readFileString(stderrPath);
    if (
      stderr.trim().length > 0 &&
      !(step.name === 'jscpd' && stderr.trim() === `Using config from ${step.args[1]}`)
    ) {
      return yield* failure(
        'Analyzer emitted diagnostics; inspect stderr.txt before trusting coverage',
      );
    }
    const reportPath = step.report ?? stdoutPath;
    const report = yield* fs.readFileString(reportPath);
    yield* fs.writeFileString(
      path.join(directory, step.name === 'knip' ? 'report.ndjson' : 'report.json'),
      report,
    );
    return step.name === 'knip'
      ? yield* evaluateKnip(report, directory)
      : yield* validateReport(step.name, report);
  }).pipe(Effect.result);
  if (Result.isFailure(evaluated)) {
    const diagnostic = String(evaluated.failure);
    yield* fs.writeFileString(path.join(directory, 'validation-error.txt'), `${diagnostic}\n`);
    return errorResult(step.name, directory, diagnostic);
  }
  if ('complexity' in evaluated.success) {
    const { complexity, ...summary } = evaluated.success;
    yield* writeJson(path.join(directory, 'complexity.json'), complexity);
    return { name: step.name, status: 'reported', ...summary, diagnostic: '', directory };
  }
  return { name: step.name, status: 'reported', ...evaluated.success, diagnostic: '', directory };
});

export const auditSteps = (
  root: string,
  runDirectory: string,
  tool: AuditTool,
): readonly AuditStep[] => {
  const config = `${runDirectory}/configs`;
  const common = [
    '--root',
    root,
    '--config',
    `${config}/fallow.json`,
    '--format',
    'json',
    '--no-cache',
    '--threads',
    '2',
    '--no-production',
    '--no-type-aware',
  ];
  const steps: readonly AuditStep[] = [
    {
      args: [
        '--config',
        `${config}/knip.json`,
        '--reporter',
        'json',
        '--reporter',
        `${root}/quality-audit/knip-reporter.mts`,
        '--no-exit-code',
        '--no-progress',
      ],
      name: 'knip',
      tool: 'knip',
    },
    {
      args: ['--config', `${runDirectory}/jscpd.config.json`, '--output', `${runDirectory}/jscpd`],
      name: 'jscpd',
      report: `${runDirectory}/jscpd/jscpd-report.json`,
      tool: 'jscpd',
    },
    { args: ['list', '--files', ...common], name: FALLOW_FILES, tool: 'fallow' },
    {
      args: ['dupes', '--mode', 'strict', '--min-tokens', '100', '--min-lines', '10', ...common],
      name: 'fallow-clones',
      tool: 'fallow',
    },
    {
      args: ['dupes', '--mode', 'semantic', '--min-tokens', '100', '--min-lines', '10', ...common],
      name: FALLOW_SIMILARITY,
      tool: 'fallow',
    },
    {
      args: [
        'health',
        '--complexity',
        '--complexity-breakdown',
        '--max-cyclomatic',
        String(COMPLEXITY_LIMITS.cyclomatic),
        '--max-cognitive',
        String(COMPLEXITY_LIMITS.cognitive),
        '--max-crap',
        '0',
        '--report-only',
        ...common,
      ],
      name: FALLOW_HEALTH,
      tool: 'fallow',
    },
  ];
  return steps.filter((step) => tool === 'all' || step.tool === tool);
};

const REPORT_MEANINGS = {
  [FALLOW_HEALTH]: { advisory: false, unit: 'functions above control-flow limits' },
  'fallow-clones': { advisory: false, unit: 'strict clone groups' },
  'fallow-files': { advisory: false, unit: 'discovery only' },
  'fallow-similarity': { advisory: true, unit: 'semantic similarity groups (advisory)' },
  jscpd: { advisory: false, unit: 'token clone pairs' },
  knip: { advisory: false, unit: 'unused/dependency records' },
};

const reportMeaning = (name: string) =>
  Object.entries(REPORT_MEANINGS).find(([analysis]) => analysis === name)?.[1];

const writeSummary = Effect.fn('qualityAudit.writeSummary')(function* writeSummaryEffect(
  output: string,
  runDirectory: string,
  results: readonly AuditResult[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rows = results.map(
    (result) =>
      `| ${result.name} | ${result.status} | ${result.findings} | ${reportMeaning(result.name)?.unit ?? 'diagnostic'} | ${result.files} |`,
  );
  const errors = results.filter((result) => result.status === 'error');
  yield* writeJson(path.join(output, 'summary.json'), {
    expectedToolVersions: TOOL_VERSIONS,
    mode: 'report-only',
    parserCompleteness: 'unavailable; use existing lint and compiler checks',
    provenance: `${runDirectory}/provenance.json`,
    results: results.map((result) => ({ ...result, ...reportMeaning(result.name) })),
    runDirectory,
    status: errors.length > 0 ? 'error' : 'reported',
  });
  yield* fs.writeFileString(
    path.join(output, 'summary.md'),
    [
      '# Code quality audit (report only)',
      '',
      '| Analysis | Status | Count | Unit | Files |',
      '| --- | --- | ---: | --- | ---: |',
      ...rows,
      '',
      'Findings are audit evidence, not accepted debt or a delivery threshold.',
      'These counts overlap and have different units; do not add them into an error total.',
      'Knip counts below exclude only proven modeled consumers. Raw category counts and every corrected issue are retained in report.ndjson and modeled-usages.json.',
      ...results
        .filter((result) => result.name === 'knip')
        .flatMap((result) => [
          '',
          '| Knip category | Remaining records |',
          '| --- | ---: |',
          ...Object.entries(result.coverage.findingCounts ?? {}).map(
            ([category, count]) => `| ${category} | ${count} |`,
          ),
          '',
          `Proven modeled usages retained separately: ${result.coverage.modeledUsages ?? 0}.`,
        ]),
      'Unused exports describe an unused public binding; they do not establish that the implementation body is unused.',
      'Fallow strict clones preserve literal differences. Semantic similarity normalizes them and remains advisory; inspect both together with JSCPD before choosing a shared implementation.',
      `Health counts cyclomatic > ${COMPLEXITY_LIMITS.cyclomatic} or control-flow cognitive > ${COMPLEXITY_LIMITS.cognitive}. The latter subtracts hook-density and prop-count penalties from the native weighted metric, with contribution arithmetic verified for every finding.`,
      ...results
        .filter((result) => result.name === FALLOW_HEALTH)
        .map(
          (result) =>
            `UI-only advisories excluded from the control-flow count: ${result.coverage.uiOnlyFindings ?? 0}. Native weighted findings: ${result.coverage.weightedFindings ?? 0}. Per-function evidence: fallow-health/complexity.json.`,
        ),
      'Source inventory and raw reports live in the run directory. Clone file counts include only token-eligible files; discovery and complexity counts cover the wider source corpus.',
      'Analyzer discovery is not proof of successful parsing: these tools can silently accept malformed source. Existing lint and compiler checks remain authoritative.',
      '',
      `Run directory: ${runDirectory}`,
      '',
      ...errors.map((result) => `- ${result.name}: ${result.diagnostic}`),
      '',
    ].join('\n'),
  );
});

const createConsumerPath = Effect.fn('qualityAudit.createConsumerPath')(
  function* createConsumerPathEffect(root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = path.join(root, '.codex');
    yield* fs.makeDirectory(parent, { recursive: true });
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: parent,
      prefix: 'quality-audit-model-',
    });
    return path.join(directory, 'consumers.mts');
  },
);

export const runQualityAudit = Effect.fn('qualityAudit.runQualityAudit')(
  function* runQualityAuditEffect(root: string, output: string, tool: AuditTool) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const provenance = yield* readSourceProvenance(root);
    yield* fs.makeDirectory(output, { recursive: true });
    const runDirectory = yield* fs.makeTempDirectory({ directory: output, prefix: 'run-' });
    yield* writeSummary(output, runDirectory, [
      errorResult('setup', runDirectory, 'Audit has not completed'),
    ]);
    const results = yield* Effect.gen(function* collectAudit() {
      const files = yield* collectSourceFiles(root, output);
      yield* writeJson(path.join(runDirectory, 'source-inventory.json'), {
        count: files.length,
        entries: files.map((file) => ({ group: sourceGroup(file), path: file })),
        files,
        groupCounts: Object.fromEntries(
          Object.values(SOURCE_GROUPS).map((group) => [
            group,
            files.filter((file) => sourceGroup(file) === group).length,
          ]),
        ),
        root,
      });
      const consumerPath =
        tool === 'all' || tool === 'knip' ? yield* createConsumerPath(root) : undefined;
      const configs = yield* snapshotConfiguration(root, runDirectory, tool, consumerPath);
      yield* writeJson(path.join(runDirectory, 'provenance.json'), {
        ...provenance,
        configs: configs.map((name) => `configs/${name}`),
        expectedToolVersions: TOOL_VERSIONS,
        parserCompleteness: 'unavailable',
      });
      if (tool === 'all' || tool === 'jscpd') {
        const jscpdConfig = yield* decodeReport(
          Schema.Record(Schema.String, Schema.Json),
          yield* fs.readFileString(path.join(runDirectory, 'configs/jscpd.json')),
          'configs/jscpd.json',
        );
        yield* writeJson(path.join(runDirectory, 'jscpd.config.json'), {
          ...jscpdConfig,
          path: files.map((file) => path.resolve(root, file)),
        });
      }
      const stepResults = yield* Effect.forEach(
        auditSteps(root, runDirectory, tool),
        (step) => executeStep(root, path.join(runDirectory, step.name), step),
        { concurrency: 1 },
      );
      return yield* reconcileCoverage(root, runDirectory, files, stepResults).pipe(
        Effect.match({
          onFailure: (issue) => [
            ...stepResults,
            errorResult('coverage', runDirectory, String(issue)),
          ],
          onSuccess: () => stepResults,
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.match({
        onFailure: (issue) => [errorResult('setup', runDirectory, String(issue))],
        onSuccess: (collected) => collected,
      }),
    );
    yield* writeSummary(output, runDirectory, results);
    yield* Console.log(`Quality audit: ${path.join(output, 'summary.md')}`);
    const errors = results.filter((result) => result.status === 'error');
    if (errors.length > 0) {
      yield* Effect.forEach(
        errors,
        (result) => Console.error(`${result.name}: ${result.diagnostic}`),
        { concurrency: 1 },
      );
      return yield* failure(
        'Quality audit analysis failed; diagnostics preserved in summary and raw artifacts',
      );
    }
    return yield* Effect.void;
  },
);

const cli = Command.make(
  'quality-audit',
  {
    output: Flag.string('output').pipe(Flag.withDefault('.codex/reports/quality-audit')),
    tool: Flag.choice('tool', ['all', 'knip', 'jscpd', 'fallow']).pipe(Flag.withDefault('all')),
  },
  ({ output, tool }) =>
    Effect.gen(function* qualityAuditCommand() {
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL('..', import.meta.url));
      yield* runQualityAudit(root, path.resolve(root, output), tool);
    }),
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
