#!/usr/bin/env node
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Cause, Clock, Console, Effect, Exit, FileSystem, Layer, Option, Result, Schema, Stream } from 'effect';
import { Command, Flag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import {
  AccessCatalogArtifactSchema,
  checkAccessCatalogArtifact,
  readAccessCatalogArtifact,
} from '../authorization-catalog-artifact.mts';
import {
  assertRegisteredWorkloadCallers,
  assertRegisteredWorkloadCallsReceived,
} from '../check-ontos-module-contracts.mts';
import { policyReleaseEntries } from '../demo/access-policy.mts';
import { demoModuleIds } from '../demo/permissions.mts';
import type { DesiredState } from '../demo/reviewed-people-plan.mts';
import { desiredState } from '../demo/reviewed-people-plan.mts';
import { deriveOntosModuleRelease } from '../generate-ontos-module-contract.mts';

/**
 * `node scripts/merge/adaptation-check.mts --base <40-hex demo commit> [--json <path>]`, from app/.
 *
 * The preflight of a main -> demo merge candidate. It runs this workspace's own generator code and reports every
 * adaptation gap it can find at once, by owner and key, where the gates stop at the first vertical:
 * - every vertical's contract derivation; an MCP coverage gap gives one finding per key. A module's commands and
 *   actions gaps appear only after its reads gap is fixed, because the coverage check stops at the first group.
 * - every registered-workload call, one call at a time, against the reviewed callers and its receiver. A call whose
 *   receiver failed to derive is checked against the reviewed callers only (a note counts them), so a derivation
 *   gap gives no false call finding. The calls of a caller that failed to derive are unknown and not checked.
 * - the committed authorization catalog artifact against the workspace.
 * - the reviewed roles: a target policy that does not compile is a finding. The unreviewed and withdrawn cells of
 *   the reviewed-cell allowlist are information, never findings; an unreviewed cell says whether the base release
 *   lacked it. A commit from before the allowlist has no such cells, and a note says so.
 * Packaging gaps (an import that needs a new package export) need the node build; the gates prove those.
 * Writes `ontos-merge-adaptation/1` JSON and exits non-zero when there is any finding.
 */

const APP_ROOT = nodePath.resolve(import.meta.dirname, '..', '..');
const BASE_CATALOG_PATH = 'app/topology/authorization-catalog.json';
const DERIVE_CONCURRENCY = 4;
const GIT_TIMEOUT = '1 minute';
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const MCP_GAP = /^(?<module>\S+): MCP (?<group>reads|commands|actions) not contributed or hidden: (?<keys>.+)$/u;
const MCP_STALE = /^(?<module>\S+): MCP (?<group>reads|commands|actions) do not exist in the module: (?<keys>.+)$/u;

class AdaptationCheckError extends Schema.TaggedError<AdaptationCheckError>()('AdaptationCheckError', {
  message: Schema.String,
}) {}

const checkFailure = (message: string): AdaptationCheckError => new AdaptationCheckError({ message });

const REVIEWED_ROLES = 'reviewed-roles';
const FindingKindSchema = Schema.Literals([
  'authorization-catalog-stale',
  'contract',
  'mcp-actions',
  'mcp-commands',
  'mcp-reads',
  'mcp-stale',
  'registered-workload-call',
  REVIEWED_ROLES,
]);

const FindingSchema = Schema.Struct({
  key: Schema.optional(Schema.String),
  kind: FindingKindSchema,
  message: Schema.optional(Schema.String),
  module: Schema.optional(Schema.String),
  owner: Schema.String,
});
type Finding = typeof FindingSchema.Type;

const RoleDiagnosticSchema = Schema.Struct({
  /** Whether the base release lacked the capability; null for withdrawn cells and when the base is unusable. */
  introduced: Schema.OptionFromNullOr(Schema.Boolean),
  kind: Schema.Literals(['unreviewed', 'withdrawn']),
  owner: Schema.String,
  slot: Schema.String,
});
type RoleDiagnostic = typeof RoleDiagnosticSchema.Type;

const AdaptationReportSchema = Schema.Struct({
  base: Schema.String,
  clean: Schema.Boolean,
  durationMs: Schema.Number,
  findings: Schema.Array(FindingSchema),
  head: Schema.String,
  notes: Schema.Array(Schema.String),
  roleDiagnostics: Schema.Array(RoleDiagnosticSchema),
  schema: Schema.Literal('ontos-merge-adaptation/1'),
});
type AdaptationReport = typeof AdaptationReportSchema.Type;

const TopologySchema = Schema.fromJsonString(
  Schema.Struct({ verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })) }),
);

