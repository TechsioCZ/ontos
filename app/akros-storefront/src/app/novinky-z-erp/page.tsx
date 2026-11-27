import { permanentRedirect } from "next/navigation";

import { marketHref } from "@/ontos/active-market";

/** „Novinky z ERP“ is gone: products imported through Symmy are ordinary products of the shop catalogue. */
export default async function ErpCataloguePage(): Promise<never> {
  permanentRedirect(await marketHref("/"));
}
