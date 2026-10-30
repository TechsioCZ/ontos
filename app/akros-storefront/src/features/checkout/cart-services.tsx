import { Icon } from "@techsio/ui-kit/atoms/icon";
import { cs } from "@/i18n/cs";

export function CartServices() {
  return (
    <div
      data-akros-cart-services
      className="flex items-center gap-(--dimension-24) pt-(--dimension-24) max-sm:gap-(--dimension-16)"
    >
      <span
        aria-hidden="true"
        className="shrink-0 text-(length:--akros-checkout-shipping-icon-size) text-(--akros-checkout-muted)"
      >
        <Icon icon="token-icon-akros-checkout-shipping" size="current" />
      </span>
      <div className="grid min-w-0 gap-(--dimension-8)">
        <p className="text-(length:--akros-checkout-body-size)">
          {cs.checkout.deliveryInformationTitle}
        </p>
        <p className="text-(length:--akros-checkout-small-size) text-(--akros-checkout-muted)">
          {cs.checkout.deliveryInformation}
        </p>
      </div>
    </div>
  );
}
