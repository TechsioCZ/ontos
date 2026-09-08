import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Context, ESTree, Variable } from '@oxlint/plugins';
import { parseSync, visitorKeys } from 'oxc-parser';

import {
  asNode,
  childrenOf,
  identityUnwrap,
  memberName,
  syntax,
  unwrapNode,
  walk,
  type Syntax,
} from '../shared/ast.ts';
import { isUnshadowedGlobal, resolvesToImport } from '../shared/bindings.ts';
import {
  bindingPath,
  effectOrigin,
  isGenCallee,
} from '../shared/effect-identity.ts';
import { collectEffectBindings } from '../shared/effect-imports.ts';
import {
  collectDirectMemberImports,
  collectRootNamespaces,
  collectSchemaLocals,
} from '../shared/imports.ts';
import {
  booleanOption,
  compile,
  compilePatterns,
  positiveInteger,
  safeRegExp,
  stringArray,
  stringList,
} from '../shared/options.ts';
import {
  globToRegExp,
  inScriptScope,
  scopePath,
  scriptScope,
  workspacePath,
} from '../shared/paths.ts';
import { provenance } from '../shared/provenance.ts';
import {
  isInErasedTypePosition,
  isInTypePosition,
  isNonReferencePosition,
} from '../shared/reference-positions.ts';
import { snippet } from '../shared/reporting.ts';
import {
  emittedText,
  maskText,
  reportNode,
  type StringNode,
} from '../shared/scaffold-text.ts';
import { schemaIdentity } from '../shared/schema-identity.ts';
import { isEntryPosition } from '../shared/script-entry.ts';

function parse(source: string): ESTree.Program {
  const parsed = parseSync('helpers.ts', source);
  assert.deepEqual(parsed.errors, []);
  const program = parsed.program as unknown as ESTree.Program;
  walk(program, visitorKeys, (node) => {
    for (const child of childrenOf(node, visitorKeys)) child.parent = node;
  });
  return program;
}
function expression(source: string): ESTree.Node {
  const statement = parse(source).body[0];
  assert.equal(statement?.type, 'ExpressionStatement');
  return (statement as ESTree.ExpressionStatement).expression;
}

/** Explicit single-scope test double, not an attempt to reconstruct the lint engine's scopes. */
function contextFor(program: ESTree.Program): {
  context: Context;
  variables: Map<string, Variable>;
} {
  const variables = new Map<string, Variable>();
  const define = (name: string, definition: unknown) =>
    variables.set(name, {
      defs: [definition],
      references: [],
      identifiers: [],
    } as unknown as Variable);
  for (const declaration of program.body) {
    if (declaration.type === 'ImportDeclaration') {
      for (const specifier of declaration.specifiers)
        define(specifier.local.name, {
          type: 'ImportBinding',
          node: specifier,
          parent: declaration,
        });
    }
    if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        walk(declarator.id, visitorKeys, (node) => {
          if (node.type === 'Identifier')
            define(node.name, {
              type: 'Variable',
              node: declarator,
              parent: declaration,
            });
        });
      }
    }
  }
  const context = {
    sourceCode: {
      ast: program,
      getScope: () => ({ set: variables, upper: null }),
    } as unknown as Context['sourceCode'],
  } as Context;
  return { context, variables };
}
function lastExpression(program: ESTree.Program): ESTree.Node {
  const last = program.body.at(-1);
  assert.equal(last?.type, 'ExpressionStatement');
  return (last as ESTree.ExpressionStatement).expression;
}

test('shared option parsers preserve rejection, sparse arrays and regex flags', () => {
  const fallback = ['default'];
  assert.equal(stringArray(['yes', 1], fallback), fallback);
  assert.equal(stringArray(new Array(2), fallback), fallback);
  assert.equal(stringList(new Array(2), fallback).length, 2);
  assert.equal(booleanOption('false', true), true);
  assert.equal(positiveInteger(0, 3), 3);
  assert.equal(positiveInteger(0, 3, 0), 0);
  assert.equal(compile('[', 'fallback', 'iu').source, 'fallback');
  assert.equal(compile('[', 'fallback', 'iu').flags, 'iu');
  assert.equal(compilePatterns(['[', 'ok']).length, 1);
  assert.equal(safeRegExp('', 'fallback').source, '(?:)');
  assert.equal(compile('', 'fallback').source, 'fallback');
});

