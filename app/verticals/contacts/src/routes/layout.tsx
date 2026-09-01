import { Outlet } from '@modern-js/plugin-tanstack/runtime';

import './ui-kit.css';
import './index.css';

const Layout = () => (
  <div data-app-id="contacts">
    <Outlet />
  </div>
);

export default Layout;
