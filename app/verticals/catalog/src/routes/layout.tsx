import { Outlet } from '@modern-js/plugin-tanstack/runtime';

const Layout = () => (
  <div data-app-id="catalog">
    <Outlet />
  </div>
);

export default Layout;
