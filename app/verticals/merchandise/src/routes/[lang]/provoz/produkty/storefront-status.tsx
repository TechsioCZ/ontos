// „Na e-shopu: ano/ne“ of a product, from the facts the storefront read itself filters on (staff reads attach them).
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Link } from '@techsio/ui-kit/atoms/link';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { storefrontVisibilityStatus } from '../../../../../shared/domain/storefront-visibility.ts';

/** List cell: the answer, the first reason and the storefront link. Nothing for a company without an e-shop. */
export const StorefrontStatusCell = ({ product }: { readonly product: ProductRecord }) => {
  const facts = product.storefrontVisibility;
  if (facts === undefined) {
    return null;
  }
  const status = storefrontVisibilityStatus(facts);
  const [first] = status.reasons;
  return (
    <span
      className="flex min-w-0 flex-col gap-50"
      data-storefront-status={status.visible ? 'visible' : 'hidden'}
      title={status.reasons.map((reason) => `${reason.why} ${reason.fix}`).join('\n')}
    >
      <span className="flex items-center gap-100">
        <Badge severity={status.visible ? 'success' : 'warning'} size="sm">
          {status.visible ? 'Na e-shopu: ano' : 'Na e-shopu: ne'}
        </Badge>
        {status.pageOpens && facts.href !== undefined && (
          <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <Link external href={facts.href} target="_blank">
              Otevřít
            </Link>
          </span>
        )}
      </span>
      {first !== undefined && <span className="truncate text-fg-secondary text-xs">{first.why}</span>}
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
          {status.visible ? 'Na e-shopu: ano' : 'Na e-shopu: ne'}
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
