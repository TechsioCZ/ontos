import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import { UiMessagesProvider } from '@techsio/ui-kit/messages/ui-messages-provider';

import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';
import { installBrowserRequestCache } from './browser-request-cache.ts';
import { installStaleBuildRecovery, useStaleBuildErrorRecovery } from './stale-build-recovery.tsx';
import { TenantThemeRoot } from './tenant-theme-root.tsx';

import './ui-kit.css';
import './index.css';

// Before any remote loads, so every remote's module requests share one cache for this document.
if ('document' in globalThis) {
  installBrowserRequestCache();
  installStaleBuildRecovery();
}

/**
 * Every Shell page and every module rendered in it runs inside the signed-in tenant's theme.
 * The kit's own words (such as the required-field hint) follow the Shell language, here and in every remote on the page.
 */
const Layout = () => {
  useStaleBuildErrorRecovery();
  const { language, t } = useModernI18n();
  const uiMessages = { label: { required: t('shell.uiKit.requiredLabel') }, locale: language };
  return (
    <TenantThemeRoot>
      <div data-app-id="shell-super-app" data-build-marker={ultramodernUiMarker.build}>
        <UiMessagesProvider messages={uiMessages}>
          <Outlet />
        </UiMessagesProvider>
      </div>
    </TenantThemeRoot>
  );
};

export default Layout;
