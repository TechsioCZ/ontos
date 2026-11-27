import type { ESTree } from '@oxlint/plugins';

import { stringArray } from './options.ts';
import { includesRuleFile } from './paths.ts';

/**
 * The UI-kit rules judge browser UI source: the Shell, every MicroVertical and every shared package. Tests render
 * fixtures and harness markup, so they are out of scope by default.
 */
export const UI_SOURCE_PATHS: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];

/** Modules are what the Shell loads: MicroVerticals and the packages they build from. The Shell is the kit's host. */
export const MODULE_SOURCE_PATHS: readonly string[] = ['verticals/**', 'packages/**'];

export function inUiScope(filename: string, options: unknown, defaultPaths: readonly string[]): boolean {
  const record = typeof options === 'object' && options !== null ? (options as { includePaths?: unknown }) : {};
  return includesRuleFile(filename, {
    allowPaths: [],
    ignoreTestFiles: true,
    includePaths: stringArray(record.includePaths, defaultPaths),
  });
}

/** Every module specifier a file names: static, re-exported, dynamic and `require` forms. */
export function moduleSources(
  node: ESTree.Node,
): { readonly node: ESTree.Node; readonly source: string; readonly typeOnly: boolean } | null {
  switch (node.type) {
    case 'ImportDeclaration':
      return { node: node.source, source: node.source.value, typeOnly: node.importKind === 'type' };
    case 'ExportAllDeclaration':
      return { node: node.source, source: node.source.value, typeOnly: node.exportKind === 'type' };
    case 'ExportNamedDeclaration':
      return node.source === null
        ? null
        : { node: node.source, source: node.source.value, typeOnly: node.exportKind === 'type' };
    case 'ImportExpression':
      return node.source.type === 'Literal' && typeof node.source.value === 'string'
        ? { node: node.source, source: node.source.value, typeOnly: false }
        : null;
    case 'CallExpression': {
      const [first] = node.arguments;
      return node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        first?.type === 'Literal' &&
        typeof first.value === 'string'
        ? { node: first, source: first.value, typeOnly: false }
        : null;
    }
    default:
      return null;
  }
}

/** The package a bare specifier names (`@scope/name` or `name`); relative and absolute paths name none. */
export function packageName(source: string): string | null {
  if (source.startsWith('.') || source.startsWith('/') || source.includes(':')) return null;
  const parts = source.split('/');
  return source.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? null);
}
