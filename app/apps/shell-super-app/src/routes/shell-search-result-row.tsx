import type { Link as LocalizedLink } from '@modern-js/plugin-i18n/runtime';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { ComponentProps, ComponentType } from 'react';

import type { ShellSearchResult } from '../../shared/api.ts';
import { shellSearchResultBadges, shellSearchResultKey, shellSearchTitleSegments } from './shell-search-match.ts';
import { shellSearchResultTarget } from './shell-search-resource-types.ts';

type ResultLinkProps = ComponentProps<typeof LocalizedLink>;

/** The Shell's route link. A row opens its record through it, so it opens like every other Shell destination. */
export type ShellSearchResultLinkComponent = ComponentType<ResultLinkProps>;

/** Extra link attributes a caller may add; the row owns the target and the visual classes. */
export type ShellSearchResultLinkProps = Omit<ResultLinkProps, 'children' | 'className' | 'to'>;

/**
 * What the owner approved to show about a hit beyond its title. The Shell may add these; it may not add a raw
 * searchable term, a contact value, a snippet, a hidden count or a score.
 */
export interface ShellSearchResultPresentation {
  /** A second line under the title: the owner-approved context of the record. */
  readonly subtitle?: string;
  /** The record type in the reader's language, for a list that mixes types; groups already name it. */
  readonly typeLabel?: string;
}

export interface ShellSearchResultRowProps {
  /** `compact` for the palette under the search field, `comfortable` for the full results page. */
  readonly density?: 'compact' | 'comfortable';
  /**
   * Extra attributes for the record link, such as the palette's keyboard and focus handling. The row owns the link
   * target and the visual classes.
   */
  readonly linkProps?: ShellSearchResultLinkProps;
  readonly presentation?: ShellSearchResultPresentation;
  /** The query the person typed; only the title is highlighted, and only where it really matches. */
  readonly query: string;
  readonly result: ShellSearchResult;
  /** The Shell route link component, passed in so a row never imports a router itself. */
  readonly ResultLink: ShellSearchResultLinkComponent;
}

const linkClassName =
  'grid gap-y-50 rounded-md no-underline outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-200';

const linkPaddingClassName = {
  comfortable: 'px-250 py-200',
  compact: 'px-200 py-150',
} as const;

const titleClassName = {
  comfortable: 'line-clamp-2 font-medium text-fg-primary',
  compact: 'truncate font-medium text-fg-primary text-sm',
} as const;

/** Native `<mark>`, so the highlight reaches assistive technology instead of being colour alone. */
const markClassName = 'bg-primary-light font-semibold text-fg-primary';

const Title = ({ query, title }: { readonly query: string; readonly title: string }) => (
  <>
    {shellSearchTitleSegments(title, query).map((segment) =>
      segment.matched ? (
        <mark className={markClassName} key={segment.start}>
          {segment.text}
        </mark>
      ) : (
        segment.text
      ),
    )}
  </>
);

/**
 * One authorized search hit as an ordinary link inside the caller's list: the title with the query highlighted, at
 * most two badges from the owner's own fields, and an optional approved context line. Rows keep the order they are
 * given — the provider decides relevance — and carry no fabricated rank, count or match reason.
 */
export const ShellSearchResultRow = ({
  density = 'comfortable',
  linkProps,
  presentation,
  query,
  result,
  ResultLink,
}: ShellSearchResultRowProps) => {
  const { t } = useModernI18n();
  const badges = shellSearchResultBadges(result);
  const context = [presentation?.typeLabel, presentation?.subtitle].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return (
    <li data-shell-search-result={shellSearchResultKey(result)}>
      <ResultLink
        {...shellSearchResultTarget(result)}
        {...linkProps}
        className={`${linkClassName} ${linkPaddingClassName[density]}`}
      >
        <span className="grid min-w-0 gap-50">
          <span className={titleClassName[density]}>
            <Title query={query} title={result.title} />
          </span>
          {context.length === 0 ? null : (
            <span className="truncate text-fg-secondary text-xs">{context.join(' · ')}</span>
          )}
        </span>
        {badges.length === 0 ? null : (
          <span className="flex flex-wrap gap-100 sm:justify-end">
            {badges.map((badge) => (
              <Badge key={badge.key} size="sm" variant={badge.tone}>
                {t(badge.labelKey)}
              </Badge>
            ))}
          </span>
        )}
      </ResultLink>
    </li>
  );
};
