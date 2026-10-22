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
const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
config.vars = {
  ONTOS_SHELL_URL: shellUrl.origin,
  STOREFRONT_IMAGE_HOSTS: process.env.STOREFRONT_IMAGE_HOSTS ?? "",
};
config.kv_namespaces = [{ binding: "ONTOS_ACTIVE_APPLICATION_COMPOSITION", id: namespaceId }];
writeFileSync(
  new URL("../.wrangler.generated.json", import.meta.url),
  `${JSON.stringify(config, null, 2)}\n`,
);
