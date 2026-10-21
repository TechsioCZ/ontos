import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getConfig } from "./config";

declare global {
  interface CloudflareEnv {
    ONTOS_ACTIVE_APPLICATION_COMPOSITION?: {
      get(key: string, type: "json"): Promise<unknown>;
    };
  }
}

/** Workers read the deployment's KV snapshot; the local demo uses its HTTP publisher. */
export const readActiveRevision = async (): Promise<string | undefined> => {
  let binding: CloudflareEnv["ONTOS_ACTIVE_APPLICATION_COMPOSITION"];
  try {
    binding = getCloudflareContext().env.ONTOS_ACTIVE_APPLICATION_COMPOSITION;
  } catch {
    // A plain Next.js local server has no Cloudflare request context.
  }
  const snapshot = binding
    ? await binding.get("active", "json")
    : await fetch(getConfig().compositionUrl, { signal: AbortSignal.timeout(4000) }).then(
        (response) => (response.ok ? response.json() : undefined),
      );
  const revision = (snapshot as { composition?: { revision?: unknown } } | undefined)?.composition
    ?.revision;
  return typeof revision === "string" && /^[\da-f]{64}$/u.test(revision) ? revision : undefined;
};
