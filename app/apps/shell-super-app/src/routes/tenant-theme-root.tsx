import { useMatches } from '@modern-js/plugin-tanstack/runtime';
import { AppThemeProvider } from '@techsio/ui-kit/theme/theme-provider';
import type { ReactNode } from 'react';

import { isThemedPageModel, themeOfPageModel } from './tenant-theme.ts';
import { useLiveTenantTheme } from './use-live-tenant-theme.ts';

/**
 * Renders its subtree inside the signed-in tenant's theme, Business without a session. The brand is controlled: the
 * tenant's attachment decides it, nothing in the browser persists it. The provider alone writes `data-theme` and
 * the mode class on `<html>`.
 */
export const TenantThemeRoot = ({ children }: { readonly children: ReactNode }) => {
  const loaded = useMatches({
    select: (matches) => {
      const pageModel = matches.findLast((match) => isThemedPageModel(match.loaderData))?.loaderData;
      return isThemedPageModel(pageModel) ? themeOfPageModel(pageModel) : undefined;
    },
  });
  const { brand } = useLiveTenantTheme(loaded);
  return (
    <AppThemeProvider brand={brand.key} brands={[brand]}>
      {children}
    </AppThemeProvider>
  );
};
