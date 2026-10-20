export const mockCustomer = {
  initials: "JN",
  name: "Jan Novák",
  customerNumber: "84210",
  email: "novak@stavebniny.cz",
  phone: "+420 777 123 456",
  company: "Stavebniny s.r.o.",
  address: "Průmyslová 1420, Praha 10, 102 00",
} as const;

export const mockOrders = [
  { number: "#2024-00847", date: "28. 10. 2026", items: 3, total: "1 569 Kč", status: "Odesláno" },
  { number: "#2024-00812", date: "15. 10. 2026", items: 12, total: "8 450 Kč", status: "Doručeno" },
  { number: "#2024-00790", date: "02. 10. 2026", items: 5, total: "2 110 Kč", status: "Doručeno" },
  { number: "#2024-00754", date: "14. 09. 2026", items: 1, total: "450 Kč", status: "Doručeno" },
  { number: "#2024-00711", date: "28. 08. 2026", items: 8, total: "3 890 Kč", status: "Doručeno" },
] as const;

export const mockOrderLines = [
  {
    name: "Šroub se šestihrannou hlavou M8×30 DIN 933 A2",
    code: "NX-9330830",
    quantity: "50 ks",
    unitPrice: "17,80 Kč",
    total: "890 Kč",
  },
  {
    name: "Matice šestihranná M8 DIN 934 / A2",
    code: "NX-93408A2",
    quantity: "100 ks",
    unitPrice: "3,40 Kč",
    total: "340 Kč",
  },
  {
    name: "Podložka plochá M8 DIN 125A / A2",
    code: "NX-12508A2",
    quantity: "100 ks",
    unitPrice: "2,20 Kč",
    total: "220 Kč",
  },
] as const;

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
