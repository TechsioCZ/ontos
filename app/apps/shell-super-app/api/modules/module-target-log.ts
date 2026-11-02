import type { InstalledModuleCatalog } from '@app/core-runtime';
import { moduleTargetSources } from '../../shared/module-target-diagnostics.ts';
import { moduleTargetSelectorForLogs } from './shell-composition.ts';
import type { ShellModuleTargetSelector } from './shell-composition.ts';

/** Untrusted source hints are enum-filtered; paths are reduced to an approved route template before logging. */
export const moduleTargetLogAnnotations = (
  catalog: InstalledModuleCatalog,
  input: {
    readonly reportedSource?: string | undefined;
    readonly selector: ShellModuleTargetSelector;
    readonly sourcePath?: string | undefined;
  },
) => {
  const { reportedSource } = input;
  const source = moduleTargetSources.find((value) => value === reportedSource) ?? 'unknown';
  const path = input.sourcePath;
  const canonicalPath =
    path !== undefined && path.startsWith('/') && !path.startsWith('//')
      ? path.split(/[?#]/u)[0]?.replace(/^\/(?:cs|en)(?=\/|$)/u, '')
      : undefined;
  const origin = canonicalPath === undefined ? undefined : moduleTargetSelectorForLogs(catalog, { canonicalPath });
  return {
    ...moduleTargetSelectorForLogs(catalog, input.selector),
    targetSource: source,
    targetSourceModule: origin?.targetModuleKey ?? 'unknown',
    targetSourceRoute: origin?.targetRoute ?? 'unknown',
  };
};
