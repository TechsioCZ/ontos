import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleName = 'no-hand-built-problem-details';
const ruleCode = `effect-native(${ruleName})`;
const contract = `import { Schema } from 'effect';
import { HttpApiSchema } from 'effect/http-api';
export const ForbiddenSchema = Schema.TaggedStruct('ForbiddenProblem', {
  detail: Schema.String,
  title: Schema.String,
  type: Schema.String,
  status: Schema.Literal(403),
}).pipe(HttpApiSchema.asJson({ contentType: 'application/problem+json' }), HttpApiSchema.status(403));
`;
const source = `import { ForbiddenSchema } from './contract.ts';
export const denied = ForbiddenSchema.make({
  detail: 'Access denied',
  status: 403,
  title: 'Forbidden',
  type: 'https://example.test/problems/forbidden',
});
`;

it('proves imported declared Problem constructors while retaining mismatched and raw-message controls', () => {
  withTemporaryWorkspace((directory) => {
    const folder = path.join(directory, 'packages/fixture/src');
    mkdirSync(folder, { recursive: true });
    const production = readFileSync(
      path.join(appRoot, 'packages/shared-contracts/src/operation-gateway.ts'),
      'utf-8',
    ).replaceAll(/^.*oxlint-(?:disable|enable) effect-native\/no-hand-built-problem-details.*\n/gmu, '');
    const gateway = readFileSync(path.join(appRoot, 'packages/shared-contracts/src/gateway-context.ts'), 'utf-8');
    const cases = [
      { contract: gateway, count: 0, filename: 'gateway-context.ts', name: 'production', source: production },
      { contract, count: 0, name: 'declared', source },
      { contract, count: 1, name: 'raw-literal', source: source.replace('ForbiddenSchema.make({', '({') },
      { contract, count: 1, name: 'wrong-status', source: source.replace('status: 403', 'status: 401') },
      { contract: contract.replace("'effect'", "'./fake-effect.ts'"), count: 1, name: 'foreign-schema', source },
      {
        contract: contract.replace("'effect/http-api'", "'./fake-http.ts'"),
        count: 1,
        name: 'foreign-annotation',
        source,
      },
      {
        contract: contract.replace('import { Schema }', 'import type { Schema }'),
        count: 1,
        name: 'type-only-schema',
        source,
      },
      {
        contract,
        count: 1,
        name: 'type-only-consumer',
        source: source.replace('import { ForbiddenSchema }', 'import type { ForbiddenSchema }'),
      },
      { contract: '', count: 1, name: 'missing-owner', source },
      {
        contract: contract.replace('export const ForbiddenSchema', 'const ForbiddenSchema'),
        count: 1,
        name: 'missing-export',
        source,
      },
      {
        contract: 'export const ForbiddenSchema = { make: (value) => value };',
        count: 1,
        name: 'forged-maker',
        source,
      },
      {
        contract: contract.replace('HttpApiSchema.status(403)', 'HttpApiSchema.status(401)'),
        count: 1,
        name: 'wrong-annotation',
        source,
      },
      {
        contract: contract.replace('HttpApiSchema.status(403)', 'customTransform()'),
        count: 1,
        name: 'opaque-transform',
        source,
      },
      { contract: `${contract}\nForbiddenSchema.make = fake;`, count: 1, name: 'mutated-owner', source },
      { contract: `${contract}\nconst escaped = ForbiddenSchema;`, count: 1, name: 'aliased-owner', source },
      { contract, count: 1, name: 'mutated-consumer', source: `${source}\nForbiddenSchema.make = fake;` },
      { contract, count: 1, name: 'escaped-consumer', source: `${source}\nopaque(ForbiddenSchema);` },
      { contract, count: 1, name: 'raw-driver-message', source: source.replace("'Access denied'", 'error.message') },
    ];
    const files = cases.map((entry) => {
      const owner = path.join(folder, entry.name);
      mkdirSync(owner);
      writeFileSync(path.join(owner, entry.filename ?? 'contract.ts'), entry.contract);
      const filename = path.join(owner, 'consumer.ts');
      writeFileSync(filename, entry.source);
      return filename;
    });
    const result = runOxlint(fixtureConfigPath(ruleName), files, appRoot);
    expect(result.numberOfFiles).toBe(cases.length);
    expect(result.diagnostics.filter(({ code }) => code !== ruleCode)).toEqual([]);
    for (const [index, entry] of cases.entries()) {
      const diagnostics = result.diagnostics.filter(({ filename }) => path.resolve(appRoot, filename) === files[index]);
      expect(diagnostics, `${entry.name}: ${JSON.stringify(diagnostics)}`).toHaveLength(entry.count);
      if (entry.name === 'raw-driver-message') {
        expect(diagnostics[0]?.message).toContain('raw driver');
      }
    }
  });
});
