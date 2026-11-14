import { headers } from "next/headers";
import { CustomerOrderDetailView } from "@/features/customer-order-detail";
import { getDictionary } from "@/i18n";
import { getCustomerOrders } from "@/ontos/customer-orders-server";
import { portalRequestContext } from "@/ontos/portal-server";

const CustomerOrderPage = async ({
  params,
}: {
  params: Promise<{ locale: string; orderId: string }>;
}) => {
  const { locale, orderId } = await params;
  const incoming = await headers();
  const origin = incoming.get("x-n1-request-origin");
  const initial =
    origin === null
      ? { state: "unavailable" as const }
      : await getCustomerOrders(
          { locale: locale === "en" ? "en" : "cs", orderId },
          portalRequestContext(origin, incoming.get("cookie") ?? undefined),
        );
  return (
    <CustomerOrderDetailView dictionary={getDictionary(locale)} initial={initial} locale={locale} />
  );
};
export default CustomerOrderPage;
