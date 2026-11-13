import { decodeAccessDeclarationOrThrow, defineSystemModuleEntrypoint } from '@app/core-runtime';
import type { GateCarrier } from '@app/core-runtime/access/enforcement';

/**
 * The tenant-context page dispatch Read's carrier exactly as `api/modules/shell-governed-reads.ts` declares it.
 * Production asks the registered Read's own descriptor (`ShellGovernedReads.tenantModuleTargetCarrier`); a test
 * that has no registration asks the same declaration through this copy.
 */
export const tenantModuleTargetTestCarrier: GateCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'core.shell.tenant-module-target.resolve',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'shell', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'core.shell.tenant-module-target',
      moduleKey: 'core.shell',
      role: 'api',
    }),
  ),
};
