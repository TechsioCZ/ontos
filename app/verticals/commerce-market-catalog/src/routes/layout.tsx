import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import type { ReactElement } from 'react';

const Layout = (): ReactElement => (
  <div data-app-id="commerce-market-catalog">
    <Outlet />
  </div>
);

export default Layout;
