// One contact person of the client card: name, work role, phone, e-mail and note, with edit / remove icons.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { formatDate, surfaceTileClassName } from '@app/admin-ui';
import { ActionIcon } from '@techsio/ui-kit/atoms/action-icon';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Link } from '@techsio/ui-kit/atoms/link';
import { pipe } from 'effect';
import { useEffect, useRef } from 'react';
import type { ContactPerson } from '../../../../../shared/domain/clients.ts';
import { orderDateText } from '../../../../../shared/domain/imports.ts';

export const ContactCard = ({
  contact,
  onEdit,
  onRemove,
  selected,
  writable,
}: {
  readonly contact: ContactPerson;
  readonly onEdit?: () => void;
  readonly onRemove?: () => void;
  readonly selected?: boolean;
  readonly writable: boolean;
}) => {
  const { t } = useModernI18n();
  const card = useRef<HTMLLIElement>(null);
  const archived = contact.status === 'archived';
  useEffect(() => {
    if (selected === true) {
      card.current?.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    }
  }, [selected]);
  return (
    <li
      aria-current={selected === true ? 'true' : undefined}
      className={`${surfaceTileClassName} flex flex-col gap-100 p-200 ${archived ? 'opacity-60' : ''} ${selected === true ? 'ring-2 ring-primary' : ''}`}
      ref={card}
    >
      <div className="flex items-start justify-between gap-100">
        <div className="flex min-w-0 items-center gap-150">
          <span
            aria-hidden
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-fg-secondary"
          >
            <span className="icon-[mdi--account-outline] size-5" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="flex flex-wrap items-center gap-100">
              <span className="break-words font-medium">{contact.name}</span>
              {contact.primary === true && (
                <Badge size="sm" variant="primary">
                  Hlavní kontakt
                </Badge>
              )}
              {archived && (
                <Badge size="sm" variant="outline">
                  {`Odebrán ${pipe(contact.archivedAt, orderDateText, formatDate)}`}
                </Badge>
              )}
              {selected === true && (
                <Badge size="sm" variant="info">
                  {t('crm.ciClientsVisits.contacts.selected')}
                </Badge>
              )}
            </span>
            <span className="text-fg-secondary text-sm">{contact.role ?? 'pracovní role neuvedena'}</span>
          </div>
        </div>
        {writable && !archived && (
          <div className="flex shrink-0 gap-50">
            <ActionIcon
              aria-label={`Upravit ${contact.name}`}
              icon="icon-[mdi--pencil-outline]"
              onClick={onEdit}
              size="sm"
              tone="neutral"
            />
            <ActionIcon
              aria-label={`Odebrat ${contact.name}`}
              icon="icon-[mdi--account-remove-outline]"
              onClick={onRemove}
              size="sm"
              tone="neutral"
            />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-50 text-sm">
        <span className="flex items-center gap-100">
          <span aria-hidden className="icon-[mdi--phone-outline] size-200 text-fg-secondary" />
          {contact.phone === undefined ? (
            <span className="text-fg-secondary">telefon neuveden</span>
          ) : (
            <Link href={`tel:${contact.phone.replaceAll(' ', '')}`}>{contact.phone}</Link>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-100">
          <span aria-hidden className="icon-[mdi--email-outline] size-200 text-fg-secondary" />
          {contact.email === undefined ? (
            <span className="text-fg-secondary">e-mail neuveden</span>
          ) : (
            <Link className="min-w-0 break-all" href={`mailto:${contact.email}`}>
              {contact.email}
            </Link>
          )}
        </span>
      </div>
      {contact.note !== undefined && (
        <p className="whitespace-pre-line rounded-md bg-surface-secondary px-150 py-100 text-fg-secondary text-sm">
          {contact.note}
        </p>
      )}
    </li>
  );
};
