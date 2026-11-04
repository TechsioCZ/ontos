import { CheckoutView } from "@/features/checkout-view";
import { getDictionary } from "@/i18n";
import { getCheckoutOptions } from "@/ontos/checkout-server";

const CheckoutPage = async ({ params }: { params: Promise<{ locale: string }> }) => {
  const { locale } = await params;
  return (
    <CheckoutView
      dictionary={getDictionary(locale)}
      locale={locale}
      options={await getCheckoutOptions(locale)}
    />
  );
};
export default CheckoutPage;
