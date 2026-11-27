/**
 * A subtree with its own form state. A form is made once, at module level; a component that renders it once per
 * instance on the same page (a panel per integration, say) wraps each instance in a `FormScope`, so the instances
 * never share, reset or submit each other's values. The scope's form state ends when it unmounts.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds its element with
 * `createElement`.
 */
import { RegistryProvider } from '@effect/atom-react';
import { createElement } from 'react';
import type { ReactNode } from 'react';

/** The same idle time as the registry module UI reads without a scope. */
const idleTimeToLive = 400;

export const FormScope = ({ children }: { readonly children: ReactNode }) =>
  createElement(RegistryProvider, { defaultIdleTTL: idleTimeToLive }, children);
