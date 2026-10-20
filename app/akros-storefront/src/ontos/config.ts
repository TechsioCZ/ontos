import "server-only";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
function managedKey() {
  if (process.env.ONTOS_AKROS_STOREFRONT_API_KEY) return process.env.ONTOS_AKROS_STOREFRONT_API_KEY;
  try {
    const line = readFileSync(resolve(process.cwd(), "../.env.demo.local"), "utf8")
      .split(/\r?\n/)
      .find((line) => line.startsWith("ONTOS_AKROS_STOREFRONT_API_KEY="));
    return line
      ?.slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^[\"\']|[\"\']$/g, "");
  } catch {
    return undefined;
  }
}
export const AKROS_LEGAL_ENTITY_ID = "71000000-0000-4000-8000-000000000024";
export const isOntos = () => process.env.STOREFRONT_DATA_SOURCE === "ontos";
export const getConfig = () => ({
  apiKey: managedKey(),
  shellUrl: (process.env.ONTOS_SHELL_URL ?? "http://localhost:3020").replace(/\/+$/, ""),
  legalEntityId: AKROS_LEGAL_ENTITY_ID,
  compositionUrl:
    process.env.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL ?? "http://127.0.0.1:3041/active",
  compositionRevision: process.env.ONTOS_COMPOSITION_REVISION,
});
