import { Outlet } from '@modern-js/plugin-tanstack/runtime';

import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';

import './ui-kit.css';
import './index.css';

const Layout = () => (
  <div data-app-id="shell-super-app" data-build-marker={ultramodernUiMarker.build}>
    <Outlet />
  </div>
);

export default Layout;
