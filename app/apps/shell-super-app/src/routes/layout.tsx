import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import { Toaster } from '@techsio/ui-kit/molecules/toast';
import './index.css';

export default function Layout() {
  return (
    <div data-app-id="shell-super-app">
      <Outlet />
      <Toaster />
    </div>
  );
}
