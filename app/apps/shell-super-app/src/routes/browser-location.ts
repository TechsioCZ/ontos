import { useSyncExternalStore } from 'react';

const subscribe = (listener: () => void) => {
  globalThis.addEventListener('popstate', listener);
  globalThis.addEventListener('hashchange', listener);
  return () => {
    globalThis.removeEventListener('popstate', listener);
    globalThis.removeEventListener('hashchange', listener);
  };
};
const browserHref = (): string => globalThis.location.href;
const serverHref = (): undefined => undefined;

export const useBrowserLocationHref = (): string | undefined =>
  useSyncExternalStore<string | undefined>(subscribe, browserHref, serverHref);
