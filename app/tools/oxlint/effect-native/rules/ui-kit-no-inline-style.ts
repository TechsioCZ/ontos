/**
 * effect-native/ui-kit-no-inline-style
 *
 * Module UI takes every visual value from the kit's components and tokens. A `style` prop writes visual values
 * past the kit, its themes and its tenant overrides, so every `style` attribute is reported, on intrinsic elements
 * and components alike, including a `style` key spread from an object literal (`{...{ style }}`).
 * Scope: `apps/**`, `verticals/**`, `packages/**`, tests excluded; `includePaths` overrides it.
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import { UI_SOURCE_PATHS, inUiScope } from '../shared/ui-kit-scope.ts';

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow inline style props in UI source.' },
    schema: [{ type: 'object', properties: { includePaths: { type: 'array', items: { type: 'string' } } } }],
    messages: {
      inlineStyle: 'An inline style bypasses the kit: use a kit component, prop or token class.',
    },
  },
  create(context) {
    if (!inUiScope(context.filename, context.options[0], UI_SOURCE_PATHS)) return {};
    return {
      JSXAttribute(node) {
        if (node.name.type === 'JSXIdentifier' && node.name.name === 'style') {
          context.report({ messageId: 'inlineStyle', node });
        }
      },
      JSXSpreadAttribute(node) {
        if (node.argument.type !== 'ObjectExpression') return;
        for (const property of node.argument.properties) {
          if (
            property.type === 'Property' &&
            !property.computed &&
            ((property.key.type === 'Identifier' && property.key.name === 'style') ||
              (property.key.type === 'Literal' && property.key.value === 'style'))
          ) {
            context.report({ messageId: 'inlineStyle', node: property });
          }
        }
      },
    };
  },
});
