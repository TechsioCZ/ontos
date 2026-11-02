import "server-only";

// Storefront identity in OntOS, read from the server environment at request time so one build serves every
// storefront instance (see FOR-KAI-UWE "Brand configuration"). Unset keeps the original demo AKROS storefront.
const DEFAULT_APP_ID = "akros-storefront";
const DEFAULT_LEGAL_ENTITY_ID = "71000000-0000-4000-8000-000000000024";
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const APP_ID = /^[a-z][\da-z-]*$/;

const configured = (name: string, fallback: string, valid: RegExp): string => {
  const value = process.env[name]?.trim() || fallback;
  if (!valid.test(value)) throw new Error(`${name} is not valid: ${JSON.stringify(value)}`);
  return value;
};

export const getConfig = () => ({
  apiKey: process.env.ONTOS_AKROS_STOREFRONT_API_KEY,
  shellUrl: (process.env.ONTOS_SHELL_URL ?? "http://localhost:3020").replace(/\/+$/, ""),
  /** Storefront Application id of this instance (`ONTOS_STOREFRONT_APP_ID`): its market associations. */
  appId: configured("ONTOS_STOREFRONT_APP_ID", DEFAULT_APP_ID, APP_ID),
  /** Selling Legal Entity (`ONTOS_STOREFRONT_LEGAL_ENTITY_ID`): every read/action carries it. */
  legalEntityId: configured("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", DEFAULT_LEGAL_ENTITY_ID, UUID),
});
