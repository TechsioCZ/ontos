import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

declare global {
  interface CloudflareEnv {
    ONTOS_SHELL?: { fetch: typeof fetch };
  }
}

/**
 * Reaches the OntOS Shell. On Workers the deployment binds the Shell Worker as a service, so the call
 * runs the Shell on this machine instead of a public round trip to its domain; the request keeps its
 * Shell URL. The local demo (plain Next.js) reaches the Shell at that URL.
 */
export const shellFetch = async (url: string, init: RequestInit): Promise<Response> => {
  let binding: CloudflareEnv["ONTOS_SHELL"];
  try {
    binding = getCloudflareContext().env.ONTOS_SHELL;
  } catch {
    // A plain Next.js local server has no Cloudflare request context.
    return await fetch(url, init);
  }
  if (binding === undefined) throw new Error("ONTOS_SHELL service binding is not configured");
  return await binding.fetch(url, init);
};
