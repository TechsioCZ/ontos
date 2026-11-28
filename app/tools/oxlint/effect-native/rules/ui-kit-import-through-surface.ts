/**
 * effect-native/ui-kit-import-through-surface
 *
 * UI source imports UI from one surface. Today that surface is `@techsio/ui-kit`; when the CoreSDK re-exports the
 * kit it becomes the CoreSDK UI entry, and only the `surface` option changes (the kit itself then joins `bypass`).
 *
 * Reported (`bypass`): an import, re-export, dynamic import or `require` of a package on the `bypass` list, which
 * names the component, headless-UI, icon, styling and class-composition libraries that would build UI past the
 * surface. Type-only imports are reported too: a type the surface does not export is a seam past it. The surface
 * itself and every subpath of it are allowed. Package patterns accept a trailing `/*` for a whole scope.
 *
 * Options: `surface` (required package name), `bypass` (package names or `@scope/*`), `includePaths`.
 * Scope: `apps/**`, `verticals/**`, `packages/**`, tests excluded. Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';

import { stringArray, stringOption } from '../shared/options.ts';
import { UI_SOURCE_PATHS, inUiScope, moduleSources, packageName } from '../shared/ui-kit-scope.ts';

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Require UI imports to come through the one UI surface.' },
    schema: [
      {
        type: 'object',
        properties: {
          bypass: { type: 'array', items: { type: 'string' } },
          excludePaths: { type: 'array', items: { type: 'string' } },
          includePaths: { type: 'array', items: { type: 'string' } },
          surface: { type: 'string' },
        },
      },
    ],
    messages: {
      bypass: '"{{source}}" bypasses the UI surface: import UI from {{surface}}, or add what is missing to the kit.',
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as { bypass?: unknown; surface?: unknown };
    const surface = stringOption(options.surface, '', false);
    if (surface === '' || !inUiScope(context.filename, options, UI_SOURCE_PATHS)) return {};
    const bypass = stringArray(options.bypass, []);
    const exact = new Set(bypass.filter((entry) => !entry.endsWith('/*')));
    const scopes = bypass.filter((entry) => entry.endsWith('/*')).map((entry) => entry.slice(0, -1));

    const check = (node: ESTree.Node): void => {
      const found = moduleSources(node);
      if (found === null) return;
      const name = packageName(found.source);
      if (name === null || name === surface || found.source.startsWith(`${surface}/`)) return;
      if (exact.has(name) || scopes.some((scope) => name.startsWith(scope))) {
        context.report({ data: { source: found.source, surface }, messageId: 'bypass', node: found.node });
      }
    };

    return {
      CallExpression: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportDeclaration: check,
      ImportExpression: check,
    };
  },
});
