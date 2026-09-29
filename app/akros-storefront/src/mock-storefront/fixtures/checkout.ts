// Local prototype configuration, not live carrier availability or a payment integration.
export const checkoutDeliveryMethods = [
  {
    id: "zasilkovna",
    title: "Zásilkovna",
    description: "Obvykle 1–2 pracovní dny",
    priceMinor: 7900,
    priceExcludingVatMinor: 6529,
    logo: "/akros/checkout/zasilkovna.png",
    pickup: true,
  },
  {
    id: "balikovna",
    title: "Balíkovna",
    description: "Obvykle 1–2 pracovní dny",
    priceMinor: 7900,
    priceExcludingVatMinor: 6529,
    logo: "/akros/checkout/balikovna.png",
    pickup: true,
  },
  {
    id: "dpd",
    title: "DPD Parcel",
    description: "Obvykle 1–2 pracovní dny",
    priceMinor: 7900,
    priceExcludingVatMinor: 6529,
    logo: "/akros/checkout/dpd.png",
    pickup: false,
  },
  {
    id: "osobni",
    title: "Osobní odběr",
    description: "Již dnes · ukázková prodejna Praha",
    priceMinor: 0,
    priceExcludingVatMinor: 0,
    logo: "/akros/checkout/akros.png",
    pickup: false,
  },
] as const;

export const checkoutPaymentMethods = [
  {
    id: "gopay",
    title: "GoPay",
    priceMinor: 0,
    priceExcludingVatMinor: 0,
    logo: "/akros/checkout/gopay.png",
    pickupOnly: false,
  },
  {
    id: "apple-pay",
    title: "Apple Pay",
    priceMinor: 0,
    priceExcludingVatMinor: 0,
    logo: "/akros/checkout/apple-pay.png",
    pickupOnly: false,
  },
  {
    id: "store-card",
    title: "Kartou na prodejně",
    priceMinor: 0,
    priceExcludingVatMinor: 0,
    logo: null,
    pickupOnly: true,
  },
] as const;

export const checkoutPickupPoints = [
  {
    id: "zasilkovna-praha",
    deliveryId: "zasilkovna",
    label: "Ukázková pobočka Praha · Vinohradská 10",
  },
  { id: "zasilkovna-brno", deliveryId: "zasilkovna", label: "Ukázková pobočka Brno · Lidická 20" },
  {
    id: "balikovna-praha",
    deliveryId: "balikovna",
    label: "Ukázková pobočka Praha · Jindřišská 14",
  },
  { id: "balikovna-brno", deliveryId: "balikovna", label: "Ukázková pobočka Brno · Nádražní 7" },
] as const;

export const demoStoreAddress = "Ukázková prodejna AKROS · Průmyslová 1420, Praha 10, 102 00";
