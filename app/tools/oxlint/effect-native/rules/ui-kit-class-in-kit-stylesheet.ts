/**
 * effect-native/ui-kit-class-in-kit-stylesheet
 *
 * A module ships no CSS: the kit's precompiled stylesheet, loaded once by the host, is the only one. A class name a
 * module writes therefore styles nothing unless that stylesheet has a rule for it, and a class that is not there is
 * off the system (a palette colour, an arbitrary value, a prefix of the module's own Tailwind build).
 *
 * Reported (`unknownClass`): a static class token in a `className` (or `class`) attribute, in string literals and
 * template text anywhere inside its expression (ternaries, arrays, helper calls), that the kit stylesheet does not
 * define. Tokens next to a template substitution are partial and skipped. `group`, `peer` and their named forms
 * (`group/row`) are markers without rules of their own and are allowed.
 * Reported (`noStylesheet`, once per file): the `stylesheet` option does not resolve from the file, so the
 * module does not depend on the kit whose classes it writes.
 *
 * The Shell runs no Tailwind of its own either, so the same holds for it.
 *
 * Options: `stylesheet` (module specifier, resolved from the linted file), `includePaths`. Scope: `apps/**`,
 * `verticals/**` and `packages/**`, tests excluded. Report-only: no fixer, no suggestion.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { defineRule } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';

import { stringOption } from '../shared/options.ts';
import { UI_SOURCE_PATHS, inUiScope } from '../shared/ui-kit-scope.ts';

const vocabularies = new Map<string, ReadonlySet<string>>();

const unescapeClass = (escaped: string): string =>
  escaped.replace(/\\(?:([\da-f]{1,6}) ?|(.))/giu, (_match, hex: string | undefined, char: string | undefined) =>
    hex === undefined ? (char ?? '') : String.fromCodePoint(Number.parseInt(hex, 16)),
  );

/** Every class selector of a stylesheet. Only rule preludes (the text before each `{`) are read, never values. */
function vocabularyOf(path: string): ReadonlySet<string> {
  const cached = vocabularies.get(path);
  if (cached !== undefined) return cached;
  const css = readFileSync(path, 'utf-8').replace(/\/\*[\s\S]*?\*\//gu, '');
  const preludes: string[] = [];
  let start = 0;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '{') {
      const prelude = css.slice(start, index).trim();
      if (!prelude.startsWith('@')) preludes.push(prelude);
      start = index + 1;
    } else if (char === '}' || char === ';') {
      start = index + 1;
    }
  }
  const classes = new Set<string>();
  for (const match of preludes.join(',').matchAll(/\.((?:\\[\da-f]{1,6} ?|\\[^\da-f\s]|[\w-])+)/giu)) {
    if (match[1] !== undefined) classes.add(unescapeClass(match[1]));
  }
  vocabularies.set(path, classes);
  return classes;
}

const MARKER = /^(?:group|peer)(?:\/[\w-]+)?$/u;

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Require every class a module writes to be defined by the kit stylesheet.' },
    schema: [
      {
        type: 'object',
        properties: {
          includePaths: { type: 'array', items: { type: 'string' } },
          stylesheet: { type: 'string' },
        },
      },
    ],
    messages: {
      noStylesheet:
        '{{stylesheet}} does not resolve from this module: a module that writes kit classes depends on the kit.',
      unknownClass:
        '"{{value}}" is not in the kit stylesheet, so nothing styles it: use a kit component or a class the kit defines, or add what is missing to the kit.',
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as { stylesheet?: unknown };
    const stylesheet = stringOption(options.stylesheet, '', false);
    if (stylesheet === '' || !inUiScope(context.filename, options, UI_SOURCE_PATHS)) return {};

    let vocabulary: ReadonlySet<string> | null | undefined;
    const load = (): ReadonlySet<string> | null => {
      if (vocabulary === undefined) {
        try {
          vocabulary = vocabularyOf(createRequire(context.filename).resolve(stylesheet));
        } catch {
          vocabulary = null;
        }
      }
      return vocabulary;
    };
    let reportedMissing = false;

    const checkTokens = (text: string, node: ESTree.Node, partialStart: boolean, partialEnd: boolean): void => {
      const known = load();
      if (known === null) {
        if (!reportedMissing) context.report({ data: { stylesheet }, messageId: 'noStylesheet', node });
        reportedMissing = true;
        return;
      }
      const tokens = text.split(/\s+/u);
      tokens.forEach((token, index) => {
        if (token === '' || MARKER.test(token) || known.has(token)) return;
        if (
          (index === 0 && partialStart && !/^\s/u.test(text)) ||
          (index === tokens.length - 1 && partialEnd && !/\s$/u.test(text))
        ) {
          return;
        }
        context.report({ data: { value: token }, messageId: 'unknownClass', node });
      });
    };

    const visit = (node: ESTree.Node | null | undefined): void => {
      if (node === null || node === undefined) return;
      switch (node.type) {
        case 'Literal':
          if (typeof node.value === 'string') checkTokens(node.value, node, false, false);
          return;
        case 'TemplateLiteral':
          node.quasis.forEach((quasi, index) => {
            checkTokens(quasi.value.cooked ?? quasi.value.raw, quasi, index > 0, index < node.quasis.length - 1);
          });
          for (const expression of node.expressions) visit(expression);
          return;
        case 'ConditionalExpression':
          visit(node.consequent);
          visit(node.alternate);
          return;
        case 'LogicalExpression':
          visit(node.left);
          visit(node.right);
          return;
        case 'ArrayExpression':
          for (const element of node.elements) if (element !== null && element.type !== 'SpreadElement') visit(element);
          return;
        case 'CallExpression':
          for (const argument of node.arguments) if (argument.type !== 'SpreadElement') visit(argument);
          return;
        case 'JSXExpressionContainer':
          if (node.expression.type !== 'JSXEmptyExpression') visit(node.expression);
          return;
        case 'ParenthesizedExpression':
        case 'TSAsExpression':
        case 'TSSatisfiesExpression':
          visit(node.expression);
          return;
        default:
          return;
      }
    };

    return {
      JSXAttribute(node) {
        if (node.name.type === 'JSXIdentifier' && (node.name.name === 'className' || node.name.name === 'class')) {
          visit(node.value);
        }
      },
    };
  },
});
