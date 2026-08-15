import { Outlet } from '@modern-js/plugin-tanstack/runtime';

import './ui-kit.css';
import './index.css';

export default function Layout() {
  return (
    <div data-app-id="crm">
      <Outlet />
    </div>
  );
}
