import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Outlet, useMatches } from '@modern-js/plugin-tanstack/runtime';
import { UiMessagesProvider } from '@techsio/ui-kit/messages/ui-messages-provider';
import { AppThemeProvider } from '@techsio/ui-kit/theme/theme-provider';

import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';
import { installBrowserRequestCache } from './browser-request-cache.ts';
import { installStaleBuildRecovery, useStaleBuildErrorRecovery } from './stale-build-recovery.tsx';
import { isThemedPageModel, themeOfPageModel } from './tenant-theme.ts';
import { useLiveTenantTheme } from './use-live-tenant-theme.ts';

import './ui-kit.css';
import './index.css';

// Before any remote loads, so every remote's module requests share one cache for this document.
if ('document' in globalThis) {
  installBrowserRequestCache();
  installStaleBuildRecovery();
}

/**
 * Every Shell page and every module rendered in it runs inside the signed-in tenant's theme, Business without a
 * session. The brand is controlled: the tenant's attachment decides it, nothing in the browser persists it.
 * The kit's own words (such as the required-field hint) follow the Shell language, here and in every remote on the
 * page.
 */
const Layout = () => {
  useStaleBuildErrorRecovery();
  const { language, t } = useModernI18n();
  const uiMessages = { label: { required: t('shell.uiKit.requiredLabel') }, locale: language };
  const loaded = useMatches({
    select: (matches) => {
      const pageModel = matches.findLast((match) => isThemedPageModel(match.loaderData))?.loaderData;
      return isThemedPageModel(pageModel) ? themeOfPageModel(pageModel) : undefined;
    },
  });
  const { brand } = useLiveTenantTheme(loaded);
  return (
    <AppThemeProvider brand={brand.key} brands={[brand]}>
      <div data-app-id="shell-super-app" data-build-marker={ultramodernUiMarker.build}>
        <UiMessagesProvider messages={uiMessages}>
          <Outlet />
        </UiMessagesProvider>
      </div>
    </AppThemeProvider>
  );
};

export default Layout;
