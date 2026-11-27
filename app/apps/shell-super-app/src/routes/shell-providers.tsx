import { Toaster } from '@techsio/ui-kit/molecules/toast';
import type { ReactNode } from 'react';

/**
 * The kit's document-wide pieces, mounted once by the Shell. The kit is a Shell-provided singleton, so a
 * module's `toaster.create` or `useToast()` reaches this one toast region.
 */
export const ShellProviders = ({ children }: { readonly children: ReactNode }) => (
  <>
    {children}
    <Toaster />
  </>
);
