import { Function as EffectFunction } from 'effect';
import { useSyncExternalStore } from 'react';

// Hydration never changes after commit, so the store has nothing to notify.
const subscribe = () => EffectFunction.constVoid;

/**
 * False on the server and during hydration, true once this tree has committed on the client. Browser tests
 * read it as `data-hydrated` instead of probing a renderer's private DOM properties.
 */
export const useHydrated = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

/** The `data-hydrated` attribute value: present once hydrated, absent before. */
export const useHydratedMarker = (): true | undefined => (useHydrated() ? true : undefined);
