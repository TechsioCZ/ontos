import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';

const Layout = () => (
  <div data-app-id="projects" data-build-marker={ultramodernUiMarker.build}>
    <Outlet />
  </div>
);

export default Layout;
