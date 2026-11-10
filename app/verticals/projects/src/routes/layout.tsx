import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';

import './index.css';

const Layout = () => (
  <div data-app-id="projects" data-build-marker={ultramodernUiMarker.build}>
    <Outlet />
  </div>
);

export default Layout;
