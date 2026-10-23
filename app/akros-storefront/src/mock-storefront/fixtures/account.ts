import { formatPrice } from "@/lib/format";

export interface DemoOrderLine {
  productId: string;
  variantId: string;
  name: string;
  sku: string;
  unit: string;
  quantity: number;
  priceMinor: number;
}

// All seed data for the demo account lives here. Order prices and addresses are historical snapshots.
export const demoAccount = {
  customerNumber: "84210",
  profile: {
    email: "novak@stavebniny.cz",
    firstName: "Jan",
    lastName: "Novák",
    billingEmail: "novak@stavebniny.cz",
    street: "Průmyslová 1420",
    city: "Praha 10",
    postalCode: "102 00",
    country: "CZ",
    phone: "+420 777 123 456",
    phone2: "",
    company: "Stavebniny s.r.o.",
    companyId: "12345678",
    vatId: "CZ12345678",
    deliveryStreet: "",
    deliveryCity: "",
    deliveryPostalCode: "",
    newsletter: false,
    privacyConsent: false,
  },
  orders: [
    {
      number: "#2024-00847",
      date: "28. 10. 2026",
      status: "Odesláno",
      billingAddress: {
        name: "Jan Novák",
        company: "Stavebniny s.r.o.",
        street: "Průmyslová 1420",
        city: "Praha 10",
        postalCode: "102 00",
        country: "CZ",
      },
      shippingMinor: 11900,
      shippingTitle: "PPL",
      paymentTitle: "Kartou online",
      lines: [
        {
          productId: "product-20532",
          variantId: "item-4746",
          name: "vrut 4 x 30,(záp.hl.+kř.dr.)DIN7997/A2",
          sku: "10799700040030",
          unit: "ks",
          quantity: 20,
          priceMinor: 154,
        },
        {
          productId: "product-20532",
          variantId: "item-5419",
          name: "vrut 4 x 20,(záp.hl.+kř.dr.)DIN7997/A2",
          sku: "10799700040020",
          unit: "ks",
          quantity: 40,
          priceMinor: 132,
        },
        {
          productId: "product-20532",
          variantId: "item-5294",
          name: "vrut 6 x 45,(záp.hl.+kř.dr.)DIN7997/A2",
          sku: "10799700060045",
          unit: "ks",
          quantity: 10,
          priceMinor: 569,
        },
      ],
    },
    {
      number: "#2024-00812",
      date: "15. 10. 2026",
      status: "Doručeno",
      billingAddress: {
        name: "Jan Novák",
        company: "Stavebniny s.r.o.",
        street: "Průmyslová 1420",
        city: "Praha 10",
        postalCode: "102 00",
        country: "CZ",
      },
      shippingMinor: 11900,
      shippingTitle: "PPL",
      paymentTitle: "Kartou online",
      lines: [
        {
          productId: "product-20532",
          variantId: "item-5420",
          name: "vrut 4 x 25,(záp.hl.+kř.dr.)DIN7997/A2",
          sku: "10799700040025",
          unit: "ks",
          quantity: 20,
          priceMinor: 126,
        },
        {
          productId: "product-20532",
          variantId: "item-6543",
          name: "vrut 3 x 25,(záp.hl.+kř.dr.)DIN7997/A2",
          sku: "10799700030025",
          unit: "ks",
          quantity: 20,
          priceMinor: 103,
        },
      ],
    },
    {
      number: "#2024-00790",
      date: "02. 10. 2026",
      status: "Doručeno",
      billingAddress: {
        name: "Jan Novák",
        company: "Stavebniny s.r.o.",
        street: "Průmyslová 1420",
        city: "Praha 10",
        postalCode: "102 00",
        country: "CZ",
      },
      shippingMinor: 11900,
      shippingTitle: "PPL",
      paymentTitle: "Kartou online",
      lines: [
        {
          productId: "product-20532",
          variantId: "item-4709",
          name: "vrut 5 x 25,(záp.hl.+kř.dr.)DIN7997/A2",
          sku: "10799700050025",
          unit: "ks",
          quantity: 100,
          priceMinor: 220,
        },
        {
          productId: "product-20532",
          variantId: "item-5878",
          name: "vrut 5 x 30,(záp.hl.+kř.dr.)DIN7997/A2",
          sku: "10799700050030",
          unit: "ks",
          quantity: 10,
          priceMinor: 230,
        },
      ],
    },
    {
      number: "#2024-00754",
      date: "14. 09. 2026",
      status: "Doručeno",
      billingAddress: {
        name: "Jan Novák",
        company: "Stavebniny s.r.o.",
        street: "Průmyslová 1420",
        city: "Praha 10",
        postalCode: "102 00",
        country: "CZ",
      },
      shippingMinor: 11900,
      shippingTitle: "PPL",
      paymentTitle: "Kartou online",
      lines: [
        {
          productId: "product-20532",
          variantId: "item-5421",
          name: "vrut 4 x 35,(záp.hl.+kř.dr.)DIN7997/A2",
          sku: "10799700040035",
          unit: "ks",
          quantity: 20,
          priceMinor: 189,
        },
      ],
    },
    {
      number: "#2024-00711",
      date: "28. 08. 2026",
      status: "Doručeno",
      billingAddress: {
        name: "Jan Novák",
        company: "Stavebniny s.r.o.",
        street: "Průmyslová 1420",
        city: "Praha 10",
        postalCode: "102 00",
        country: "CZ",
      },
      shippingMinor: 11900,
      shippingTitle: "PPL",
      paymentTitle: "Kartou online",
      lines: [
        {
          productId: "product-20532",
          variantId: "item-5422",
          name: "vrut 4 x 40,(záp.hl.+kř.dr.)DIN7997/A2",
          sku: "10799700040040",
          unit: "ks",
          quantity: 10,
          priceMinor: 170,
        },
        {
          productId: "product-20532",
          variantId: "item-5423",
          name: "vrut 4 x 50,(záp.hl.+kř.dr.)DIN7997/A2",
          sku: "10799700040050",
          unit: "ks",
          quantity: 10,
          priceMinor: 239,
        },
      ],
    },
  ],
};

