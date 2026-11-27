import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Outlet, useMatches } from '@modern-js/plugin-tanstack/runtime';
import { UiMessagesProvider } from '@techsio/ui-kit/messages/ui-messages-provider';
import '@techsio/ui-kit/styles.css';
import '@techsio/ui-kit/theme.css';
import { AppThemeProvider } from '@techsio/ui-kit/theme/theme-provider';

import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';
import { ShellProviders } from './shell-providers.tsx';
import { isThemedPageModel, themeOfPageModel } from './tenant-theme.ts';
import { useLiveTenantTheme } from './use-live-tenant-theme.ts';

/**
 * Every Shell page and every module rendered in it runs inside the signed-in tenant's theme, Business without a
 * session. The brand is controlled: the tenant's attachment decides it, nothing in the browser persists it.
 * The kit's own words (such as the required-field hint) follow the Shell language, here and in every remote on the
 * page. The kit's precompiled stylesheet, loaded here once, styles the Shell and every module.
 */
const Layout = () => {
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
          <ShellProviders>
            <Outlet />
          </ShellProviders>
        </UiMessagesProvider>
      </div>
    </AppThemeProvider>
  );
};

export default Layout;
