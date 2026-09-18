import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, FileSystem, Path, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestConsole } from 'effect/testing';

import {
  AUTH_NAMESPACE_INVENTORY_EXPORT_STATUS,
  AuthNamespaceInventoryExportDocumentSchema,
  AuthNamespaceInventoryExportError,
  CORE_AUTH_BINDINGS_EXPORT_QUERY,
  encodeAuthNamespaceInventoryExport,
  formatAuthNamespaceInventoryExportFailure,
  makeUnreviewedAuthNamespaceInventory,
  runAuthNamespaceInventoryExportCli,
  writeAuthNamespaceInventoryExport,
} from '../../scripts/export-auth-namespace-inventory.mts';
import type { CoreAuthBindingRow } from '../../scripts/export-auth-namespace-inventory.mts';
import { AuthNamespaceInventoryDocumentSchema } from '../../scripts/prepare-auth-namespace-inventory.mts';

const rows: readonly CoreAuthBindingRow[] = [
  {
    principal_auth_binding_id: '70000000-0000-4000-8000-000000000002',
    principal_id: '40000000-0000-4000-8000-000000000002',
    provider: 'staff-provider',
    provider_subject_id: 'staff-subject-002',
    subject_type: 'user',
    tenant_id: '30000000-0000-4000-8000-000000000002',
  },
  {
    principal_auth_binding_id: '70000000-0000-4000-8000-000000000001',
    principal_id: '40000000-0000-4000-8000-000000000001',
    provider: 'staff-provider',
    provider_subject_id: 'staff-subject-001',
    subject_type: 'user',
    tenant_id: '30000000-0000-4000-8000-000000000001',
  },
];

it.effect('exports deterministic binding tuples with an explicit unreviewed marker', () =>
  Effect.gen(function* exportDocumentEffect() {
    const document = makeUnreviewedAuthNamespaceInventory(rows);
    expect(document.reviewStatus).toBe(AUTH_NAMESPACE_INVENTORY_EXPORT_STATUS);
    expect(document.entries.map(({ principalAuthBindingId }) => principalAuthBindingId)).toEqual([
      rows[1]?.principal_auth_binding_id,
      rows[0]?.principal_auth_binding_id,
    ]);
    expect(document.entries[0]).not.toHaveProperty('authenticationNamespaceId');
    expect(document.entries[0]).not.toHaveProperty('evidenceRef');

    const encoded = yield* encodeAuthNamespaceInventoryExport(document);
    const roundTripped = yield* Schema.decodeEffect(Schema.fromJsonString(AuthNamespaceInventoryExportDocumentSchema))(
      encoded,
    );
    expect(roundTripped).toEqual(document);
    expect(encoded).not.toContain('allstaff');
  }),
);

it.effect('leaves the existing preparation validator fail-closed until review is complete', () =>
  Effect.gen(function* pendingExportEffect() {
    const encoded = yield* encodeAuthNamespaceInventoryExport(makeUnreviewedAuthNamespaceInventory(rows));
    const pending = Schema.decodeResult(Schema.fromJsonString(AuthNamespaceInventoryDocumentSchema))(encoded);
    expect(Result.isFailure(pending)).toBe(true);
  }),
);

it.effect('reports stable CLI failures without exposing retained causes and still fails', () =>
  Effect.gen(function* cliFailureEffect() {
    const marker = 'export-cli-secret-marker';
    const failure = new AuthNamespaceInventoryExportError({
      cause: new Error(marker),
      code: 'database_unavailable',
      reason: 'The Core namespace binding database query failed',
    });
    const typedExit = yield* Effect.exit(runAuthNamespaceInventoryExportCli(Effect.fail(failure)));
    const defectExit = yield* Effect.exit(runAuthNamespaceInventoryExportCli(Effect.die(marker)));
    const errors = yield* TestConsole.errorLines;

    expect(Exit.isFailure(typedExit)).toBe(true);
    expect(Exit.isFailure(defectExit)).toBe(true);
    expect(errors).toEqual([
      'database_unavailable: The Core namespace binding database query failed',
      'auth_namespace_inventory_export_failed: Unexpected exporter failure',
    ]);
    expect(errors.join('\n')).not.toContain(marker);
    expect(formatAuthNamespaceInventoryExportFailure(failure)).not.toContain(marker);
  }),
);

it.layer(NodeServices.layer)('namespace inventory export filesystem', (layeredIt) => {
  layeredIt.effect('writes owner-only output and refuses to replace an existing review artifact', () =>
    Effect.gen(function* writeExportEffect() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectory({ prefix: 'ontos-auth-inventory-export-' });
      yield* Effect.ensuring(
        Effect.gen(function* writeAndCheckEffect() {
          const outputPath = path.join(root, 'nested', 'inventory.json');
          const document = makeUnreviewedAuthNamespaceInventory(rows);
          yield* writeAuthNamespaceInventoryExport({ document, outputPath });

          const source = yield* fileSystem.readFileString(outputPath, 'utf-8');
          const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(AuthNamespaceInventoryExportDocumentSchema))(
            source,
          );
          expect(decoded).toEqual(document);
          const mode = Number.parseInt(((yield* fileSystem.stat(outputPath)).mode % 0o1000).toString(8), 8);
          expect(mode).toBe(0o600);

          const collision = yield* writeAuthNamespaceInventoryExport({ document, outputPath }).pipe(Effect.flip);
          expect(collision.code).toBe('output_exists');
        }),
        fileSystem.remove(root, { force: true, recursive: true }).pipe(Effect.orDie),
      );
    }),
  );
});

it('uses one deterministic read-only query over every Core binding tuple', () => {
  expect(CORE_AUTH_BINDINGS_EXPORT_QUERY).toMatch(/ORDER BY principal_auth_binding_id/u);
  expect(CORE_AUTH_BINDINGS_EXPORT_QUERY).toMatch(/FROM core\.principal_auth_bindings/u);
  expect(CORE_AUTH_BINDINGS_EXPORT_QUERY).not.toMatch(/(?<sqlKeyword>insert|update|delete|create|alter|drop)/iu);
});
