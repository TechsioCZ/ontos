#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, Effect, Exit, FileSystem, Path, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';

import { loadDatabaseIdentityConnections } from '../packages/core-runtime/src/db/config.ts';
import { DATABASE_IDENTITIES } from '../packages/core-runtime/src/db/database-identities.ts';
import {
  collectGlobalSnapshot,
  collectSnapshot,
  readDatabaseTarget,
} from './database-trust-audit/collect-snapshot.mts';
import {
  assertDatabaseSessionIdentities,
  assertSameDatabaseTarget,
  buildDatabaseTrustBoundaryReport,
  DatabaseTrustBoundaryAuditError,
  databaseTrustBoundaryExitCode,
  genericAuditFailureMessage,
  getDatabaseTrustBoundaryFailureMessage,
  getEffectiveDatabaseEndpoint,
} from './database-trust-audit/report.mts';
import type {
  DatabaseIdentitySnapshot,
  DatabaseSessionIdentityError,
  DatabaseTargetMismatchError,
  DatabaseTrustBoundaryReport,
} from './database-trust-audit/report.mts';
import { DATABASE_ROLE_GRANT_MANIFEST, TRUST_ROUTINES } from './postgres/database-role-manifest.mts';

export {
  assertDatabaseSessionIdentities,
  assertSameDatabaseTarget,
  buildDatabaseTrustBoundaryReport,
  canonicalRoutineSignature,
  DatabaseSessionIdentityError,
  DatabaseTargetMismatchError,
  DatabaseTrustBoundaryAuditError,
  databaseTrustBoundaryExitCode,
  findAcceptance,
  genericAuditFailureMessage,
  getDatabaseTrustBoundaryFailureMessage,
  getEffectiveDatabaseEndpoint,
} from './database-trust-audit/report.mts';
export type {
  DatabaseIdentitySnapshot,
  DatabaseIdentityTrustReport,
  DatabaseSessionIdentity,
  DatabaseTargetIdentity,
  DatabaseTrustBoundaryInput,
  DatabaseTrustBoundaryReport,
  DatabaseTrustBoundarySnapshot,
  GlobalTrustSnapshot,
} from './database-trust-audit/report.mts';
export { hasTrustedContextValue } from './database-trust-audit/collect-snapshot.mts';

const collectionFailureReason = 'Database trust-boundary evidence could not be collected';

const collectionFailure = (): DatabaseTrustBoundaryAuditError =>
  new DatabaseTrustBoundaryAuditError({ reason: collectionFailureReason });

/** Target and session mismatches keep their message; it names only URL keys, never values. */
const toAuditError = ({
  message,
}: DatabaseSessionIdentityError | DatabaseTargetMismatchError): DatabaseTrustBoundaryAuditError =>
  new DatabaseTrustBoundaryAuditError({ reason: message });

export const auditDatabaseTrustBoundaries = (): Effect.Effect<
  DatabaseTrustBoundaryReport,
  DatabaseTrustBoundaryAuditError,
  Reactivity.Reactivity
