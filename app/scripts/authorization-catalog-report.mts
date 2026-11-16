#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, FileSystem, Layer, Option, Path, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { Command, Flag } from 'effect/cli';

import {
  AccessCatalogReportSchema,
  accessCatalogGapReason,
  buildAccessCatalogReport,
  buildAccessCatalogSnapshot,
  isAccessCatalogContextSourcePath,
  renderAccessCatalogReportText,
} from './authorization-catalog.mts';
import type { AccessCatalogSource } from './authorization-catalog.mts';
import { readTopologyCallerAppIds, withOwnerLocalImportSources } from './stage-access-catalog.mts';

/**
 * `authorization:catalog:report` — report-only view of the Authorization v2 access catalog.
 *
 * O62 makes declarations mandatory, so a missing or invalid carrier fails this check (exit 1). The
 * deterministic artifact is written to `.codex/reports/authorization/access-catalog.json` next to the
 * protected-entrypoint inventory first, so the failing run still leaves its evidence behind.
 */

const ACCESS_CATALOG_REPORT_PATH = '.codex/reports/authorization/access-catalog.json';
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.output', 'node_modules']);

class AccessCatalogReportError extends Schema.TaggedError<AccessCatalogReportError>()('AccessCatalogReportError', {
  reason: Schema.String,
}) {}

const reportFailure = (reason: string): AccessCatalogReportError => new AccessCatalogReportError({ reason });

const walk = (directory: string): Effect.Effect<readonly string[], PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* walkEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = yield* fileSystem.exists(directory);
    if (!exists) {
      return [];
    }
    const entries = yield* fileSystem.readDirectory(directory);
    const discovered: (readonly string[])[] = [];
    for (const entry of entries) {
      const skip = SKIPPED_DIRECTORIES.has(entry) || entry.startsWith('dist');
      const content = skip
        ? []
        : yield* Effect.gen(function* walkEntry() {
            const entryPath = path.join(directory, entry);
            const info = yield* fileSystem.stat(entryPath);
            return info.type === 'Directory' ? yield* walk(entryPath) : [entryPath];
          });
      discovered.push(content);
    }
    return discovered.flat();
  });

/** Reads every source that can declare an entrypoint and derives the catalog from it. */
const readCatalogSources = (root: string) =>
  Effect.gen(function* readCatalogSourcesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = [
      ...(yield* walk(path.join(root, 'apps'))),
      ...(yield* walk(path.join(root, 'verticals'))),
      ...(yield* walk(path.join(root, 'packages'))),
    ];
    const sources: AccessCatalogSource[] = [];
    for (const file of files) {
      const relative = path.relative(root, file).replaceAll('\\', '/');
      if (isAccessCatalogContextSourcePath(relative)) {
        const source = yield* fileSystem.readFileString(file, 'utf-8');
        // A declaration's mutation-only importer must remain visible to the custody proof.
        sources.push({ file: relative, source });
      }
    }
    return sources;
  });

export const reportAccessCatalog = (options: {
  readonly json: boolean;
  readonly quiet: boolean;
  /** An explicit workspace root, used by tests and by a caller outside the repository. */
  readonly root?: string;
}) =>
  Effect.gen(function* reportAccessCatalogEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root =
      options.root ??
      (yield* Config.String('ULTRAMODERN_WORKSPACE_ROOT').pipe(
        Config.withDefault(path.resolve(path.join(import.meta.dirname, '..'))),
      ));
    const sources = yield* withOwnerLocalImportSources(root, yield* readCatalogSources(root));
    const callerAppIds = yield* readTopologyCallerAppIds(root).pipe(
      Effect.mapError((error) => reportFailure(error.reason)),
    );
    const report = buildAccessCatalogReport(buildAccessCatalogSnapshot(sources, callerAppIds));
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(AccessCatalogReportSchema, { space: 2 }))(
      report,
    ).pipe(Effect.mapError((issue) => reportFailure(`unable to encode the access catalog report: ${issue.message}`)));
    const reportPath = path.join(root, ACCESS_CATALOG_REPORT_PATH);
    yield* fileSystem
      .makeDirectory(path.dirname(reportPath), { recursive: true })
      .pipe(Effect.mapError((cause) => reportFailure(`unable to create the report directory: ${cause.message}`)));
    yield* fileSystem
      .writeFileString(reportPath, `${encoded}\n`)
      .pipe(Effect.mapError((cause) => reportFailure(`unable to write the access catalog report: ${cause.message}`)));
    const summary = `Authorization v2 access catalog: ${report.totals.declarations} declarations, ${report.totals.missing} missing, ${report.totals.findings} findings, ${report.totals.invalid} invalid (${reportPath}).`;
    const output = options.json ? [encoded] : [renderAccessCatalogReportText(report), `Report artifact: ${reportPath}`];
    yield* Console.log([options.quiet ? summary : output.join('\n\n')].join(''));
    const gaps = accessCatalogGapReason(report);
    if (gaps !== null) {
      // The failing run states the gap on stderr, so a quiet CI log still says what is wrong.
      yield* Console.error(gaps);
      return yield* Effect.fail(reportFailure(gaps));
    }
    return yield* Effect.void;
  });

const command = Command.make(
  'authorization-catalog-report',
  {
    json: Flag.Boolean('json').pipe(Flag.withDefault(false)),
    quiet: Flag.Boolean('quiet').pipe(Flag.withDefault(false)),
    root: Flag.String('root').pipe(Flag.optional),
  },
  ({ json, quiet, root }) => reportAccessCatalog({ json, quiet, root: Option.getOrUndefined(root) }),
);

const [, invokedPath] = process.argv;
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const mainLayer = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(NodeServices.layer),
  );
  NodeRuntime.runMain(Effect.scoped(Layer.build(mainLayer)).pipe(Effect.asVoid));
}
