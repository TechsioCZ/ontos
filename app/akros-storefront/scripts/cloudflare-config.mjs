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
const namespaceId = required("ONTOS_ACTIVE_APPLICATION_COMPOSITION_KV_ID");
if (!/^[a-f\d]{32}$/u.test(namespaceId)) throw new Error("Invalid composition KV namespace ID");
// The Shell ingress Worker in the same account: the storefront calls it over a service binding, so a
// call runs the Shell on the storefront's machine instead of a public round trip to its custom domain.
const shellWorker = required("ONTOS_SHELL_WORKER_NAME");
if (!/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u.test(shellWorker))
  throw new Error("Invalid Shell Worker name");
const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
config.vars = {
  ONTOS_SHELL_URL: shellUrl.origin,
  STOREFRONT_IMAGE_HOSTS: process.env.STOREFRONT_IMAGE_HOSTS ?? "",
};
config.kv_namespaces = [{ binding: "ONTOS_ACTIVE_APPLICATION_COMPOSITION", id: namespaceId }];
config.services = [{ binding: "ONTOS_SHELL", service: shellWorker }];
writeFileSync(
  new URL("../.wrangler.generated.json", import.meta.url),
  `${JSON.stringify(config, null, 2)}\n`,
);
