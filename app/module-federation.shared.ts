/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { sort } from 'effect/Array';
import { mapInput, String as StringOrder } from 'effect/Order';
import { isFailure } from 'effect/Result';
import {
  decodeUnknownResult,
  fromJsonString,
  NonEmptyString,
  optionalKey,
  Record,
  String as StringSchema,
  Struct,
} from 'effect/Schema';

import { UI_KIT_PACKAGE } from './packages/core-runtime/src/modules/shared-packages.ts';

type SharedRuntimeVersions = Readonly<
  Record<
    '@modern-js/plugin-i18n/runtime' | '@modern-js/runtime' | '@tanstack/react-router' | 'react' | 'react-dom',
    string
  >
>;

export { UI_KIT_PACKAGE } from './packages/core-runtime/src/modules/shared-packages.ts';

/** One JavaScript subpath the kit exports and the installed file it resolves to. */
export interface UiKitModule {
  readonly file: string;
  readonly request: string;
}

/** The kit as one installation sees it: its version and every JavaScript subpath it exports. */
export interface UiKitShare {
  readonly modules: readonly UiKitModule[];
  readonly version: string;
}

const UiKitPackageSchema = Struct({
  exports: Record(StringSchema, Struct({ import: optionalKey(StringSchema) })),
  version: NonEmptyString,
});
const decodeUiKitPackage = decodeUnknownResult(fromJsonString(UiKitPackageSchema));

/**
 * Reads the kit installed for the delivery unit at `fromUrl` and lists every JavaScript subpath its exports
 * map publishes, wildcards expanded against the published files. The list comes from the kit itself, so a
 * module built later against the same kit version finds every component it can import already shared.
 */
export const resolveUiKitShare = (fromUrl: string): UiKitShare => {
  const searchPaths = createRequire(fromUrl).resolve.paths(UI_KIT_PACKAGE) ?? [];
  const root = searchPaths
    .map((directory) => path.join(directory, UI_KIT_PACKAGE))
    .find((directory) => existsSync(path.join(directory, 'package.json')));
  if (root === undefined) {
    throw new Error(`${UI_KIT_PACKAGE} is not installed for ${fromUrl}`);
  }
  const decoded = decodeUiKitPackage(readFileSync(path.join(root, 'package.json'), 'utf-8'));
  if (isFailure(decoded)) {
    throw new Error(`${UI_KIT_PACKAGE} at ${root} has no readable version and exports map: ${decoded.failure.message}`);
  }
  const kit = decoded.success;
  const modules = Object.entries(kit.exports).flatMap(([key, { import: target }]) => {
    if (target === undefined) {
      return [];
    }
    if (!key.includes('*')) {
      return [{ file: path.join(root, target), request: `${UI_KIT_PACKAGE}${key.slice(1)}` }];
    }
    const [prefix = '', suffix = ''] = target.split('*');
    const files: readonly string[] = readdirSync(path.join(root, prefix), { encoding: 'utf-8' });
    return files.flatMap((name) => {
      const stem = name.slice(0, name.length - suffix.length);
      return name.endsWith(suffix)
        ? [{ file: path.join(root, prefix, name), request: `${UI_KIT_PACKAGE}${key.slice(1).replace('*', stem)}` }]
        : [];
    });
  });
  return {
    modules: sort(
      modules,
      mapInput(StringOrder, ({ request }: UiKitModule) => request),
    ),
    version: kit.version,
  };
};

const strictSingleton = (requiredVersion: string) => ({
  requiredVersion,
  singleton: true,
  strictVersion: true,
  treeShaking: false,
});

const sharedRuntime = (versions: SharedRuntimeVersions) => ({
  '@modern-js/plugin-i18n/runtime': {
    ...strictSingleton(versions['@modern-js/plugin-i18n/runtime']),
    import: '@modern-js/plugin-i18n/runtime/no-react-i18next',
  },
  '@modern-js/runtime': strictSingleton(versions['@modern-js/runtime']),
  '@tanstack/react-router': strictSingleton(versions['@tanstack/react-router']),
  react: strictSingleton(versions.react),
  'react-dom': strictSingleton(versions['react-dom']),
  'react-dom/client': strictSingleton(versions['react-dom']),
});

/**
 * Both delivery units must use the same singleton sharing policy. The Shell provides every kit subpath; a
 * remote consumes them with no fallback (`import: false`), so it carries no kit code of its own and renders
 * only with the kit, its providers and its stylesheet that the Shell loaded once.
 */
export const createSharedRuntimeConfig = (
  versions: SharedRuntimeVersions,
  delivery:
    | { readonly role: 'host'; readonly uiKit: UiKitShare }
    | { readonly role: 'remote'; readonly uiKit?: UiKitShare },
) => ({
  ...sharedRuntime(versions),
  ...Object.fromEntries(
    (delivery.uiKit?.modules ?? []).map(({ file: kitFile, request }) => [
      request,
      // The Shell imports each subpath by its installed file: an absolute import is provided to the share
      // scope whether or not the Shell's own code uses it, so a module may use any component of the kit.
      delivery.role === 'host'
        ? { ...strictSingleton(delivery.uiKit.version), import: kitFile, version: delivery.uiKit.version }
        : { ...strictSingleton(delivery.uiKit?.version ?? ''), import: false as const },
    ]),
  ),
});

/**
 * Packages every Shell and browser remote shares as strict singletons. Application Composition pins
 * exactly these versions, so the list derives from the one sharing policy above instead of a copy. The kit
 * is one package whose subpaths are shared one by one, all at the kit's version.
 */
export const governedSharedSingletonPackages: readonly string[] = Object.freeze([
  ...Object.keys(
    sharedRuntime({
      '@modern-js/plugin-i18n/runtime': '',
      '@modern-js/runtime': '',
      '@tanstack/react-router': '',
      react: '',
      'react-dom': '',
    }),
  ),
  UI_KIT_PACKAGE,
]);
