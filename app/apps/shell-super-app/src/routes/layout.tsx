import { Helmet } from '@modern-js/runtime/head';
import { Outlet } from '@modern-js/plugin-tanstack/runtime';

import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';

import './ui-kit.css';
import './index.css';

/** The ui-kit draws its components only inside a brand theme; the Shell and every module page run in Business. */
const Layout = () => (
  <div data-app-id="shell-super-app" data-build-marker={ultramodernUiMarker.build}>
    <Helmet htmlAttributes={{ className: 'light', 'data-theme': 'business' }} />
    <Outlet />
  </div>
);

export default Layout;
