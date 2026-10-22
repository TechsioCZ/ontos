import { env } from 'cloudflare:workers';

/**
 * Server rendering on Workers reaches this Shell's own BFF through its `ONTOS_SHELL_SELF` service binding: the
 * page's reads then run on this machine instead of a public round trip through the custom domain to an isolate
 * that may be cold elsewhere. Without the binding the global fetch keeps working.
 */
export const ssrBffFetch = (): typeof globalThis.fetch | undefined => {
  const binding = env.ONTOS_SHELL_SELF;
  return binding === undefined ? undefined : binding.fetch.bind(binding);
};
