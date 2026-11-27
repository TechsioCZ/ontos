import { Helmet } from '@modern-js/runtime/head';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import { UiMessagesProvider } from '@techsio/ui-kit/messages/ui-messages-provider';

import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';
import { installBrowserRequestCache } from './browser-request-cache.ts';
import { installStaleBuildRecovery, useStaleBuildErrorRecovery } from './stale-build-recovery.tsx';
import { neutralStaffTheme } from './staff-brand.ts';

import './ui-kit.css';

// Before any remote loads, so every remote's module requests share one cache for this document.
if ('document' in globalThis) {
  installBrowserRequestCache();
  installStaleBuildRecovery();
}

/**
 * Neutral until a signed-in workspace picks its own theme in the dashboard frame (staff-brand.ts).
 * The kit's own words (such as the required-field hint) follow the Shell language, here and in every remote on the page.
 */
const Layout = () => {
  useStaleBuildErrorRecovery();
  const { language, t } = useModernI18n();
  const uiMessages = { label: { required: t('shell.uiKit.requiredLabel') }, locale: language };
  return (
    <>
      <Helmet htmlAttributes={{ className: 'light', 'data-theme': neutralStaffTheme }} />
      <div data-app-id="shell-super-app" data-build-marker={ultramodernUiMarker.build}>
        <UiMessagesProvider messages={uiMessages}>
          <Outlet />
        </UiMessagesProvider>
      </div>
    </>
  );
};

export default Layout;
