import "server-only";
export const AKROS_LEGAL_ENTITY_ID = "71000000-0000-4000-8000-000000000024";
export const getConfig = () => ({
  apiKey: process.env.ONTOS_AKROS_STOREFRONT_API_KEY,
  shellUrl: (process.env.ONTOS_SHELL_URL ?? "http://localhost:3020").replace(/\/+$/, ""),
  legalEntityId: AKROS_LEGAL_ENTITY_ID,
  compositionUrl:
    process.env.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL ?? "http://127.0.0.1:3041/active",
  compositionRevision: process.env.ONTOS_COMPOSITION_REVISION,
});
