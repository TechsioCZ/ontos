import { Outlet } from '@modern-js/plugin-tanstack/runtime';

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

/** Every Shell page and every module rendered in it runs inside the signed-in tenant's theme. */
const Layout = () => {
  useStaleBuildErrorRecovery();
  return (
    <TenantThemeRoot>
      <div data-app-id="shell-super-app" data-build-marker={ultramodernUiMarker.build}>
        <Outlet />
      </div>
    </TenantThemeRoot>
  );
};

export default Layout;
