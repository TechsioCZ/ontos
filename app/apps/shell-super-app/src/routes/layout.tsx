import { Helmet } from '@modern-js/runtime/head';
import { Outlet } from '@modern-js/plugin-tanstack/runtime';

import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';

import './ui-kit.css';
import './index.css';

const Layout = () => (
  <>
    <Helmet htmlAttributes={{ className: 'shell:scheme-light!' }} />
    <div data-app-id="shell-super-app" data-build-marker={ultramodernUiMarker.build}>
      <Outlet />
    </div>
  </>
);

export default Layout;
