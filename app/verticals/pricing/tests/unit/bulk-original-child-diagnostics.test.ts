import { describe, expect, it } from 'effect-rstest';

import { Schema } from 'effect';

import {
  BulkOriginalChildDiagnosticReceiptSchema,
  classifyBulkOriginalChildDiagnostics,
} from './support/bulk-original-child-diagnostics.ts';

describe('Bulk original intent child diagnostics', () => {
  it('retains safe SQL metadata from stdout instead of requiring stderr', () => {
    const receipt = classifyBulkOriginalChildDiagnostics({
      command: 'migrate',
      exitCode: 1,
      stderr: '',
      stdout: "code: '42601'\nposition: '9'\n",
    });
    expect(receipt).toMatchObject({ diagnosticCategory: 'SQL_METADATA', position: 9, sqlState: '42601' });
  });
  it('accepts stderr-only metadata and equal repeated metadata without preferring a stream', () => {
    const metadata = '  "sqlState": "42501",\n  position: 12,\n';
    for (const [stdout, stderr] of [
      [metadata, ''],
      ['', metadata],
      [metadata, metadata],
    ] as const) {
      const receipt = classifyBulkOriginalChildDiagnostics({ command: 'migrate', exitCode: 1, stderr, stdout });
      expect(receipt).toMatchObject({ diagnosticCategory: 'PERMISSION_OWNERSHIP', position: 12, sqlState: '42501' });
      expect(Schema.is(BulkOriginalChildDiagnosticReceiptSchema)(receipt)).toBe(true);
    }
  });

  it('keeps conflicting supported metadata and categories ambiguous in either stream order', () => {
    const left = "code: '42601'\nposition: '9'\n";
    const right = "code: '42501'\nposition: '10'\n";
    for (const [stdout, stderr] of [
      [left, right],
      [right, left],
    ] as const) {
      expect(classifyBulkOriginalChildDiagnostics({ command: 'migrate', exitCode: 1, stderr, stdout })).toMatchObject({
        diagnosticCategory: 'AMBIGUOUS',
        position: 'AMBIGUOUS',
        sqlState: 'AMBIGUOUS',
      });
    }
  });

  it('returns only fixed categories for known loader, connection, authentication and ownership messages', () => {
    for (const [message, expected] of [
      ['Error [ERR_MODULE_NOT_FOUND]: Cannot find package synthetic-private-package', 'MODULE_CONFIG_LOADER'],
      ['Error: No config path provided', 'MODULE_CONFIG_LOADER'],
      ['connect ECONNREFUSED synthetic-host:1234', 'CONNECTION'],
      ['password authentication failed for user synthetic-user', 'AUTHENTICATION'],
      ['permission denied for schema synthetic-schema', 'PERMISSION_OWNERSHIP'],
      ['must be owner of function synthetic-function', 'PERMISSION_OWNERSHIP'],
    ] as const) {
      for (const [stdout, stderr] of [
        [message, ''],
        ['', message],
      ] as const) {
        const receipt = classifyBulkOriginalChildDiagnostics({ command: 'verify', exitCode: 1, stderr, stdout });
        expect(receipt).toMatchObject({
          diagnosticCategory: expected,
          observedMigration: 'UNKNOWN',
          sqlState: 'UNKNOWN',
        });
        expect(Schema.is(BulkOriginalChildDiagnosticReceiptSchema)(receipt)).toBe(true);
        expect(JSON.stringify(receipt)).not.toContain('synthetic-');
      }
    }
  });

  it('keeps mixed non-SQL categories ambiguous instead of guessing the first cause', () => {
    for (const [stdout, stderr] of [
      ['ERR_MODULE_NOT_FOUND', 'ECONNREFUSED'],
      ['ECONNREFUSED', 'ERR_MODULE_NOT_FOUND'],
    ] as const) {
      expect(classifyBulkOriginalChildDiagnostics({ command: 'migrate', exitCode: 1, stderr, stdout })).toMatchObject({
        diagnosticCategory: 'AMBIGUOUS',
        observedMigration: 'UNKNOWN',
      });
    }
  });

  it('does not export arbitrary codes, malformed positions, inline query text or folder mentions', () => {
    for (const stdout of [
      "code: 'SECRT'\nposition: '-1'",
      "code: '426010'\nposition: '10000001'",
      "code: '42601-synthetic-secret'\nposition: '1e3'",
      "message: code: '42601'; position: '9'",
      `query: "select code: '42601', position: '9'"`,
      'running /synthetic-secret/20261019165859_bulk_original_owner_intent/migration.sql',
      'No config path provided, using default drizzle.config.ts',
      "'code\": '42601'\nposition: '0'",
    ] as const) {
      const receipt = classifyBulkOriginalChildDiagnostics({ command: 'migrate', exitCode: 1, stderr: '', stdout });
      expect(receipt).toMatchObject({
        diagnosticCategory: 'UNKNOWN',
        observedMigration: 'UNKNOWN',
        position: 'UNKNOWN',
        sqlState: 'UNKNOWN',
      });
      expect(JSON.stringify(receipt)).not.toContain('synthetic-secret');
      expect(JSON.stringify(receipt)).not.toContain('SECRT');
    }
  });

  it('accepts only positive bounded decimal positions', () => {
    for (const [stdout, position] of [
      ["position: '1'", 1],
      ['"position": "10000000"', 10_000_000],
      ['position: 9', 9],
    ] as const) {
      expect(
        classifyBulkOriginalChildDiagnostics({ command: 'migrate', exitCode: 1, stderr: '', stdout }),
      ).toMatchObject({ diagnosticCategory: 'SQL_METADATA', position, sqlState: 'UNKNOWN' });
    }
  });

  it('labels all metadata as unstructured hints and counts original UTF-8 streams exactly', () => {
    const receipt = classifyBulkOriginalChildDiagnostics({ command: 'verify', exitCode: 7, stderr: '猫', stdout: 'é' });
    expect(receipt).toEqual({
      commandStage: 'PRICING_VERIFY',
      diagnosticCategory: 'UNKNOWN',
      exitCode: 7,
      failureClass: 'PRICING_SETUP_CHILD_FAILURE',
      leasedCandidate: '20261019165859_bulk_original_owner_intent',
      metadataInterpretation: 'UNSTRUCTURED_HINT_ONLY',
      observedMigration: 'UNKNOWN',
      position: 'UNKNOWN',
      sqlState: 'UNKNOWN',
      stderrBytes: 3,
      stderrPresent: true,
      stdoutBytes: 2,
      stdoutPresent: true,
    });
    expect(Schema.is(BulkOriginalChildDiagnosticReceiptSchema)(receipt)).toBe(true);
  });

  it('keeps raw secret-bearing unknown messages out of every receipt field', () => {
    const stdout = 'postgres://synthetic-user:synthetic-password@synthetic-host/db SELECT synthetic-secret';
    const stderr = 'parameters: synthetic-token synthetic-cookie';
    const receipt = classifyBulkOriginalChildDiagnostics({ command: 'migrate', exitCode: 1, stderr, stdout });
    expect(receipt).toMatchObject({
      commandStage: 'PRICING_MIGRATE',
      diagnosticCategory: 'UNKNOWN',
      observedMigration: 'UNKNOWN',
    });
    for (const secret of [
      'postgres://',
      'synthetic-user',
      'synthetic-password',
      'synthetic-host',
      'SELECT',
      'synthetic-secret',
      'synthetic-token',
      'synthetic-cookie',
    ] as const) {
      expect(JSON.stringify(receipt)).not.toContain(secret);
    }
  });

  it('reports absent streams without inventing metadata', () => {
    expect(
      classifyBulkOriginalChildDiagnostics({ command: 'migrate', exitCode: 1, stderr: '', stdout: '' }),
    ).toMatchObject({
      diagnosticCategory: 'UNKNOWN',
      observedMigration: 'UNKNOWN',
      position: 'UNKNOWN',
      sqlState: 'UNKNOWN',
      stderrBytes: 0,
      stderrPresent: false,
      stdoutBytes: 0,
      stdoutPresent: false,
    });
  });
});
