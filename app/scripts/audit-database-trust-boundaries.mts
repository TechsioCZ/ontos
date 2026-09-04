#!/usr/bin/env node
/* eslint-disable node/no-process-env -- The audit loads the canonical workspace environment. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { Effect, Exit } from 'effect';
import { loadDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import { collectSnapshot } from './database-trust-audit/collect-snapshot.mts';
import {
  buildDatabaseTrustBoundaryReport,
  DatabaseTrustBoundaryAuditError,
  DatabaseSessionIdentityError,
  DatabaseTargetMismatchError,
  genericAuditFailureMessage,
  getDatabaseTrustBoundaryFailureMessage,
  type DatabaseTrustBoundaryReport,
} from './database-trust-audit/report.mts';

export * from './database-trust-audit/report.mts';
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
            reason: 'Administrative and runtime database configuration is unavailable',
          }),
      ),
    );
    const admin = new Client({ connectionString: connections.admin.connectionString });
    const runtime = new Client({ connectionString: connections.runtime.connectionString });
    return yield* Effect.tryPromise({
      catch: (error) =>
        new DatabaseTrustBoundaryAuditError({
          reason:
            error instanceof DatabaseTargetMismatchError ||
            error instanceof DatabaseSessionIdentityError
              ? error.message
              : 'Database trust-boundary evidence could not be collected',
        }),
      try: async () => {
        let adminConnected = false;
        let runtimeConnected = false;
        try {
          await admin.connect();
          adminConnected = true;
          await runtime.connect();
          runtimeConnected = true;
          return buildDatabaseTrustBoundaryReport(await collectSnapshot(admin, runtime));
        } finally {
          await Promise.allSettled([
            ...(runtimeConnected ? [runtime.end()] : []),
            ...(adminConnected ? [admin.end()] : []),
          ]);
        }
      },
    });
  });

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const workspaceRoot =
    process.env['ULTRAMODERN_WORKSPACE_ROOT'] ?? path.resolve(import.meta.dirname, '..');
  const output = path.join(workspaceRoot, '.codex/reports/database/database-trust-boundary.json');
  try {
    const exit = await Effect.runPromiseExit(auditDatabaseTrustBoundaries());
    if (Exit.isFailure(exit)) {
      console.error(getDatabaseTrustBoundaryFailureMessage(exit.cause));
      process.exitCode = 1;
    } else {
      const report = exit.value;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
      console.log(
        `Database trust-boundary evidence written with ${report.findings.length} finding(s).`,
      );
    }
  } catch (error) {
    console.error(
      error instanceof DatabaseTrustBoundaryAuditError ? error.reason : genericAuditFailureMessage,
    );
    process.exitCode = 1;
  }
}