export const mockCustomer = {
  initials: demoAccount.profile.firstName[0] + demoAccount.profile.lastName[0],
  name: demoAccount.profile.firstName + " " + demoAccount.profile.lastName,
  customerNumber: demoAccount.customerNumber,
  email: demoAccount.profile.email,
  phone: demoAccount.profile.phone,
  company: demoAccount.profile.company,
  address:
    demoAccount.profile.street +
    ", " +
    demoAccount.profile.city +
    ", " +
    demoAccount.profile.postalCode,
};

export const mockOrders = demoAccount.orders.map((order) => {
  const subtotalMinor = order.lines.reduce(
    (total, line) => total + Math.round(line.priceMinor * line.quantity),
    0,
  );
  return {
    ...order,
    subtotalMinor,
    totalMinor: subtotalMinor + order.shippingMinor,
    items: order.lines.length,
    total: formatPrice(subtotalMinor + order.shippingMinor),
  };
});
export type DemoOrder = (typeof mockOrders)[number];

export const mockTrackingSteps = [
  { title: "Přijato", detail: "28. 10. v 14:32", complete: true },
  { title: "Balení", detail: "29. 10. v 09:15", complete: true },
  { title: "Předáno", detail: "29. 10. v 13:45", complete: true },
  { title: "Na cestě", detail: "Aktuální stav", complete: true },
  { title: "Doručeno", detail: "Očekává se dnes", complete: false },
] as const;

export const mockTrackingEvents = [
  { time: "Dnes, 08:30", text: "Zásilka byla naložena kurýrem k doručení." },
  { time: "Včera, 18:40", text: "Zásilka dorazila na depo Ostrava." },
  {
    time: "Včera, 13:45",
    text: "Zásilka byla vyzvednuta přepravcem PPL z centrálního skladu AKROS.",
  },
  { time: "Včera, 09:15", text: "Zásilka byla úspěšně zabalena a připravena k expedici." },
] as const;

export const mockDeliveryMethods = [
  {
    id: "ppl",
    title: "Doručení kurýrem PPL",
    description: "Doručení na adresu do 24–48 hodin od expedice.",
    priceMinor: 11_900,
  },
  {
    id: "zasilkovna",
    title: "Zásilkovna — Výdejní místo",
    description: "Vyzvedněte si na jedné z tisíců poboček v ČR.",
    priceMinor: 8_900,
  },
  {
    id: "osobni",
    title: "Osobní odběr — Praha 10",
    description: "Průmyslová 1420. Vyzvednutí zdarma (Po–Pá 7:30–16:30).",
    priceMinor: 0,
  },
] as const;

export const mockPaymentMethods = [
  {
    id: "card",
    title: "Online platební karta",
    description: "Bezpečná ukázková platba bez zadávání údajů karty.",
  },
  {
    id: "transfer",
    title: "Bankovní převod",
    description: "Objednávku zpracujeme po připsání platby.",
  },
  { id: "cod", title: "Dobírka", description: "Platba při převzetí zásilky." },
] as const;