/** Runs git in the repository; a non-zero exit fails with its stderr. */
const git = Effect.fn(function* git(args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [code, stdout, stderr] = yield* Effect.scoped(
    Effect.gen(function* collectOutput() {
      const handle = yield* spawner.spawn(
        ChildProcess.make('git', [...args], { cwd: APP_ROOT, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' }),
      );
      return yield* Effect.all(
        [
          handle.exitCode,
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
        ],
        { concurrency: 'unbounded' },
      );
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: GIT_TIMEOUT,
      orElse: () => Effect.fail(checkFailure(`git ${args.join(' ')} timed out`)),
    }),
    Effect.mapError((cause) => checkFailure(`git ${args.join(' ')}: ${cause.message}`)),
  );
  return Number(code) === 0
    ? stdout
    : yield* Effect.fail(checkFailure(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
});

const isMessageCarrier = Schema.is(Schema.Struct({ cause: Schema.optional(Schema.Unknown), message: Schema.String }));

/** Every message of a failure's `.cause` chain, outermost first; the innermost is the one the classifier reads. */
const messageChain = (cause: Cause.Cause<unknown>): readonly string[] => {
  const messages: string[] = [];
  let current: unknown = Cause.squash(cause);
  while (isMessageCarrier(current)) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.length > 0 ? messages : [Cause.pretty(cause)];
};

const innermost = (messages: readonly string[]): string => messages.at(-1) ?? '';

/** One finding per key of an MCP coverage gap, `mcp-stale` per unknown key, `contract` for anything else. */
const derivationFindings = (owner: string, cause: Cause.Cause<unknown>): readonly Finding[] => {
  const messages = messageChain(cause);
  const message = innermost(messages);
  const gap = MCP_GAP.exec(message)?.groups;
  if (gap?.module !== undefined && gap.group !== undefined && gap.keys !== undefined) {
    const kind = Schema.decodeUnknownOption(FindingKindSchema)(`mcp-${gap.group}`);
    const { module } = gap;
    return Option.isSome(kind)
      ? gap.keys.split(', ').map((key) => ({ key, kind: kind.value, module, owner }))
      : [{ kind: 'contract', message: messages.join(': '), owner }];
  }
  const stale = MCP_STALE.exec(message)?.groups;
  if (stale?.module !== undefined && stale.keys !== undefined) {
    const { module } = stale;
    return stale.keys.split(', ').map((key) => ({ key, kind: 'mcp-stale', module, owner }));
  }
  return [{ kind: 'contract', message: messages.join(': '), owner }];
};

const verticalsOf = Effect.fn(function* verticalsOf() {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* fileSystem.readFileString(nodePath.join(APP_ROOT, 'topology/reference-topology.json'));
  const topology = yield* Schema.decodeUnknownEffect(TopologySchema)(source).pipe(
    Effect.mapError(() => checkFailure('topology/reference-topology.json does not list the verticals')),
  );
  return topology.verticals.map(({ id, path }) => ({ appId: id, owner: nodePath.basename(path) }));
});

const deriveAll = Effect.fn(function* deriveAll() {
  const verticals = yield* verticalsOf();
  const exits = yield* Effect.forEach(
    verticals,
    ({ owner }) => Effect.exit(deriveOntosModuleRelease({ vertical: owner, workspaceRoot: APP_ROOT })),
    { concurrency: DERIVE_CONCURRENCY },
  );
  const derived = verticals.flatMap((vertical, index) => {
    const exit = exits[index];
    return exit !== undefined && Exit.isSuccess(exit) ? [{ ...vertical, contract: exit.value.contract }] : [];
  });
  const failed = verticals.flatMap((vertical, index) => {
    const exit = exits[index];
    return exit !== undefined && Exit.isFailure(exit) ? [{ ...vertical, cause: exit.cause }] : [];
  });
  return { derived, failed };
});

type Derived = Effect.Success<ReturnType<typeof deriveAll>>['derived'][number];

/**
 * Both registered-workload assertions stop at their first failure, so each call is asserted alone: the caller
 * carries only that call and every other contract carries none, which keeps every receiver in reach.
 */
const registeredWorkloadFindings = Effect.fn(function* registeredWorkloadFindings(
  derived: readonly Derived[],
  failedAppIds: ReadonlySet<string>,
) {
  const findings: Finding[] = [];
  let skipped = 0;
  for (const caller of derived) {
    const calls = caller.contract.manifest.registeredWorkloadCalls ?? [];
    const others = derived
      .filter((other) => other !== caller)
      .map(({ contract }) => ({ ...contract, manifest: { ...contract.manifest, registeredWorkloadCalls: [] } }));
    for (const call of calls) {
      const alone = { ...caller.contract, manifest: { ...caller.contract.manifest, registeredWorkloadCalls: [call] } };
      const receiverMissing = failedAppIds.has(call.audience);
      if (receiverMissing) {
        skipped += 1;
      }
      const exits = yield* Effect.all(
        [
          Effect.exit(assertRegisteredWorkloadCallers([alone])),
          ...(receiverMissing ? [] : [Effect.exit(assertRegisteredWorkloadCallsReceived([alone, ...others]))]),
        ],
        { concurrency: 1 },
      );
      for (const exit of exits.filter(Exit.isFailure)) {
        findings.push({
          key: call.workloadKey,
          kind: 'registered-workload-call',
          message: innermost(messageChain(exit.cause)),
          owner: caller.owner,
        });
      }
    }
  }
  return { findings, skipped };
});

const decodeBaseArtifact = Schema.decodeUnknownEffect(Schema.fromJsonString(AccessCatalogArtifactSchema));

/**
 * The target policy compiled over the target artifact, and its review diagnostics. An unreviewed diagnostic is
 * `introduced` when its capability is absent from the release the same policy compiles from the base artifact.
 * The base only marks diagnostics, so a base that is unreadable or does not compile leaves them unmarked with a note.
 */
const reviewedRoles = Effect.fn(function* reviewedRoles(base: string) {
  const targetModules = yield* Effect.exit(readAccessCatalogArtifact(APP_ROOT));
  if (Exit.isFailure(targetModules)) {
    return {
      diagnostics: [],
      findings: [{ kind: REVIEWED_ROLES, message: innermost(messageChain(targetModules.cause)), owner: 'demo' }],
      notes: [],
    } as const;
  }
  const desired = Result.flatMap(policyReleaseEntries(targetModules.value, demoModuleIds), desiredState);
  if (Result.isFailure(desired)) {
    return {
      diagnostics: [],
      findings: [{ kind: REVIEWED_ROLES, message: desired.failure, owner: 'demo' }],
      notes: [],
    } as const;
  }
  // A DesiredState from before the reviewed-cell allowlist has no diagnostics.
  const { diagnostics: reviewed }: Partial<Pick<DesiredState, 'diagnostics'>> = desired.success;
  if (reviewed === undefined) {
    return {
      diagnostics: [],
      findings: [],
      notes: ['this commit predates the reviewed-cell allowlist; role growth is not diagnosed'],
    } as const;
  }
  const baseArtifact = yield* Effect.exit(
    git(['show', `${base}:${BASE_CATALOG_PATH}`]).pipe(Effect.flatMap(decodeBaseArtifact)),
  );
  const baseEntries = Exit.isSuccess(baseArtifact)
    ? policyReleaseEntries(baseArtifact.value.modules, demoModuleIds)
    : Result.fail(`${base}:${BASE_CATALOG_PATH} is unreadable: ${innermost(messageChain(baseArtifact.cause))}`);
  const baseKeys = Result.isSuccess(baseEntries)
    ? Option.some(new Set(baseEntries.success.map((entry) => String(entry.key))))
    : Option.none<ReadonlySet<string>>();
  const diagnostics = reviewed.map(({ kind, roleKey, slot }): RoleDiagnostic => ({
    introduced:
      kind === 'unreviewed'
        ? baseKeys.pipe(Option.map((keys) => !keys.has(slot.split(' ')[0] ?? slot)))
        : Option.none(),
    kind,
    owner: roleKey,
    slot,
  }));
  return {
    diagnostics,
    findings: [],
    notes: Result.isFailure(baseEntries)
      ? [`the base release is unusable for this policy (${baseEntries.failure}); diagnostics are not marked`]
      : [],
  } as const;
});

const reportLines = (report: AdaptationReport, out: Option.Option<string>): readonly string[] => {
  const owners = [...new Set(report.findings.map(({ owner }) => owner))].toSorted();
  return [
    `merge adaptation of ${report.head} onto ${report.base}: ${report.findings.length} findings in ${report.durationMs} ms`,
    ...owners.flatMap((owner) => [
      `${owner}:`,
      ...report.findings
        .filter((finding) => finding.owner === owner)
        .map(({ key, kind, message, module }) => {
          const label = ['', kind, module, key].filter((part) => part !== undefined).join(' ');
          return message === undefined ? ` ${label}` : ` ${label}: ${message}`;
        }),
    ]),
    ...report.notes.map((note) => `note: ${note}`),
    `reviewed-role diagnostics (information, never granted): ${report.roleDiagnostics.length}`,
    ...report.roleDiagnostics.map(
      ({ introduced, kind, owner, slot }) =>
        `  ${kind} ${owner}: ${slot}${Option.contains(introduced, true) ? ' (new since the base)' : ''}`,
    ),
    ...Option.match(out, { onNone: () => [], onSome: (path) => [`report: ${path}`] }),
  ];
};

export const checkMergeAdaptation = Effect.fn(function* checkMergeAdaptation(options: {
  readonly base: string;
  readonly json: Option.Option<string>;
}) {
  const started = yield* Clock.currentTimeMillis;
  if (!COMMIT_SHA.test(options.base)) {
    return yield* Effect.fail(checkFailure(`--base must be a 40-hex commit, got ${options.base}`));
  }
  yield* git(['cat-file', '-e', `${options.base}^{commit}`]);
  const head = (yield* git(['rev-parse', 'HEAD'])).trim();
  const { derived, failed } = yield* deriveAll();
  const registered = yield* registeredWorkloadFindings(derived, new Set(failed.map(({ appId }) => appId)));
  const catalog = yield* Effect.exit(checkAccessCatalogArtifact(APP_ROOT));
  const roles = yield* reviewedRoles(options.base);
  const findings: readonly Finding[] = [
    ...failed.flatMap(({ cause, owner }) => derivationFindings(owner, cause)),
    ...registered.findings,
    ...(Exit.isFailure(catalog)
      ? [
          {
            kind: 'authorization-catalog-stale',
            message: innermost(messageChain(catalog.cause)),
            owner: 'topology',
          } as const,
        ]
      : []),
    ...roles.findings,
  ];
  const report: AdaptationReport = {
    base: options.base,
    clean: findings.length === 0,
    durationMs: (yield* Clock.currentTimeMillis) - started,
    findings,
    head,
    notes: [
      ...(failed.length > 0
        ? [
            `partial: ${failed.length} contracts missing; their registered-workload calls are not checked, and ${registered.skipped} calls to them are checked against the reviewed callers only`,
          ]
        : []),
      ...roles.notes,
    ],
    roleDiagnostics: roles.diagnostics,
    schema: 'ontos-merge-adaptation/1',
  };
  if (Option.isSome(options.json)) {
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(AdaptationReportSchema, { space: 2 }))(
      report,
    ).pipe(Effect.mapError((issue) => checkFailure(`unable to encode the report: ${issue.message}`)));
    yield* fileSystem.makeDirectory(nodePath.dirname(options.json.value), { recursive: true });
    yield* fileSystem.writeFileString(options.json.value, `${encoded}\n`);
  }
  yield* Console.log(reportLines(report, options.json).join('\n'));
  return report.clean
    ? report
    : yield* Effect.fail(checkFailure(`${findings.length} adaptation findings; fix them before promoting the merge`));
});

const command = Command.make(
  'merge-adaptation-check',
  { base: Flag.String('base'), json: Flag.String('json').pipe(Flag.optional) },
  ({ base, json }) => checkMergeAdaptation({ base, json }).pipe(Effect.asVoid),
);

const [, invokedPath] = process.argv;
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const mainLayer = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(NodeServices.layer),
  );
  NodeRuntime.runMain(Effect.scoped(Layer.build(mainLayer)).pipe(Effect.asVoid));
}
