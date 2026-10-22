const common = {
  slug: "layout-test",
  imageSrc: "/bolt.png",
  imageAlt: "Layout fixture",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 200000,
  priceMinor: 97,
  priceExcludingVatMinor: 80,
};

export const cartFixture = {
  version: 3,
  lines: [
    {
      ...common,
      productId: "layout-screw",
      name: "VRUTY SE ZÁPUSTNOU HLAVOU S KŘÍŽOVOU DRÁŽKOU DIN 7997/A2",
      variantLabel: "vrut 3.5 × 16, DIN7997/A2",
      sku: "10799700035016",
      minimumQuantity: 20,
      quantity: 40,
    },
    {
      ...common,
      productId: "layout-profile",
      name: "Dlouhý profil pro kontrolu šířky a desetinného množství",
      sku: "PROFILE-WITH-A-LONG-UNBROKEN-CODE-12345678901234567890",
      unit: "m",
      minimumQuantity: 0.000001,
      priceMinor: 125000,
      priceExcludingVatMinor: 103306,
      quantity: 12.123456,
    },
    {
      ...common,
      productId: "layout-large",
      name: "Velké množství a celková cena",
      sku: "LARGE-100000",
      priceMinor: 125000,
      priceExcludingVatMinor: 103306,
      quantity: 100000,
    },
  ],
};

export const checkoutFixture = {
  version: 1,
  draft: {
    deliveryId: "osobni",
    pickupPointId: "",
    email: "layout@example.com",
    company: "",
    companyId: "",
    vatId: "",
    billing: {
      firstName: "Jan",
      lastName: "Test",
      street: "Testovací 1",
      city: "Praha",
      postalCode: "10200",
      country: "CZ",
      phone: "+420777123456",
    },
    delivery: {
      firstName: "",
      lastName: "",
      street: "",
      city: "",
      postalCode: "",
      country: "CZ",
      phone: "",
    },
    differentDeliveryAddress: false,
  },
};
