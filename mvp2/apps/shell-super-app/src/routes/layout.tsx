import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import ShellFrame from './shell-frame';
import { UltramodernRouteHead } from './ultramodern-route-head';
import './index.css';

export default function Layout() {
  return (
    <div data-app-id="shell-super-app">
      <ShellFrame>
        <UltramodernRouteHead />
        <Outlet />
      </ShellFrame>
    </div>
  );
}
