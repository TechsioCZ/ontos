#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import {
  Config,
  Console,
  Effect,
  Exit,
  FileSystem,
  Path,
  Schema,
} from 'effect';
import { Client } from 'pg';

import { loadDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import { collectSnapshot } from './database-trust-audit/collect-snapshot.mts';
import {
  buildDatabaseTrustBoundaryReport,
  DatabaseSessionIdentityError,
  DatabaseTargetMismatchError,
  DatabaseTrustBoundaryAuditError,
  genericAuditFailureMessage,
  getDatabaseTrustBoundaryFailureMessage,
} from './database-trust-audit/report.mts';
import type { DatabaseTrustBoundaryReport } from './database-trust-audit/report.mts';

export {
  assertDatabaseSessionIdentities,
  assertSameDatabaseTarget,
  buildDatabaseTrustBoundaryReport,
  DatabaseSessionIdentityError,
  DatabaseTargetMismatchError,
  DatabaseTrustBoundaryAuditError,
  genericAuditFailureMessage,
  getDatabaseTrustBoundaryFailureMessage,
  getEffectiveDatabaseEndpoint,
} from './database-trust-audit/report.mts';
export type {
  DatabaseSessionIdentity,
  DatabaseTargetIdentity,
  DatabaseTrustBoundaryReport,
  DatabaseTrustBoundarySnapshot,
} from './database-trust-audit/report.mts';
export { hasTrustedContextValue } from './database-trust-audit/collect-snapshot.mts';

export const auditDatabaseTrustBoundaries = (): Effect.Effect<
  DatabaseTrustBoundaryReport,
  DatabaseTrustBoundaryAuditError
> =>
  Effect.gen(function* auditDatabaseTrustBoundariesEffect() {
    const connections = yield* loadDatabaseConnectionPair().pipe(
      Effect.mapError(
        () =>
          new DatabaseTrustBoundaryAuditError({
            reason:
              'Administrative and runtime database configuration is unavailable',
          })
      )
    );
    const admin = new Client({
      connectionString: connections.admin.connectionString,
    });
    const runtime = new Client({
      connectionString: connections.runtime.connectionString,
    });
    let adminConnected = false;
    let runtimeConnected = false;
    return yield* Effect.gen(function* collectDatabaseTrustBoundaryReport() {
      yield* Effect.tryPromise({
        catch: () =>
          new DatabaseTrustBoundaryAuditError({
            reason: 'Database trust-boundary evidence could not be collected',
          }),
        try: async () => {
          await admin.connect();
          adminConnected = true;
          await runtime.connect();
          runtimeConnected = true;
        },
      });
      const snapshot = yield* collectSnapshot(admin, runtime).pipe(
        Effect.mapError(
          (error) =>
            new DatabaseTrustBoundaryAuditError({
              reason:
                Schema.is(DatabaseTargetMismatchError)(error) ||
                Schema.is(DatabaseSessionIdentityError)(error)
                  ? error.message
                  : 'Database trust-boundary evidence could not be collected',
            })
        )
      );
      return buildDatabaseTrustBoundaryReport(snapshot);
    }).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          await Promise.allSettled([
            ...(runtimeConnected ? [runtime.end()] : []),
            ...(adminConnected ? [admin.end()] : []),
          ]);
        })
      )
    );
  });

const DatabaseTrustBoundaryReportJsonSchema = Schema.fromJsonString(
  Schema.Unknown,
  { space: 2 }
);

const writeDatabaseTrustBoundaryReport = Effect.gen(
  function* writeDatabaseTrustBoundaryReportEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const defaultWorkspaceRoot = path.resolve(import.meta.dirname, '..');
    const workspaceRoot = yield* Config.string(
      'ULTRAMODERN_WORKSPACE_ROOT'
    ).pipe(
      Config.withDefault(defaultWorkspaceRoot),
      Effect.mapError(
        () =>
          new DatabaseTrustBoundaryAuditError({
            reason: genericAuditFailureMessage,
          })
      )
    );
    const output = path.join(
      workspaceRoot,
      '.codex/reports/database/database-trust-boundary.json'
    );
    const report = yield* auditDatabaseTrustBoundaries();
    const reportJson = yield* Schema.encodeEffect(
      DatabaseTrustBoundaryReportJsonSchema
    )(report).pipe(
      Effect.mapError(
        () =>
          new DatabaseTrustBoundaryAuditError({
            reason: genericAuditFailureMessage,
          })
      )
    );
    yield* fileSystem
      .makeDirectory(path.dirname(output), { recursive: true })
      .pipe(
        Effect.mapError(
          () =>
            new DatabaseTrustBoundaryAuditError({
              reason: genericAuditFailureMessage,
            })
        )
      );
    yield* fileSystem.writeFileString(output, `${reportJson}\n`).pipe(
      Effect.mapError(
        () =>
          new DatabaseTrustBoundaryAuditError({
            reason: genericAuditFailureMessage,
          })
      )
    );
    yield* Console.log(
      `Database trust-boundary evidence written with ${report.findings.length} finding(s).`
    );
  }
).pipe(
  Effect.tapCause((cause) =>
    Console.error(getDatabaseTrustBoundaryFailureMessage(cause))
  )
);

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const exit = await Effect.runPromiseExit(
    writeDatabaseTrustBoundaryReport.pipe(Effect.provide(NodeServices.layer))
  );
  process.exitCode = Exit.match(exit, {
    onFailure: () => 1,
    onSuccess: () => 0,
  });
}
