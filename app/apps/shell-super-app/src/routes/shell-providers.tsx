import { ToastProvider } from '@techsio/ui-kit/molecules/toast';
import type { ReactNode } from 'react';

/**
 * The kit providers of the one Shell document. The kit is a Shell-provided singleton, so a module page
 * rendered inside them reads the same contexts: its `useToast()` reaches the Shell's toast region.
 */
export const ShellProviders = ({ children }: { readonly children: ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);
