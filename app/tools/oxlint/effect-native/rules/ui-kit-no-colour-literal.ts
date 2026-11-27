/**
 * effect-native/ui-kit-no-colour-literal
 *
 * Every colour in module UI comes from a kit token, so themes and tenants can change it in one place. Reported in
 * string literals and template text:
 *
 *   - `hex`: a CSS hex colour (`#fff`, `#1f2937`, `#00000080`), also inside an arbitrary value (`bg-[#fff]`).
 *     In `.ts` files, where "#123" is usually an issue reference, only a whole hex value or one after `[`, `(`,
 *     `:`, `,` or `=` counts;
 *   - `colourFunction`: a CSS colour function (`rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`,
 *     `oklab()`, `oklch()`, `color-mix()`);
 *   - `paletteClass`: a Tailwind utility on Tailwind's own palette (`text-stone-600`, `bg-white/90`,
 *     `hover:border-red-500`, `catalog:shadow-stone-900/10`), which is outside the kit's token vocabulary.
 *
 * Kit token utilities (`bg-primary`, `text-fg-secondary`), `transparent`, `current` and `inherit` are allowed.
 * Module specifiers are not colour values. Scope: `apps/**`, `verticals/**`, `packages/**`, tests excluded;
 * `includePaths` overrides it. Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';

import { UI_SOURCE_PATHS, inUiScope } from '../shared/ui-kit-scope.ts';

const HEX_DIGITS = '(?:[\\da-f]{8}|[\\da-f]{6}|[\\da-f]{3,4})';
/** Anywhere in JSX source, where text is markup, class lists and props. */
const HEX_ANYWHERE = new RegExp(`(?<![\\w&#/-])#${HEX_DIGITS}(?![\\w-])`, 'iu');
/** In plain TypeScript, where "#123" is usually an issue reference: a whole value, or one in a CSS/class position. */
const HEX_VALUE = new RegExp(`^\\s*#${HEX_DIGITS}\\s*$|(?<=[[(:,=])\\s*#${HEX_DIGITS}(?![\\w-])`, 'iu');
const COLOUR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/iu;

const PALETTE = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'mauve',
  'olive',
  'mist',
  'taupe',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
].join('|');
const COLOUR_UTILITY = [
  'bg',
  'text',
  'border',
  'border-[xytrblse]',
  'outline',
  'ring',
  'ring-offset',
  'inset-ring',
  'divide',
  'fill',
  'stroke',
  'from',
  'via',
  'to',
  'decoration',
  'placeholder',
  'caret',
  'accent',
  'shadow',
  'inset-shadow',
  'drop-shadow',
  'text-shadow',
].join('|');
const PALETTE_CLASS = new RegExp(
  `^(?:${COLOUR_UTILITY})-(?:(?:${PALETTE})-(?:50|[1-9]00|950)|black|white)(?:/[\\w.%()[\\]-]+)?$`,
  'u',
);

/** The utility of one class token, without its variants (`sm:`, `hover:`, `catalog:`) and important marks. */
function utilityOf(token: string): string {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    else if (char === ':' && depth === 0) start = index + 1;
  }
  return token.slice(start).replace(/^!|!$/gu, '').replace(/^-/u, '');
}

const SOURCE_PARENTS: ReadonlySet<string> = new Set([
  'ExportAllDeclaration',
  'ExportNamedDeclaration',
  'ImportDeclaration',
  'ImportExpression',
  'TSExternalModuleReference',
  'TSImportType',
]);

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow colour literals and Tailwind palette classes outside the kit tokens.' },
    schema: [{ type: 'object', properties: { includePaths: { type: 'array', items: { type: 'string' } } } }],
    messages: {
      colourFunction: 'Colour literal "{{value}}" bypasses the kit: use a kit colour token.',
      hex: 'Colour literal "{{value}}" bypasses the kit: use a kit colour token.',
      paletteClass: '"{{value}}" is on Tailwind\'s palette, outside the kit tokens: use a kit colour token class.',
    },
  },
  create(context) {
    if (!inUiScope(context.filename, context.options[0], UI_SOURCE_PATHS)) return {};

    const hexPattern = /\.[cm]?[jt]sx$/u.test(context.filename) ? HEX_ANYWHERE : HEX_VALUE;
    const inspect = (text: string, node: ESTree.Node): void => {
      const hex = hexPattern.exec(text);
      if (hex !== null) {
        context.report({ data: { value: hex[0].trim() }, messageId: 'hex', node });
        return;
      }
      const colourFunction = COLOUR_FUNCTION.exec(text);
      if (colourFunction !== null) {
        context.report({ data: { value: colourFunction[0] }, messageId: 'colourFunction', node });
        return;
      }
      for (const token of text.split(/\s+/u)) {
        if (token !== '' && PALETTE_CLASS.test(utilityOf(token))) {
          context.report({ data: { value: token }, messageId: 'paletteClass', node });
        }
      }
    };

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const parent = (node as ESTree.Node & { parent?: ESTree.Node }).parent;
        if (parent !== undefined && SOURCE_PARENTS.has(parent.type)) return;
        inspect(node.value, node);
      },
      TemplateElement(node) {
        inspect(node.value.cooked ?? node.value.raw, node);
      },
    };
  },
});
