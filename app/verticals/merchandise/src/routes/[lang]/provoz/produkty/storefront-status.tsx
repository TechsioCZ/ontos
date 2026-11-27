// „Na e-shopu: ano/ne“ of a product, from the facts the storefront read itself filters on (staff reads attach them).
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { Link } from '@techsio/ui-kit/atoms/link';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { StorefrontVisibilityStatus } from '../../../../../shared/domain/storefront-visibility.ts';
import { storefrontVisibilityStatus } from '../../../../../shared/domain/storefront-visibility.ts';

/** The label of the storefront badge in the detail: it never contradicts the link next to it. */
const storefrontBadgeLabel = (status: StorefrontVisibilityStatus) => {
  if (status.visible) {
    return 'Na e-shopu: ano';
  }
  return status.pageOpens ? 'Jen přímým odkazem' : 'Na e-shopu: ne';
};

/** The grey line under the product name in the list: what hides the product, from the same status; nothing when fully visible. */
export const storefrontListNote = (product: ProductRecord): string | null => {
  const facts = product.storefrontVisibility;
  if (facts === undefined) {
    return null;
  }
  const status = storefrontVisibilityStatus(facts);
  if (status.visible) {
    return null;
  }
  return status.pageOpens ? 'jen přímým odkazem, není ve výpisech' : 'skryto v e-shopu';
};

/** List cell: one icon-only link to the product page on the shop, nothing when the page does not open. */
export const StorefrontStatusCell = ({ product }: { readonly product: ProductRecord }) => {
  const facts = product.storefrontVisibility;
  if (facts === undefined) {
    return null;
  }
  const status = storefrontVisibilityStatus(facts);
  return (
    <span className="flex justify-center" data-storefront-status={status.visible ? 'visible' : 'hidden'}>
      {status.pageOpens && facts.href !== undefined && (
        <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Link
            aria-label="Otevřít v e-shopu"
            className="inline-flex items-center"
            external
            href={facts.href}
            title="Otevřít v e-shopu"
          >
            <Icon aria-hidden="true" icon="icon-[mdi--open-in-new]" size="sm" />
          </Link>
        </span>
      )}
    </span>
  );
};

/** Detail: the answer with every reason and what to change, plus what the shopper sees without it being hidden. */
export const StorefrontStatusPanel = ({ product }: { readonly product: ProductRecord }) => {
  const facts = product.storefrontVisibility;
  if (facts === undefined) {
    return null;
  }
  const status = storefrontVisibilityStatus(facts);
  return (
    <div
      className="flex flex-col gap-100 rounded-md border border-border-primary p-200"
      data-storefront-status={status.visible ? 'visible' : 'hidden'}
    >
      <div className="flex flex-wrap items-center gap-150">
        <Badge severity={status.visible ? 'success' : 'warning'} size="sm">
          {storefrontBadgeLabel(status)}
        </Badge>
        <span className="text-sm">
          {status.visible
            ? 'Produkt je v e-shopu ve výpisech kategorií, ve vyhledávání i na vlastní stránce.'
            : status.pageOpens
              ? 'Stránka produktu se otevře přímým odkazem, ve výpisech a ve vyhledávání e-shopu ale není.'
              : 'Zákazník produkt v e-shopu nenajde.'}
        </span>
        {status.pageOpens && facts.href !== undefined && (
          <Link className="ml-auto" external href={facts.href} target="_blank">
            Otevřít v e-shopu
          </Link>
        )}
      </div>
      {status.reasons.length > 0 && (
        <ul className="m-0 flex list-disc flex-col gap-50 pl-300 text-sm">
          {status.reasons.map((reason) => (
            <li key={reason.why}>
              <span className="font-semibold">{reason.why}</span> <span>Co změnit: {reason.fix}</span>
            </li>
          ))}
        </ul>
      )}
      {status.notes.map((note) => (
        <p className="m-0 text-fg-secondary text-sm" key={note}>
          {note}
        </p>
      ))}
    </div>
  );
};
