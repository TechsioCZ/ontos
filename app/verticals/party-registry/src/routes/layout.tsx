import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import type { ReactElement } from 'react';

import './index.css';

const Layout = (): ReactElement => (
  <div data-app-id="party-registry">
    <Outlet />
  </div>
);

export default Layout;
