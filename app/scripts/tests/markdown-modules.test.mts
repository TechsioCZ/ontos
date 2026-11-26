import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync, Visitor } from 'oxc-parser';
import type { Argument, Expression } from 'oxc-parser';

const message = 'Markdown is documentation, never a module; the stage docs lint row depends on it.';
const repository = path.resolve(import.meta.dirname, '../../..');

const literal = (node: Expression | Argument | undefined): string | undefined => {
  if (node?.type === 'Literal' && Predicate.isString(node.value)) {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

const markdownModules = (file: string, source: string) => {
  const modules: string[] = [];
  const add = (value: string | undefined) => {
    if (value !== undefined && /\.mdx?(?:\?.*)?$/u.test(value)) {
      modules.push(value);
    }
  };
  const parsed = parseSync(file, source, { astType: 'ts', sourceType: 'unambiguous' });
  expect(parsed.errors, `${message}\nCannot inspect ${file}`).toEqual([]);
  new Visitor({
    CallExpression: (node) => {
      const { callee } = node;
      if (
        (callee.type === 'Identifier' && callee.name === 'require') ||
        (callee.type === 'MemberExpression' &&
          ((!callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'require') ||
            (callee.computed && literal(callee.property) === 'require')))
      ) {
        add(literal(node.arguments[0]));
      }
    },
    ExportAllDeclaration: (node) => add(node.source.value),
    ExportNamedDeclaration: (node) => add(node.source?.value),
    ImportDeclaration: (node) => add(node.source.value),
    ImportExpression: (node) => add(literal(node.source)),
    TSImportEqualsDeclaration: (node) => {
      if (node.moduleReference.type === 'TSExternalModuleReference') {
        add(node.moduleReference.expression.value);
      }
    },
    TSImportType: (node) => add(node.source.value),
  }).visit(parsed.program);
  return modules;
};

// This fixture is source text, not an import. No tracked source file is exempt from the guard.
const fixture = `
import './side-effect.md';
import {
  value
} from './static.mdx?raw';
export { value } from './named.md';
export * from './star.mdx?url';
const required = require('./required.md?raw');
const dynamic = import(
  './dynamic.mdx'
);
const template = import(\`./template.md?raw\`);
const member = module.require('./member.md');
const computed = module['require']('./computed.mdx');
import equals = require('./equals.md');
type Imported = import('./type.mdx?raw').Value;
`;

it('detects Markdown modules in import, re-export, require and dynamic import syntax, including queries', () => {
  expect(markdownModules('fixture.mts', fixture)).toHaveLength(11);
  expect(markdownModules('fixture.mts', `const fixture = ${JSON.stringify(fixture)};`)).toEqual([]);
});

it('keeps every tracked JavaScript and TypeScript source free of Markdown module imports', () => {
  // git grep selects tracked candidates, including ignored files and every fixture directory.
  // Parse only candidates so multiline imports work without parsing the whole repository.
  const candidates = spawnSync(
    '/usr/bin/git',
    [
      'grep',
      '-l',
      '-z',
      '-F',
      '.md',
      '--',
      ...['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].map((extension) => `*.${extension}`),
    ],
    { cwd: repository, encoding: 'utf-8' },
  );
  expect([0, 1], `${message}\n${candidates.stderr}`).toContain(candidates.status);
  const findings = candidates.stdout
    .split('\0')
    .filter(Boolean)
    .flatMap((file) =>
      markdownModules(file, readFileSync(path.join(repository, file), 'utf-8')).map(
        (specifier) => `${file}: ${specifier}`,
      ),
    );
  expect(findings, message).toEqual([]);
});
