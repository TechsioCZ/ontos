import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';

export const Layout = () => (
  <div data-app-id="catalog">
    <Button>ok</Button>
    <Outlet />
  </div>
);
