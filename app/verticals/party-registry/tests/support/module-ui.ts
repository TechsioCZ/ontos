import { makeModuleUi } from '@app/admin-ui/testing/module-ui';
import { FederatedI18nBoundary } from '@modern-js/i18n-integration/federation';
import { I18nNavigationProvider } from '@modern-js/plugin-i18n/runtime';
import { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import { RuntimeComponentResolverContext } from '@modern-js/runtime/context';

import runtimeConfig from '../../src/modern.runtime.ts';

/** This module's UI harness: its runtime config and its own instances of the framework's React providers. */
export const { moduleCopy, ModuleRuntime, moduleText, mountInRoute } = makeModuleUi({
  FederatedI18nBoundary,
  I18nNavigationProvider,
  ModernI18nProvider,
  RuntimeComponentResolverContext,
  runtimeConfig,
});
