import { Outlet } from '@modern-js/plugin-tanstack/runtime';

import './index.css';

const Layout = () => (
  <div data-app-id="sales-insights">
    <Outlet />
  </div>
);

export default Layout;
