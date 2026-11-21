import "server-only";

/**
 * The ERP offer of this storefront (`ONTOS_STOREFRONT_ERP_OFFER`, JSON): the Inventory Customer Configuration its
 * stock figures are read under, and the exact Price key scope Symmy's price route imported its prices with (Channel,
 * Commerce Market, currency and Unit basis). Unset: this storefront shows no ERP products.
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

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 300;

export const parseErpOffer = (raw: string | undefined): ErpOffer | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object")
    throw new Error("ONTOS_STOREFRONT_ERP_OFFER is not a JSON object");
  const offer = value as Record<string, unknown>;
  const { customerConfigurationId, channelId, marketId, currencyCode, unitId, unitQuantity } =
    offer;
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
    throw new Error(
      "ONTOS_STOREFRONT_ERP_OFFER needs customerConfigurationId, channelId (B2C|B2B), marketId, currencyCode, unitId (UUID) and unitQuantity",
    );
  return { customerConfigurationId, channelId, marketId, currencyCode, unitId, unitQuantity };
};

export const getErpOffer = (): ErpOffer | undefined =>
  parseErpOffer(process.env.ONTOS_STOREFRONT_ERP_OFFER);
