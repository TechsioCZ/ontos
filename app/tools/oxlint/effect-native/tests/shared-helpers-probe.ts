import { defineRule, eslintCompatPlugin } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';
import { Predicate } from 'effect';

import {
  asNode,
  identityUnwrap,
  memberName,
  syntax,
  unwrapNode,
  walk,
} from '../shared/ast.ts';
import type { Syntax } from '../shared/ast.ts';
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
import { provenance } from '../shared/provenance.ts';
import {
  isInErasedTypePosition,
  isInTypePosition,
  isNonReferencePosition,
} from '../shared/reference-positions.ts';
import { snippet } from '../shared/reporting.ts';
import { emittedText, maskText, reportNode } from '../shared/scaffold-text.ts';
import { schemaIdentity } from '../shared/schema-identity.ts';
import { isEntryPosition } from '../shared/script-entry.ts';

type ProbeValue = string | number | boolean | null | readonly ProbeValue[];
type Probe = (
  context: Context,
  program: ESTree.Program
) => readonly ProbeValue[];

const expression = (program: ESTree.Program): ESTree.Expression => {
  const last = program.body.at(-1);
  if (last?.type !== 'ExpressionStatement') {
    throw new Error('Probe requires a final expression');
  }
  return last.expression;
};

/** These probes run inside Oxlint: AST parents, scope bindings, and references are real. */
const probes = new Map<string, Probe>([
  [
    'sequence',
    (_context, program) => {
      const node = expression(program);
      return [unwrapNode(node).type, identityUnwrap(node).type];
    },
  ],
  [
    'await',
    (_context, program) => {
      const node = expression(program);
      return [unwrapNode(node).type, syntax(node)?.type ?? null];
    },
  ],
  [
    'wrappers',
    (_context, program) => {
      const node = expression(program);
      return [
        unwrapNode(node, { wrappers: new Set() }) === node,
        asNode({ type: 'Identifier' }, true) === null,
      ];
    },
  ],
  [
    'members',
    (_context, program) => {
      const node = expression(program);
      return [
        memberName(node),
        memberName(node, { templates: true }),
        memberName(node, { unwrap: {} }),
      ];
    },
  ],
  [
    'imports',
    (_context, program) => {
      const imported = collectDirectMemberImports(program).get('tgen');
      return [
        [...collectRootNamespaces(program)],
        collectRootNamespaces(program, (source) => source === 'effect', {
          valueOnly: true,
        }).size,
        imported?.namespace ?? null,
        imported?.member ?? null,
        collectDirectMemberImports(program, undefined, { valueOnly: true }).has(
          'tgen'
        ),
        collectSchemaLocals(program, collectEffectBindings(program)).schema.has(
          'S'
        ),
      ];
    },
  ],
  [
    'binding',
    (context, program) => [
      bindingPath(context, expression(program)),
      isGenCallee(context, expression(program), ['gen']),
    ],
  ],
  [
    'origin',
    (context, program) => [
      bindingPath(context, expression(program)),
      effectOrigin(context, expression(program), []),
    ],
  ],
  [
    'barrel',
    (context, program) => [
      bindingPath(context, expression(program), ['@app/*']),
      effectOrigin(context, expression(program), ['@app/*']),
    ],
  ],
  [
    'provenance',
    (context, program) => [
      provenance(context, expression(program)),
      bindingPath(context, expression(program)),
    ],
  ],
  [
    'globals',
    (context, program) => {
      const node = expression(program);
      return [
        isUnshadowedGlobal(context, node, 'JSON'),
        isUnshadowedGlobal(context, node, 'JSON', true),
        resolvesToImport(context, node),
        resolvesToImport(context, node, true),
      ];
    },
  ],
  [
    'schema',
    (context, program) => [schemaIdentity(context, expression(program))],
  ],
  [
    'schema-syntax',
    (context, program) => [
      schemaIdentity(context, expression(program)),
      schemaIdentity(context, expression(program), [], 0, {
        templates: true,
        unwrap: {},
      }),
    ],
  ],
  [
    'schema-wrappers',
    (context, program) => {
      const node = expression(program);
      return [
        schemaIdentity(context, node),
        schemaIdentity(context, node, [], 0, {
          unwrap: { wrappers: new Set() },
        }),
        schemaIdentity(context, node, [], 0, { unwrap: { maxDepth: 0 } }),
      ];
    },
  ],
  [
    'template',
    (_context, program) => {
      const node = expression(program);
      if (node.type !== 'TemplateLiteral') {
        throw new Error('Probe requires a template expression');
      }
      const text = '// hi\nconst x = "a";';
      return [
        emittedText(node),
        reportNode(node, 0, 4).type,
        reportNode(node, 0, 12) === node,
        maskText(text).length === text.length,
        maskText('"a"', true),
        snippet('abcdef', 4, 2),
      ];
    },
  ],
  [
    'entry',
    (context, program) => {
      const calls: Syntax[] = [];
      walk(program, context.sourceCode.visitorKeys, (node) => {
        if (
          node.type === 'CallExpression' &&
          node.callee.type === 'MemberExpression'
        ) {
          calls.push(node);
        }
      });
      return calls.map((node) => isEntryPosition(context, node));
    },
  ],
  [
    'references',
    (context, program) => {
      const identifiers: Syntax[] = [];
      walk(program, context.sourceCode.visitorKeys, (node) => {
        if (node.type === 'Identifier') {
          identifiers.push(node);
        }
      });
      const binding = identifiers.find((node) => node.name === 'result');
      if (binding === undefined) {
        throw new Error('Probe requires a result binding');
      }
      const schema = identifiers.filter((node) => node.name === 'Schema');
      return [
        isNonReferencePosition(binding),
        isNonReferencePosition(binding, { variableBindings: true }),
        schema.map((node) => isInErasedTypePosition(node)),
        schema.map((node) =>
          isInTypePosition(node, new Set(['TSAsExpression']))
        ),
      ];
    },
  ],
]);

export default eslintCompatPlugin({
  meta: { name: 'shared-helpers-probe' },
  rules: {
    inspect: defineRule({
      create(context) {
        const [name] = context.options;
        const probe = Predicate.isString(name) ? probes.get(name) : undefined;
        if (probe === undefined) {
          throw new Error('Unknown shared helper probe');
        }
        return {
          'Program:exit'(program) {
            context.report({
              message: JSON.stringify(probe(context, program)),
              node: program,
            });
          },
        };
      },
      meta: { schema: [{ type: 'string' }], type: 'problem' },
    }),
  },
});
