// Local presentation data, not live carrier availability. OntOS supports exactly these two delivery methods.
export const checkoutDeliveryMethods = [
  {
    id: "zasilkovna",
    title: "Zásilkovna",
    description: "Obvykle 1–2 pracovní dny",
    priceMinor: 7900,
    logo: "/akros/checkout/zasilkovna.png",
    pickup: true,
  },
  {
    id: "osobni",
    title: "Osobní odběr",
    description: "Již dnes · ukázková prodejna Praha",
    priceMinor: 0,
    logo: "/akros/checkout/akros.png",
    pickup: false,
  },
] as const;

export const checkoutPickupPoints = [
  {
    id: "zasilkovna-praha",
    deliveryId: "zasilkovna",
    label: "Ukázková pobočka Praha · Vinohradská 10",
  },
  { id: "zasilkovna-brno", deliveryId: "zasilkovna", label: "Ukázková pobočka Brno · Lidická 20" },
] as const;

export const demoStoreAddress = "Ukázková prodejna AKROS · Průmyslová 1420, Praha 10, 102 00";