test('shared path policies distinguish earliest and latest markers and script scope', () => {
  const fixture =
    '/repo/tools/oxlint/effect-native/tests/fixtures/x/invalid/packages/p/scripts/apps/demo.ts';
  assert.equal(scopePath(fixture), 'packages/p/scripts/apps/demo.ts');
  assert.equal(scriptScope(fixture), 'packages/p/scripts/apps/demo.ts');
  assert.equal(workspacePath(fixture), 'apps/demo.ts');
  assert.equal(inScriptScope(scriptScope(fixture)), true);
  assert.equal(inScriptScope('scripts/a.test.ts'), false);
  assert.equal(
    scriptScope('packages/p/scripts/apps/demo.ts'),
    'packages/p/scripts/apps/demo.ts'
  );
  assert.equal(globToRegExp('**/*.{ts,mts}').test('a.ts'), true);
  assert.equal(globToRegExp('a{').test('a{'), true);
  assert.equal(globToRegExp('x/?*.ts').test('x/a.ts'), true);
});

test('shared unwrapping preserves sequence and await opt-ins and narrow wrapper policy', () => {
  const sequence = expression('(ignored, Effect.gen)');
  assert.equal(unwrapNode(sequence).type, 'SequenceExpression');
  assert.equal(identityUnwrap(sequence).type, 'MemberExpression');
  const awaited = expression('await Effect.gen');
  assert.equal(unwrapNode(awaited).type, 'AwaitExpression');
  assert.equal(syntax(awaited)?.type, 'MemberExpression');
  const wrapped = expression('Effect as unknown');
  assert.equal(unwrapNode(wrapped, { wrappers: new Set() }), wrapped);
  assert.equal(asNode({ type: 'Identifier' }, true), null);
});

test('shared static members distinguish templates and wrapped keys', () => {
  const computed = expression('Effect[`gen`]');
  assert.equal(memberName(computed), null);
  assert.equal(memberName(computed, { templates: true }), 'gen');
  const wrapped = expression('Effect[("gen" as const)]');
  assert.equal(memberName(wrapped), null);
  assert.equal(memberName(wrapped, { unwrap: {} }), 'gen');
  assert.equal(memberName(expression('Effect[method]')), null);
});

test('shared imports preserve aliases and optional type-only filtering', () => {
  const program = parse(
    'import type * as Types from "effect"; import { type gen as tgen, gen as g } from "effect/Effect"; import * as S from "effect/Schema";'
  );
  assert.deepEqual([...collectRootNamespaces(program)], ['Types']);
  assert.equal(
    collectRootNamespaces(program, (source) => source === 'effect', {
      valueOnly: true,
    }).size,
    0
  );
  assert.deepEqual(collectDirectMemberImports(program).get('tgen'), {
    namespace: 'Effect',
    member: 'gen',
  });
  assert.equal(
    collectDirectMemberImports(program, undefined, { valueOnly: true }).has(
      'tgen'
    ),
    false
  );
  const schema = collectSchemaLocals(program, collectEffectBindings(program));
  assert.equal(schema.schema.has('S'), true);
});

test('shared Effect identities preserve const aliases and direct submodule imports', () => {
  const program = parse(
    'import { Effect as E } from "effect"; const { gen: g } = E; g;'
  );
  const { context } = contextFor(program);
  assert.deepEqual(bindingPath(context, lastExpression(program)), [
    'Effect',
    'gen',
  ]);
  assert.equal(isGenCallee(context, lastExpression(program), ['gen']), true);
  const direct = parse('import { gen as g } from "effect/Effect"; g;');
  assert.deepEqual(
    bindingPath(contextFor(direct).context, lastExpression(direct)),
    ['Effect', 'gen']
  );
});

test('shared Effect origin policies preserve glob barrels and default-import differences', () => {
  const program = parse('import E from "effect/Effect"; E.gen;');
  const { context } = contextFor(program);
  assert.equal(bindingPath(context, lastExpression(program)), null);
  assert.deepEqual(effectOrigin(context, lastExpression(program), []), [
    'Effect',
    'gen',
  ]);
  const barrel = parse('import { Effect as E } from "@app/barrel"; E.gen;');
  const b = contextFor(barrel).context;
  assert.equal(bindingPath(b, lastExpression(barrel), ['@app/*']), null);
  assert.deepEqual(effectOrigin(b, lastExpression(barrel), ['@app/*']), [
    'Effect',
    'gen',
  ]);
});

test('shared script provenance accepts unwritten let aliases but rejects later writes', () => {
  const program = parse(
    'import * as p from "node:process"; let { stderr: sink } = p; sink.write;'
  );
  const { context, variables } = contextFor(program);
  assert.equal(
    provenance(context, lastExpression(program)),
    'process.stderr.write'
  );
  assert.equal(bindingPath(context, lastExpression(program)), null);
  const variable = variables.get('sink')!;
  variables.set('sink', {
    ...variable,
    references: [{ init: false, isWrite: () => true }],
  } as unknown as Variable);
  assert.equal(provenance(context, lastExpression(program)), null);
});

