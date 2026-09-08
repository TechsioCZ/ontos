import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Option } from 'effect';
import { expect, it } from 'effect-rstest';
import { Param } from 'effect/unstable/cli';

const configFilename = 'tsconfig.json';
const metadataFilename = 'metadata.mts';
const compilerRelativePath = 'node_modules/.bin/tsc';
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

const countDiagnostics = (diagnostics: string, pattern: RegExp): number =>
  [...diagnostics.matchAll(pattern)].length;

const verifyDrizzleRuntimeFormats = (fixture: string): void => {
  for (const extension of ['mjs', 'cjs']) {
    const runtimeSource =
      extension === 'mjs'
        ? "import assert from 'node:assert/strict'; import { pgPolicy, pgRole } from 'drizzle-orm/pg-core'; import { cockroachPolicy, cockroachRole } from 'drizzle-orm/cockroach-core';"
        : "const assert = require('node:assert/strict'); const { pgPolicy, pgRole } = require('drizzle-orm/pg-core'); const { cockroachPolicy, cockroachRole } = require('drizzle-orm/cockroach-core');";
    const filename = path.join(fixture, `runtime.${extension}`);
    writeFileSync(
      filename,
      `${runtimeSource}
for (const factory of [pgPolicy, cockroachPolicy]) {
  for (const policy of [factory('absent'), factory('empty', {}), factory('undefined', { as: undefined, for: undefined, to: undefined, using: undefined, withCheck: undefined })]) {
for (const key of ['as', 'for', 'to', 'using', 'withCheck']) assert.equal(policy[key], undefined);
  }
}
for (const factory of [pgRole, cockroachRole]) {
  for (const role of [factory('absent'), factory('empty', {}), factory('undefined', { createDb: undefined, createRole: undefined })]) {
assert.equal(role.createDb, undefined); assert.equal(role.createRole, undefined);
  }
}
assert.equal(pgRole('undefined', { inherit: undefined }).inherit, undefined);
`
    );
    const result = spawnSync(process.execPath, [filename], {
      encoding: 'utf-8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
};

it('published dependency declarations retain strict positive and negative contracts', () => {
  const fixture = mkdtempSync(
    path.join(tmpdir(), 'ontos-declaration-contract-')
  );
  try {
    symlinkSync(
      path.join(workspaceRoot, 'node_modules'),
      path.join(fixture, 'node_modules'),
      'dir'
    );
    const imports = `import { pgPolicy, pgRole, type PgPolicyConfig, type PgRoleConfig } from 'drizzle-orm/pg-core';
import { cockroachPolicy, cockroachRole, type CockroachPolicyConfig, type CockroachRoleConfig } from 'drizzle-orm/cockroach-core';
import { sql } from 'drizzle-orm';\n`;
    const positive = `${imports}
const pg: PgPolicyConfig = pgPolicy('pg', { as: undefined, for: undefined, to: undefined, using: undefined, withCheck: undefined });
const cr: CockroachPolicyConfig = cockroachPolicy('cr', { as: undefined, for: undefined, to: undefined, using: undefined, withCheck: undefined });
const pr: PgRoleConfig = pgRole('pr', { createDb: undefined, createRole: undefined, inherit: undefined });
const rr: CockroachRoleConfig = cockroachRole('rr', { createDb: undefined, createRole: undefined });
pgPolicy('absent'); cockroachPolicy('absent'); pgRole('absent'); cockroachRole('absent');
pgPolicy('empty', {}); cockroachPolicy('empty', {}); pgRole('empty', {}); cockroachRole('empty', {});
pgPolicy('valid', { as: 'permissive', for: 'select', to: pgRole('role'), using: sql\`true\`, withCheck: sql\`true\` });
cockroachPolicy('valid', { as: 'restrictive', for: 'update', to: cockroachRole('role'), using: sql\`true\`, withCheck: sql\`true\` });
pgRole('valid', { createDb: true, createRole: false, inherit: true });
cockroachRole('valid', { createDb: true, createRole: false });
`;
    const negative = `${imports}${['pgPolicy', 'cockroachPolicy']
      .flatMap((factory) => [
        `${factory}('invalid', { as: 'invalid' });`,
        `${factory}('invalid', { for: 'invalid' });`,
        `${factory}('invalid', { to: 42 });`,
        `${factory}('invalid', { using: 'true' });`,
        `${factory}('invalid', { withCheck: false });`,
      ])
      .join('\n')}
pgRole('invalid', { createDb: 'yes' });
pgRole('invalid', { createRole: 1 });
pgRole('invalid', { inherit: null });
cockroachRole('invalid', { createDb: 'yes' });
cockroachRole('invalid', { createRole: 1 });
`;
    for (const extension of ['mts', 'cts']) {
      for (const [name, source, errors] of [
        ['positive', positive, 0],
        ['negative', negative, 15],
      ] as const) {
        const filename = `${name}.${extension}`;
        writeFileSync(path.join(fixture, filename), source);
        writeFileSync(
          path.join(fixture, configFilename),
          JSON.stringify({
            compilerOptions: {
              exactOptionalPropertyTypes: true,
              module: 'NodeNext',
              noEmit: true,
              skipLibCheck: false,
              strict: true,
              target: 'ESNext',
              types: ['node'],
            },
            files: [filename],
          })
        );
        const result = spawnSync(
          path.join(workspaceRoot, compilerRelativePath),
          ['-p', path.join(fixture, configFilename), '--pretty', 'false'],
          { encoding: 'utf-8' }
        );
        expect(result.error).toBeUndefined();
        const diagnostics = result.stdout + result.stderr;
        expect(result.status, diagnostics).toBe(errors === 0 ? 0 : 1);
        expect(
          countDiagnostics(diagnostics, /error TS2322:/gu),
          diagnostics
        ).toBe(errors);
        expect(
          countDiagnostics(diagnostics, /error TS\d+:/gu),
          diagnostics
        ).toBe(errors);
      }
    }
    verifyDrizzleRuntimeFormats(fixture);
    writeFileSync(
      path.join(fixture, metadataFilename),
      `import { Option } from 'effect';
import { Param } from 'effect/unstable/cli';
const metadata = Param.getParamMetadata(Param.string(Param.flagKind, 'name'));
const expected: { readonly isOptional: boolean; readonly isVariadic: boolean; readonly variadicMin: Option.Option<number>; readonly variadicMax: Option.Option<number> } = metadata;
const reverse: typeof metadata = expected;
`
    );
    writeFileSync(
      path.join(fixture, configFilename),
      JSON.stringify({
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          module: 'NodeNext',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ESNext',
          types: ['node'],
        },
        files: [metadataFilename],
      })
    );
    const result = spawnSync(
      path.join(workspaceRoot, compilerRelativePath),
      ['-p', path.join(fixture, configFilename), '--pretty', 'false'],
      { encoding: 'utf-8' }
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    appendFileSync(
      path.join(fixture, metadataFilename),
      `
const wrongOptional: string = metadata.isOptional;
const wrongVariadic: number = metadata.isVariadic;
const wrongMin: Option.Option<string> = metadata.variadicMin;
const wrongMax: Option.Option<string> = metadata.variadicMax;
metadata.isOptional = true;
`
    );
    const invalidMetadata = spawnSync(
      path.join(workspaceRoot, compilerRelativePath),
      ['-p', path.join(fixture, configFilename), '--pretty', 'false'],
      { encoding: 'utf-8' }
    );
    expect(invalidMetadata.error).toBeUndefined();
    const diagnostics = invalidMetadata.stdout + invalidMetadata.stderr;
    expect(invalidMetadata.status, diagnostics).toBe(1);
    expect(countDiagnostics(diagnostics, /error TS2322:/gu), diagnostics).toBe(
      2
    );
    expect(countDiagnostics(diagnostics, /error TS2375:/gu), diagnostics).toBe(
      2
    );
    expect(countDiagnostics(diagnostics, /error TS2540:/gu), diagnostics).toBe(
      1
    );
    expect(countDiagnostics(diagnostics, /error TS\d+:/gu), diagnostics).toBe(
      5
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

it('published runtime exposes real parameter metadata', () => {
  const metadata = Param.getParamMetadata(Param.string(Param.flagKind, 'name'));
  expect(metadata).toEqual({
    isOptional: false,
    isVariadic: false,
    variadicMax: Option.none(),
    variadicMin: Option.none(),
  });
});
