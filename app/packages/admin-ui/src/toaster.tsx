import { Toaster as UiKitToaster, toaster } from '@techsio/ui-kit/molecules/toast';

import { toasterLabels } from './ui-kit-labels.ts';

/**
 * ui-kit 0.56.0 creates its toast store at `bottom-end`, and its Toaster takes no placement prop. Side panels keep
 * their primary button in that corner, so a confirmation toast covered it while the panel stayed open. zag reads
 * `attrs.placement` and `attrs.offsets` on every render, and the store is per remote (ui-kit is not a federation
 * singleton), so this moves the toasts of every page that mounts this Toaster to the top-right corner, just below
 * the shell top bar.
 */
Object.assign(toaster.attrs, {
  offsets: { bottom: '24px', left: '24px', right: '24px', top: 'calc(var(--spacing-700) + 16px)' },
  placement: 'top-end',
});

/** Mount exactly one per page tree. Czech labels, top-right placement. */
export const Toaster = () => <UiKitToaster {...toasterLabels} />;
