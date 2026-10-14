import { Helmet } from '@modern-js/runtime/head';
import { Outlet } from '@modern-js/plugin-tanstack/runtime';

import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';
import { installBrowserRequestCache } from './browser-request-cache.ts';

import './ui-kit.css';
import './index.css';

// Before any remote loads, so every remote's module requests share one cache for this document.
if (__ONTOS_BROWSER_BUILD__ && 'document' in globalThis) {
  installBrowserRequestCache();
}

const Layout = () => (
  <>
    <Helmet htmlAttributes={{ className: 'light', 'data-theme': 'akros' }} />
    <div data-app-id="shell-super-app" data-build-marker={ultramodernUiMarker.build}>
      <Outlet />
    </div>
  </>
);

export default Layout;
