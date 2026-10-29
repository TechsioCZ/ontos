import { readFileSync, writeFileSync } from "node:fs";

// Wrangler JSON does not expand shell variables. Generate only the allowlisted,
// non-secret deployment settings; API keys are provisioned separately as Worker secrets.
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const shellUrl = new URL(required("ONTOS_SHELL_URL"));
if (shellUrl.protocol !== "https:") throw new Error("ONTOS_SHELL_URL must use HTTPS");
// The storefront's public origin (app/topology/stage-edge.json storefrontHostname), served as its custom domain.
const storefrontUrl = new URL(required("STOREFRONT_URL"));
if (
  storefrontUrl.protocol !== "https:" ||
  storefrontUrl.origin !== process.env.STOREFRONT_URL.trim()
)
  throw new Error("STOREFRONT_URL must be an HTTPS origin");
// The storefront's own catalog cache (public catalog reads only), shared by every data center.
const catalogNamespaceId = required("STOREFRONT_CATALOG_KV_ID");
if (!/^[a-f\d]{32}$/u.test(catalogNamespaceId)) throw new Error("Invalid catalog KV namespace ID");
// The Shell ingress Worker in the same account: the storefront calls it over a service binding, so a
// call runs the Shell on the storefront's machine instead of a public round trip to its custom domain.
const shellWorker = required("ONTOS_SHELL_WORKER_NAME");
if (!/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u.test(shellWorker))
  throw new Error("Invalid Shell Worker name");
// wrangler.jsonc as the formatter writes it: JSON plus trailing commas (no comments).
const config = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(
    /,(\s*[}\]])/gu,
    "$1",
  ),
);
config.vars = {
  ONTOS_SHELL_URL: shellUrl.origin,
  STOREFRONT_IMAGE_HOSTS: process.env.STOREFRONT_IMAGE_HOSTS ?? "",
};
config.routes = [{ pattern: storefrontUrl.hostname, custom_domain: true }];
config.kv_namespaces = [{ binding: "STOREFRONT_CATALOG_CACHE", id: catalogNamespaceId }];
config.services = [{ binding: "ONTOS_SHELL", service: shellWorker }];
writeFileSync(
  new URL("../.wrangler.generated.json", import.meta.url),
  `${JSON.stringify(config, null, 2)}\n`,
);