> =>
  Effect.gen(function* auditDatabaseTrustBoundariesEffect() {
    const connections = yield* loadDatabaseIdentityConnections().pipe(
      Effect.mapError(
        () =>
          new DatabaseTrustBoundaryAuditError({
            reason: 'Administrative and runtime identity database configuration is unavailable',
          }),
      ),
    );
    const adminUrl = Redacted.make(connections.admin.connectionString);
    const adminEndpoint = yield* Effect.fromResult(getEffectiveDatabaseEndpoint(adminUrl));
    const admin = yield* PgClient.makeClient({ url: adminUrl }).pipe(Effect.mapError(collectionFailure));
    const adminTarget = yield* readDatabaseTarget(admin).pipe(Effect.mapError(collectionFailure));

    const runtimes = yield* Effect.forEach(
      DATABASE_IDENTITIES,
      (identity) =>
        Effect.gen(function* openIdentityConnection() {
          const url = Redacted.make(connections.runtime[identity.id].connectionString);
          const endpoint = yield* Effect.fromResult(getEffectiveDatabaseEndpoint(url));
          // makeClient holds one connection, which the BEGIN / SET / COMMIT trusted-context probes rely on.
          const client = yield* PgClient.makeClient({ url }).pipe(Effect.mapError(collectionFailure));
          const target = yield* readDatabaseTarget(client).pipe(Effect.mapError(collectionFailure));
          yield* Effect.fromResult(
            assertSameDatabaseTarget({ ...adminEndpoint, ...adminTarget }, { ...endpoint, ...target }, identity.urlKey),
          ).pipe(Effect.mapError(toAuditError));
          return { client, identity, target };
        }),
      { concurrency: 1 },
    );
    yield* Effect.fromResult(
      assertDatabaseSessionIdentities([adminTarget, ...runtimes.map(({ target }) => target)]),
    ).pipe(Effect.mapError(toAuditError));

    const identities: DatabaseIdentitySnapshot[] = yield* Effect.forEach(
      runtimes,
      ({ client, identity, target }) =>
        collectSnapshot(admin, client, {
          administrativeRole: adminTarget.sessionRole,
          runtimeRole: target.sessionRole,
        }).pipe(
          Effect.map((snapshot) => ({ identityId: identity.id, scopeAuthority: identity.scopeAuthority, snapshot })),
        ),
      { concurrency: 1 },
    ).pipe(Effect.mapError(collectionFailure));
    const global = yield* collectGlobalSnapshot(
      admin,
      runtimes.map(({ target }) => target.sessionRole),
    ).pipe(Effect.mapError(collectionFailure));

    return buildDatabaseTrustBoundaryReport(
      { administrativeRole: adminTarget.sessionRole, database: adminTarget.database, global, identities },
      DATABASE_ROLE_GRANT_MANIFEST,
      TRUST_ROUTINES,
    );
  }).pipe(Effect.scoped);

const DatabaseTrustBoundaryReportJsonSchema = Schema.fromJsonString(Schema.Unknown, { space: 2 });

const writeFailure = (): DatabaseTrustBoundaryAuditError =>
  new DatabaseTrustBoundaryAuditError({ reason: genericAuditFailureMessage });

const describeIdentity = ({
  identityId,
  summary,
  unacceptedFindings,
}: DatabaseTrustBoundaryReport['identities'][number]): string => {
  const codes = unacceptedFindings.map(({ code }) => code).join(', ');
  const codeSuffix = codes === '' ? '' : ` (${codes})`;
  return `  ${identityId}: ${summary.findingCount} finding(s), ${summary.acceptedFindingCount} accepted, ${summary.unacceptedFindingCount} unaccepted${codeSuffix}`;
};

const writeDatabaseTrustBoundaryReport = Effect.gen(function* writeDatabaseTrustBoundaryReportEffect() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const defaultWorkspaceRoot = path.resolve(import.meta.dirname, '..');
  const workspaceRoot = yield* Config.String('ULTRAMODERN_WORKSPACE_ROOT').pipe(
    Config.withDefault(defaultWorkspaceRoot),
    Effect.mapError(writeFailure),
  );
  const output = path.join(workspaceRoot, '.codex/reports/database/database-trust-boundary.json');
  const report = yield* auditDatabaseTrustBoundaries();
  const reportJson = yield* Schema.encodeEffect(DatabaseTrustBoundaryReportJsonSchema)(report).pipe(
    Effect.mapError(writeFailure),
  );
  yield* fileSystem.makeDirectory(path.dirname(output), { recursive: true }).pipe(Effect.mapError(writeFailure));
  yield* fileSystem.writeFileString(output, `${reportJson}\n`).pipe(Effect.mapError(writeFailure));
  const globalCodes = report.globalFindings.map(({ code }) => code).join(', ');
  yield* Console.log(
    [
      `Database trust-boundary evidence written for ${report.identities.length} identities with ${report.unacceptedFindingCount} unaccepted and ${report.globalFindings.length} global finding(s).`,
      ...report.identities.map(describeIdentity),
      ...(globalCodes === '' ? [] : [`  global: ${globalCodes}`]),
    ].join('\n'),
  );
  return databaseTrustBoundaryExitCode(report);
}).pipe(Effect.tapCause((cause) => Console.error(getDatabaseTrustBoundaryFailureMessage(cause))));

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const exit = await Effect.runPromiseExit(
    writeDatabaseTrustBoundaryReport.pipe(Effect.provide(NodeServices.layer), Effect.provide(Reactivity.layer)),
  );
  process.exitCode = Exit.match(exit, {
    onFailure: () => 1,
    onSuccess: (code) => code,
  });
}
