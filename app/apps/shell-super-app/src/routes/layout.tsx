import { Helmet } from '@modern-js/runtime/head';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import { UiMessagesProvider } from '@techsio/ui-kit/messages/ui-messages-provider';

import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';

import './ui-kit.css';
import './index.css';

/**
 * The ui-kit draws its components only inside a brand theme; the Shell and every module page run in Business.
 * Its own words (such as the required-field hint) follow the Shell language, here and in every remote on the page.
 */
const Layout = () => {
  const { language, t } = useModernI18n();
  const uiMessages = { label: { required: t('shell.uiKit.requiredLabel') }, locale: language };
  return (
    <div data-app-id="shell-super-app" data-build-marker={ultramodernUiMarker.build}>
      <Helmet htmlAttributes={{ className: 'light', 'data-theme': 'business' }} />
      <UiMessagesProvider messages={uiMessages}>
        <Outlet />
      </UiMessagesProvider>
    </div>
  );
};

export default Layout;
