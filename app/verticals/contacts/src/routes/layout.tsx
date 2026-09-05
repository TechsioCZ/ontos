import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import { Toaster } from '@techsio/ui-kit/molecules/toast';

import './ui-kit.css';
import './index.css';

const Layout = () => (
  <div data-app-id="contacts">
    <Outlet />
    <Toaster />
  </div>
);

export default Layout;
