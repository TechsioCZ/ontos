import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'effect-rstest';
import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleName = 'no-hand-built-problem-details';
const ruleCode = `effect-native(${ruleName})`;
const factorySource = `import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
export const ConflictSchema = makeProblemDetailsSchema('FixtureConflictProblem', 422, {
  code: Schema.Literal('fixture_conflict'),
});
export const problem = ConflictSchema.make({
  code: 'fixture_conflict',
  detail: 'The operation is ineligible.',
  status: 422,
  title: 'Conflict',
  type: 'urn:ontos:fixture:conflict',
});
`;

it('proves actual shared factory schemas without exempting raw literals, mismatches, mutation or driver text', () => {
  withTemporaryWorkspace((directory) => {
    const folder = path.join(directory, 'packages/fixture/src');
    mkdirSync(folder, { recursive: true });
    const ordinaryCases = [
      { count: 0, name: 'declared-422', source: factorySource },
      { count: 0, name: 'declared-503', source: factorySource.replaceAll('422', '503') },
      {
        count: 0,
        name: 'aliased-value-import',
        source: factorySource
          .replace('import { makeProblemDetailsSchema }', 'import { makeProblemDetailsSchema as makeProblem }')
          .replace('= makeProblemDetailsSchema(', '= makeProblem('),
      },
      { count: 1, name: 'raw-object', source: factorySource.replace('ConflictSchema.make({', '({') },
      { count: 1, name: 'wrong-status', source: factorySource.replace('status: 422', 'status: 409') },
      {
        count: 1,
        name: 'foreign-factory',
        source: factorySource.replace('@app/shared-contracts/problem-details', './counterfeit.ts'),
      },
      {
        count: 1,
        name: 'type-only-factory',
        source: factorySource.replace(
          'import { makeProblemDetailsSchema }',
          'import type { makeProblemDetailsSchema }',
        ),
      },
      {
        count: 1,
        name: 'dynamic-status',
        source: factorySource.replace("'FixtureConflictProblem', 422", "'FixtureConflictProblem', configuredStatus"),
      },
      { count: 1, name: 'wrong-tag', source: factorySource.replace("'FixtureConflictProblem'", "'FixtureConflict'") },
      {
        count: 1,
        name: 'unapproved-factory',
        source: factorySource.replaceAll('makeProblemDetailsSchema', 'makeFakeProblemSchema'),
      },
      { count: 1, name: 'mutated-schema', source: `${factorySource}\nConflictSchema.make = fake;\n` },
      { count: 1, name: 'escaped-schema', source: `${factorySource}\nopaque(ConflictSchema);\n` },
      { count: 1, name: 'mutated-factory', source: `${factorySource}\nmakeProblemDetailsSchema = fake;\n` },
      { count: 1, name: 'aliased-factory', source: `${factorySource}\nconst escaped = makeProblemDetailsSchema;\n` },
      {
        count: 1,
        name: 'raw-driver',
        source: factorySource.replace("'The operation is ineligible.'", 'error.message'),
      },
    ];
    const cases = [
      ...ordinaryCases,
      ...ordinaryCases.map((entry) => ({
        ...entry,
        name: `retryable-${entry.name}`,
        source: entry.source
          .replaceAll('makeProblemDetailsSchema', 'makeRetryableProblemDetailsSchema')
          .replaceAll('422', '503'),
      })),
      ...[
        { module: 'workforce-action-problems', owner: 'workforce' },
        { module: 'merchandise-action-problems', owner: 'merchandise' },
        { module: 'facility-action-problems', owner: 'facility-operations' },
        { module: 'sales-pipeline-action-problems', owner: 'sales-pipeline' },
        { module: 'finance-action-problems', owner: 'finance-billing' },
      ].map(({ module, owner }) => ({
        count: 0,
        name: `actual-${owner}`,
        source: readFileSync(path.join(appRoot, 'verticals', owner, 'shared', `${module}.ts`), 'utf-8'),
      })),
    ];
    const files = cases.map(({ name, source }) => {
      const filename = path.join(folder, `${name}.ts`);
      writeFileSync(filename, source);
      return filename;
    });
    const result = runOxlint(fixtureConfigPath(ruleName), files, appRoot);
    expect(result.numberOfFiles).toBe(cases.length);
    expect(result.diagnostics.filter(({ code }) => code !== ruleCode)).toEqual([]);
    for (const [index, entry] of cases.entries()) {
      const diagnostics = result.diagnostics.filter(({ filename }) => path.resolve(appRoot, filename) === files[index]);
      expect(diagnostics, `${entry.name}: ${JSON.stringify(diagnostics)}`).toHaveLength(entry.count);
      if (entry.name === 'raw-driver') {
        expect(diagnostics[0]?.message).toContain('raw driver');
      }
    }
  });
});
