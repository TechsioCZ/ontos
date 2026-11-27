// Salesperson avatar + name; "Bez obchodníka" when the client is unassigned.
import { Badge } from '@techsio/ui-kit/atoms/badge';

const initials = (name: string) =>
  name
    .split(/\s+/u)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase('cs-CZ') ?? '')
    .join('');

export const SalespersonChip = ({ name }: { readonly name: string | undefined }) => {
  if (name === undefined || name === '') {
    return (
      <Badge size="sm" variant="warning">
        Bez obchodníka
      </Badge>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-100">
      <span
        aria-hidden
        className="inline-flex size-300 shrink-0 items-center justify-center rounded-full bg-primary-light font-semibold text-primary text-xs"
      >
        {initials(name)}
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
};
