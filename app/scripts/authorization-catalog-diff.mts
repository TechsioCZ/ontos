#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { Console, Effect, Layer, Path, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { Command, Flag } from 'effect/cli';

import {
  AccessCatalogDiffSchema,
  buildAccessCatalogDiff,
  buildAccessCatalogSnapshot,
  decodeTopologyCallerAppIds,
  isAccessCatalogSourcePath,
  renderAccessCatalogDiffText,
} from './authorization-catalog.mts';
import type { AccessCatalogDiffInput, AccessCatalogSnapshot, AccessCatalogSource } from './authorization-catalog.mts';
import { TOPOLOGY_RELATIVE_PATH } from './stage-access-catalog.mts';

/**
 * `authorization:catalog:diff --from <ref> [--to <ref>]` — the access catalog delta between two
 * revisions, which is what a module release contributes to Novinky v oprávněních. Report only: it
 * never fails on additions, removals or risk changes and never changes a decision.
 */

const GIT_GREP_PATTERNS = ['accessDeclaration', 'accessActor'] as const;
const GIT_CONCURRENCY = 8;

class AccessCatalogDiffError extends Schema.TaggedError<AccessCatalogDiffError>()('AccessCatalogDiffError', {
  reason: Schema.String,
}) {}

const diffFailure = (reason: string): AccessCatalogDiffError => new AccessCatalogDiffError({ reason });

const git = (args: readonly string[], cwd: string) =>
  Effect.gen(function* runGit() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(
      ChildProcess.make('git', [...args], { cwd, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' }),
    );
  });

const resolveRef = (ref: string, cwd: string) =>
  Effect.gen(function* resolveRefEffect() {
    const commit = yield* git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).pipe(
      Effect.map((value) => value.trim()),
      Effect.orElseSucceed<PlatformError, string>(() => ''),
    );
    return commit.length === 0
      ? yield* Effect.fail(diffFailure(`git ref ${ref} does not resolve to a commit`))
      : commit;
  });

/** Files at one revision that can carry a declaration; a repository without any is not an error. */
const declaredFiles = (ref: string, cwd: string) =>
  git(['grep', '-l', ...GIT_GREP_PATTERNS.flatMap((pattern) => ['-e', pattern]), ref, '--', 'app'], cwd).pipe(
    Effect.map((output) => output.split('\n').filter((line) => line.includes(':'))),
    Effect.map((lines) => lines.map((line) => line.slice(line.indexOf(':') + 1).trim())),
    Effect.orElseSucceed<PlatformError, readonly string[]>(() => []),
  );

const readSourceAtRef = (ref: string, file: string, cwd: string) =>
  git(['show', `${ref}:${file}`], cwd).pipe(
    Effect.map((source): AccessCatalogSource => ({ file: file.replace(/^app\//u, ''), source })),
    Effect.orElseSucceed<PlatformError, AccessCatalogSource | null>(() => null),
  );

/** The verticals one revision's topology allows as module callers: the scan reads that revision's topology. */
const topologyCallerAppIdsAtRef = (ref: string, cwd: string) =>
  Effect.gen(function* topologyCallerAppIdsAtRefEffect() {
    const topologyPath = `app/${TOPOLOGY_RELATIVE_PATH}`;
    const source = yield* git(['show', `${ref}:${topologyPath}`], cwd).pipe(
      Effect.mapError(() => diffFailure(`${topologyPath} is not readable at ${ref}`)),
    );
    return yield* Effect.fromResult(decodeTopologyCallerAppIds(source)).pipe(
      Effect.mapError((reason) => diffFailure(`${topologyPath} at ${ref} is not a topology: ${reason}`)),
    );
  });

const readCatalogAtRef = (ref: string, cwd: string) =>
  Effect.gen(function* readCatalogAtRefEffect() {
    const files = (yield* declaredFiles(ref, cwd)).filter((file) =>
      isAccessCatalogSourcePath(file.replace(/^app\//u, '')),
    );
    const callerAppIds = yield* topologyCallerAppIdsAtRef(ref, cwd);
    const sources = yield* Effect.forEach(files, (file) => readSourceAtRef(ref, file, cwd), {
      concurrency: GIT_CONCURRENCY,
    });
    const present = sources.filter((source): source is AccessCatalogSource => source !== null);
    return buildAccessCatalogSnapshot(present, callerAppIds);
  });

const diffInput = (snapshot: AccessCatalogSnapshot): AccessCatalogDiffInput => ({
  entries: snapshot.entries.map((entry) => ({
    entrypointKey: entry.entrypointKey,
    file: entry.file,
    key: entry.key,
    kind: entry.kind,
    moduleId: entry.moduleId,
    renamedFrom: entry.renamedFrom,
    risk: entry.risk,
    splitFrom: entry.splitFrom,
  })),
});

export const diffAccessCatalogRevisions = (options: {
  readonly from: string;
  readonly json: boolean;
  readonly to: string;
}) =>
  Effect.gen(function* diffAccessCatalogRevisionsEffect() {
    const path = yield* Path.Path;
    const cwd = path.resolve(path.join(import.meta.dirname, '..', '..'));
    const baseCommit = yield* resolveRef(options.from, cwd);
    const headCommit = yield* resolveRef(options.to, cwd);
    const before = yield* readCatalogAtRef(baseCommit, cwd);
    const after = yield* readCatalogAtRef(headCommit, cwd);
    const diff = buildAccessCatalogDiff(diffInput(before), diffInput(after), {
      baseRef: options.from,
      headRef: options.to,
    });
    if (options.json) {
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(AccessCatalogDiffSchema, { space: 2 }))(
        diff,
      ).pipe(Effect.mapError((issue) => diffFailure(`unable to encode the catalog diff: ${issue.message}`)));
      yield* Console.log(encoded);
      return;
    }
    const reviewItems = `Review items outside the catalog: ${before.invalid.length} at ${options.from}, ${after.invalid.length} at ${options.to}.`;
    yield* Console.log(renderAccessCatalogDiffText(diff));
    yield* Console.log(reviewItems);
  });

const command = Command.make(
  'authorization-catalog-diff',
  {
    from: Flag.String('from'),
    json: Flag.Boolean('json').pipe(Flag.withDefault(false)),
    to: Flag.String('to').pipe(Flag.withDefault('HEAD')),
  },
  ({ from, json, to }) => diffAccessCatalogRevisions({ from, json, to }),
);

const [, invokedPath] = process.argv;
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const mainLayer = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(NodeServices.layer),
  );
  NodeRuntime.runMain(Effect.scoped(Layer.build(mainLayer)).pipe(Effect.asVoid));
}
