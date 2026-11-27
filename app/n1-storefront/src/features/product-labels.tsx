import { Badge } from "@techsio/ui-kit/atoms/badge";
import type { Dictionary } from "@/i18n";
import type { ProductLabel } from "@/ontos/catalog-model";

const labelVariant = {
  action: "danger",
  new: "primary",
  recommended: "info",
  sale: "discount",
} as const;

/** The OntOS storefront labels (Akce, Novinka, Doporučujeme, Výprodej) staff switch on in the product editor. */
export const ProductLabels = ({
  className,
  dictionary: d,
  labels,
}: {
  className?: string;
  dictionary: Dictionary;
  labels: readonly ProductLabel[] | undefined;
}) =>
  labels === undefined || labels.length === 0 ? null : (
    <ul aria-label={d.productLabels.title} className={`flex flex-wrap gap-2 ${className ?? ""}`}>
      {labels.map((label) => (
        <li key={label}>
          <Badge size="sm" variant={labelVariant[label]}>
            {d.productLabels[label]}
          </Badge>
        </li>
      ))}
    </ul>
  );
