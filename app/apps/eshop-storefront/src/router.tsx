import { useEffect, useSyncExternalStore } from 'react';
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
window.addEventListener('popstate', notify);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => `${window.location.pathname}${window.location.search}`;

export interface Location {
  readonly path: string;
  readonly search: URLSearchParams;
  readonly href: string;
}

export const useLocation = (): Location => {
  const href = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(href, window.location.origin);
  return { href, path: url.pathname, search: url.searchParams };
};

export const navigate = (to: string, options: { replace?: boolean; keepScroll?: boolean } = {}): void => {
  if (to === snapshot()) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  notify();
  if (!options.keepScroll) window.scrollTo({ behavior: 'instant' as ScrollBehavior, top: 0 });
};

/** Builds `path?query` from params, dropping empty values. */
export const withParams = (path: string, params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const query = search.toString();
  return query === '' ? path : `${path}?${query}`;
};

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { readonly to: string; readonly children: ReactNode; readonly replace?: boolean };

export const Link = ({ children, onClick, replace, to, ...rest }: LinkProps) => (
  <a
    {...rest}
    href={to}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to, { replace });
    }}
  >
    {children}
  </a>
);

export const useDocumentTitle = (title: string): void => {
  useEffect(() => {
    document.title = `${title} · Kavárna Doma (DEMO)`;
  }, [title]);
};
