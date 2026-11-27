import "server-only";
import { getConfig } from "./config";

/**
 * The ERP offer of this storefront: the entry of its own company (`ONTOS_STOREFRONT_LEGAL_ENTITY_ID`) in
 * `ONTOS_STOREFRONT_ERP_OFFERS`, a JSON object keyed by Legal Entity id, because every brand runs this one build from
 * the same `setup: storefront`. An offer names the Inventory Customer Configuration its stock figures are read under,
 * and the exact Price key scope Symmy's price route imported its prices with (Channel, Commerce Market, currency and
 * Unit basis). No entry for this company: this storefront shows no ERP products.
 */
export interface ErpOffer {
  readonly customerConfigurationId: string;
  readonly channelId: "B2C" | "B2B";
  readonly marketId: string;
  readonly currencyCode: string;
  /** The Catalog Product Unit of the Price Unit basis. */
  readonly unitId: string;
  /** The quantity of the Price Unit basis (a canonical decimal, `1`). */
  readonly unitQuantity: string;
}

const VARIABLE = "ONTOS_STOREFRONT_ERP_OFFERS";
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 300;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseOffer = (legalEntityId: string, value: unknown): ErpOffer => {
  const invalid = new Error(
    `${VARIABLE}[${legalEntityId}] needs customerConfigurationId, channelId (B2C|B2B), marketId, currencyCode, unitId (UUID) and unitQuantity`,
  );
  if (!isObject(value)) throw invalid;
  const { customerConfigurationId, channelId, marketId, currencyCode, unitId, unitQuantity } =
    value;
  if (
    !text(customerConfigurationId) ||
    (channelId !== "B2C" && channelId !== "B2B") ||
    !text(marketId) ||
    typeof currencyCode !== "string" ||
    !/^[A-Z]{3}$/u.test(currencyCode) ||
    typeof unitId !== "string" ||
    !UUID.test(unitId) ||
    typeof unitQuantity !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(unitQuantity)
  )
    throw invalid;
  return { customerConfigurationId, channelId, marketId, currencyCode, unitId, unitQuantity };
};

/** Every entry is checked, so a broken offer of another brand fails this one too instead of hiding until it deploys. */
export const parseErpOffers = (
  raw: string | undefined,
  legalEntityId: string,
): ErpOffer | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value: unknown = JSON.parse(raw);
  if (!isObject(value))
    throw new Error(`${VARIABLE} is not a JSON object keyed by Legal Entity id`);
  const offers = new Map<string, ErpOffer>();
  for (const [key, entry] of Object.entries(value)) {
    if (!UUID.test(key))
      throw new Error(`${VARIABLE} key ${JSON.stringify(key)} is not a Legal Entity id`);
    offers.set(key.toLowerCase(), parseOffer(key, entry));
  }
  return offers.get(legalEntityId.toLowerCase());
};

export const getErpOffer = (): ErpOffer | undefined =>
  parseErpOffers(process.env[VARIABLE], getConfig().legalEntityId);
