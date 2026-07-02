import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import { AppThemeProvider, BrandThemeScript } from '@techsio/ui-kit/theme/theme-provider';
import './index.css';

export default function Layout() {
  return (
    <div data-app-id="shell-super-app">
      <BrandThemeScript defaultBrand="base" />
      <AppThemeProvider defaultBrand="base" defaultMode="system">
        <Outlet />
      </AppThemeProvider>
    </div>
  );
}
