/**
 * effect-native/ui-kit-no-module-stylesheet
 *
 * A module ships no CSS of its own: the kit's stylesheet, loaded once by the host, is the only one, so a module the
 * Shell loads at runtime looks like the rest of OntOS and follows its themes. Reported in module source:
 *
 *   - `stylesheet`: importing, re-exporting or requiring a stylesheet (`./index.css`, `./card.module.css`,
 *     `*.scss`, `*.sass`, `*.less`, `*.styl`, `*.pcss`, also with a query such as `?inline`), or a package
 *     export that resolves to one (`@techsio/ui-kit/tokens-with-tailwind`), including the kit's own stylesheets,
 *     which only the host loads;
 *   - `styleTooling`: importing a CSS build tool that gives the module its own stylesheet or theme
 *     (`tailwindcss`, `@tailwindcss/*`, `@rsbuild/plugin-tailwindcss`, `@rsbuild/plugin-sass`,
 *     `@rsbuild/plugin-less`, `@rsbuild/plugin-stylus`, `postcss`);
 *   - `styleConfig`: a Tailwind or PostCSS configuration file of the module's own.
 *
 * Scope: `verticals/**` and `packages/**` (modules; the Shell hosts the kit stylesheet), tests excluded;
 * `includePaths` overrides it. Report-only: no fixer, no suggestion.
 */
import { createRequire } from 'node:module';

import { defineRule } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';

import { MODULE_SOURCE_PATHS, inUiScope, moduleSources, packageName } from '../shared/ui-kit-scope.ts';

const STYLESHEET = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)(?:\?.*)?$/iu;
const STYLE_TOOLING: ReadonlySet<string> = new Set([
  '@rsbuild/plugin-less',
  '@rsbuild/plugin-sass',
  '@rsbuild/plugin-stylus',
  '@rsbuild/plugin-tailwindcss',
  'postcss',
  'tailwindcss',
]);
const STYLE_CONFIG = /(?:^|\/)(?:tailwind|postcss)\.config\.[cm]?[jt]s$/u;

/** Package exports can name a stylesheet without an extension (`@techsio/ui-kit/tokens-with-tailwind`). */
const resolvesToStylesheet = (filename: string, source: string): boolean => {
  try {
    return STYLESHEET.test(createRequire(filename).resolve(source));
  } catch {
    return false;
  }
};

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow a module stylesheet, CSS build tooling or Tailwind theme of its own.' },
    schema: [{ type: 'object', properties: { includePaths: { type: 'array', items: { type: 'string' } } } }],
    messages: {
      styleConfig: 'A module has no Tailwind or PostCSS configuration of its own: the kit stylesheet styles it.',
      styleTooling: '"{{source}}" builds a stylesheet of the module\'s own: modules ship no CSS, the kit styles them.',
      stylesheet: '"{{source}}" is a stylesheet of the module\'s own: modules ship no CSS, the kit styles them.',
    },
  },
  create(context) {
    if (!inUiScope(context.filename, context.options[0], MODULE_SOURCE_PATHS)) return {};

    const check = (node: ESTree.Node): void => {
      const found = moduleSources(node);
      if (found === null) return;
      const { source } = found;
      const name = packageName(source);
      if (STYLESHEET.test(source) || (name !== null && resolvesToStylesheet(context.filename, source))) {
        context.report({ data: { source }, messageId: 'stylesheet', node: found.node });
        return;
      }
      if (name !== null && (STYLE_TOOLING.has(name) || name.startsWith('@tailwindcss/'))) {
        context.report({ data: { source }, messageId: 'styleTooling', node: found.node });
      }
    };

    return {
      CallExpression: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportDeclaration: check,
      ImportExpression: check,
      Program(node) {
        if (STYLE_CONFIG.test(context.filename.replaceAll('\\', '/'))) {
          context.report({ messageId: 'styleConfig', node });
        }
      },
    };
  },
});