test('shared script provenance follows dynamic import, require and ambient containers', () => {
  const program = parse('await import("node:process");');
  assert.equal(
    provenance(contextFor(program).context, lastExpression(program)),
    'process'
  );
  const required = parse('require("node:console").warn;');
  assert.equal(
    provenance(contextFor(required).context, lastExpression(required)),
    'console.warn'
  );
  const global = parse('globalThis.process.stderr.write;');
  assert.equal(
    provenance(contextFor(global).context, lastExpression(global)),
    'process.stderr.write'
  );
});

test('shared global/import resolution retains opt-in type-only policy', () => {
  const program = parse('import type { JSON } from "types"; JSON;');
  const { context } = contextFor(program);
  const node = lastExpression(program);
  assert.equal(isUnshadowedGlobal(context, node, 'JSON'), false);
  assert.equal(isUnshadowedGlobal(context, node, 'JSON', true), true);
  assert.equal(resolvesToImport(context, node), true);
  assert.equal(resolvesToImport(context, node, true), false);
});

test('shared Schema identity follows aliases while rejecting mutable declarations', () => {
  const program = parse(
    'import * as E from "effect"; const S = E.Schema; const { decodeUnknownSync: decode } = S; decode;'
  );
  assert.equal(
    schemaIdentity(contextFor(program).context, lastExpression(program)),
    'decodeUnknownSync'
  );
  const mutable = parse(
    'import { Schema } from "effect"; let S = Schema; S.Json;'
  );
  assert.equal(
    schemaIdentity(contextFor(mutable).context, lastExpression(mutable)),
    null
  );
});

test('shared template text preserves cooked offsets and diagnostic budgets', () => {
  const node = expression('`first ${name} last`') as StringNode;
  assert.equal(emittedText(node), 'first _ last');
  assert.equal(reportNode(node, 0, 4).type, 'TemplateElement');
  assert.equal(reportNode(node, 0, 12), node);
  assert.equal(
    maskText('// hi\nconst x = "a";').length,
    '// hi\nconst x = "a";'.length
  );
  assert.equal(maskText('"a"', true), '   ');
  assert.equal(snippet('abcdef', 4, 2), 'ab…');
});

test('shared entry detection includes module evaluation and top-level IIFEs only', () => {
  const program = parse(
    '(() => { console.warn("x"); })(); function nested() { console.warn("y"); }'
  );
  const context = contextFor(program).context;
  const calls: Syntax[] = [];
  walk(program, visitorKeys, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression'
    )
      calls.push(node);
  });
  assert.equal(isEntryPosition(context, calls[0]!), true);
  assert.equal(isEntryPosition(context, calls[1]!), false);
});

test('shared reference policies preserve declaration keys and TS expression edges', () => {
  const program = parse(
    'const result = Schema as unknown; type Result = typeof Schema;'
  );
  const identifiers: Syntax[] = [];
  walk(program, visitorKeys, (node) => {
    if (node.type === 'Identifier') identifiers.push(node);
  });
  const binding = identifiers.find((node) => node.name === 'result')!;
  assert.equal(isNonReferencePosition(binding), false);
  assert.equal(
    isNonReferencePosition(binding, { variableBindings: true }),
    true
  );
  const schema = identifiers.filter((node) => node.name === 'Schema');
  assert.equal(isInErasedTypePosition(schema[0]!), false);
  assert.equal(isInErasedTypePosition(schema[1]!), true);
  assert.equal(
    isInTypePosition(schema[0]!, new Set(['TSAsExpression'])),
    false
  );
  assert.equal(isInTypePosition(schema[1]!, new Set(['TSAsExpression'])), true);
});

test('Schema identity syntax policy survives aliases without widening default members', () => {
  for (const key of ['`decodeUnknownSync`', '("decodeUnknownSync" as const)']) {
    const program = parse(
      `import { Schema } from "effect"; const S = Schema; const codec = S[${key}]; codec;`
    );
    const { context } = contextFor(program);
    const node = lastExpression(program);
    assert.equal(schemaIdentity(context, node), null);
    assert.equal(
      schemaIdentity(context, node, [], 0, { templates: true, unwrap: {} }),
      'decodeUnknownSync'
    );
  }
});

test('Schema identity preserves rule-specific expression wrapper limits', () => {
  const program = parse(
    'import { Schema } from "effect"; const S = Schema as unknown; S.Json;'
  );
  const { context } = contextFor(program);
  const node = lastExpression(program);
  assert.equal(schemaIdentity(context, node), 'Json');
  assert.equal(
    schemaIdentity(context, node, [], 0, { unwrap: { wrappers: new Set() } }),
    null
  );
  assert.equal(
    schemaIdentity(context, node, [], 0, { unwrap: { maxDepth: 0 } }),
    null
  );
});
