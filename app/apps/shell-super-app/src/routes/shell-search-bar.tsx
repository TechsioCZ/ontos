import type { Link as LocalizedLink } from '@modern-js/plugin-i18n/runtime';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { SearchForm } from '@techsio/ui-kit/molecules/search-form';
import { useEffect, useId, useRef, useState } from 'react';
import type {
  ComponentProps,
  ComponentType,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type { ShellSearchSuggestion, ShellSearchSuggestionsState } from './shell-search-suggestions.ts';

type SuggestionLinkProps = ComponentProps<typeof LocalizedLink>;

export interface ShellSearchBarProps {
  readonly onDismissSuggestions: () => void;
  readonly onSearch: (query: string) => void;
  readonly onValueChange: (value: string) => void;
  /** The Shell's route link, so a suggestion opens like any other Shell destination. */
  readonly SuggestionLink: ComponentType<SuggestionLinkProps>;
  readonly suggestions: ShellSearchSuggestionsState;
  readonly value: string;
}

/** "/" or Ctrl/⌘+K focuses the search unless the person is already typing into a field. */
const isFocusShortcut = (event: KeyboardEvent): boolean => {
  if (event.defaultPrevented || event.altKey) {
    return false;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    return true;
  }
  if (event.key !== '/' || event.ctrlKey || event.metaKey) {
    return false;
  }
  const active = document.activeElement;
  return active === null || active.closest('input, textarea, select, [contenteditable]') === null;
};

/** A press keeps focus in the field (Safari never focuses a clicked link), so the list stays until the click lands. */
const keepFieldFocus = (event: { readonly preventDefault: () => void }) => {
  event.preventDefault();
};

const SuggestionRow = ({
  onBlur,
  onKeyDown,
  onOpen,
  suggestion,
  SuggestionLink,
}: {
  readonly onBlur: (event: ReactFocusEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly onOpen: () => void;
  readonly suggestion: ShellSearchSuggestion;
  readonly SuggestionLink: ComponentType<SuggestionLinkProps>;
}) => {
  const { t } = useModernI18n();
  return (
    <li>
      <SuggestionLink
        className="flex items-center justify-between gap-200 rounded-md px-200 py-150 text-fg-primary no-underline outline-none hover:bg-overlay focus-visible:bg-overlay"
        data-search-suggestion=""
        onBlur={onBlur}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        onMouseDown={keepFieldFocus}
        params={{
          moduleId: suggestion.ref.moduleId,
          resourceId: suggestion.ref.resourceId,
          resourceType: suggestion.ref.resourceType,
        }}
        to="/resources/$moduleId/$resourceType/$resourceId"
      >
        <span className="min-w-0 truncate">{suggestion.title}</span>
        <span className="flex shrink-0 gap-100">
          {suggestion.roles.map((role) => (
            <Badge key={role} size="sm" variant="info">
              {t(`shell.search.roles.${role}`)}
            </Badge>
          ))}
          {suggestion.archived ? (
            <Badge size="sm" variant="warning">
              {t('shell.search.archived')}
            </Badge>
          ) : null}
        </span>
      </SuggestionLink>
    </li>
  );
};

const suggestionStatus = (suggestions: ShellSearchSuggestionsState): 'empty' | 'loading' | 'none' | 'unavailable' => {
  if (suggestions.status === 'loading' || suggestions.status === 'unavailable') {
    return suggestions.status;
  }
  return suggestions.status === 'ready' && suggestions.groups.length === 0 ? 'empty' : 'none';
};

/**
 * The Shell's global search: one wide controlled field centred in the top bar with the first matches below it as
 * ordinary links. Arrow keys move between the field and the matches, Escape closes them, and Enter in the field
 * opens the full results page.
 */
export const ShellSearchBar = ({
  onDismissSuggestions,
  onSearch,
  onValueChange,
  SuggestionLink,
  suggestions,
  value,
}: ShellSearchBarProps) => {
  const { t } = useModernI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (isFocusShortcut(event)) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, []);

  const open = focused && suggestions.status !== 'idle';
  const status = suggestionStatus(suggestions);
  const suggestionLinks = (): HTMLElement[] => [
    ...(rootRef.current?.querySelectorAll<HTMLElement>('[data-search-suggestion]') ?? []),
  ];

  const handleBlur = (event: ReactFocusEvent<HTMLElement>) => {
    if (rootRef.current?.contains(event.relatedTarget) !== true) {
      setFocused(false);
    }
  };

  const handleSubmit = () => {
    const query = value.trim();
    if (query.length > 0) {
      onDismissSuggestions();
      onSearch(query);
    }
  };

  const returnToField = () => {
    inputRef.current?.focus();
  };

  const handleFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && open) {
      const [first] = suggestionLinks();
      if (first !== undefined) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      onDismissSuggestions();
    }
  };

  const handleSuggestionKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const links = suggestionLinks();
    const index = links.indexOf(event.currentTarget);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = links[index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next === undefined) {
        returnToField();
      } else {
        next.focus();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      returnToField();
      onDismissSuggestions();
    }
  };

  return (
    <div className="relative w-full" ref={rootRef}>
      <SearchForm className="w-full" gapped onSubmit={handleSubmit} onValueChange={onValueChange} value={value}>
        <SearchForm.Control className="relative">
          <Icon
            aria-hidden
            className="pointer-events-none absolute start-150 top-1/2 z-20 -translate-y-1/2 text-fg-secondary"
            icon="token-icon-search"
            size="sm"
          />
          <SearchForm.Input
            aria-controls={panelId}
            aria-expanded={open}
            aria-keyshortcuts="/ Control+K Meta+K"
            aria-label={t('shell.search.label')}
            autoComplete="off"
            className="ps-500"
            enterKeyHint="search"
            onBlur={handleBlur}
            onFocus={() => setFocused(true)}
            onKeyDown={handleFieldKeyDown}
            placeholder={t('shell.search.placeholder')}
            ref={inputRef}
          />
          <SearchForm.ClearButton aria-label={t('shell.search.clear')} onBlur={handleBlur} />
        </SearchForm.Control>
      </SearchForm>
      <section
        aria-label={t('shell.search.suggestions.label')}
        className={`popup-surface-base absolute inset-x-0 top-full z-30 mt-100 grid max-h-96 gap-100 overflow-y-auto p-150 ${open ? '' : 'hidden'}`}
        id={panelId}
      >
        <div aria-live="polite">
          {status === 'loading' ? (
            <StatusText status="default">{t('shell.search.suggestions.loading')}</StatusText>
          ) : null}
          {status === 'unavailable' ? (
            <StatusText showIcon status="error">
              {t('shell.search.unavailable')}
            </StatusText>
          ) : null}
          {status === 'empty' && suggestions.status === 'ready' ? (
            <StatusText status="default">
              {t('shell.search.suggestions.empty', { query: suggestions.query })}
            </StatusText>
          ) : null}
        </div>
        {suggestions.status === 'ready'
          ? suggestions.groups.map((group) => (
              <div className="grid gap-50" key={group.key}>
                <h2 className="px-200 font-medium text-fg-secondary text-xs uppercase" id={`${panelId}-${group.key}`}>
                  {t(`shell.search.groups.${group.key}`)}
                </h2>
                <ul aria-labelledby={`${panelId}-${group.key}`} className="grid gap-50">
                  {group.suggestions.map((suggestion) => (
                    <SuggestionRow
                      key={suggestion.key}
                      onBlur={handleBlur}
                      onKeyDown={handleSuggestionKeyDown}
                      onOpen={onDismissSuggestions}
                      suggestion={suggestion}
                      SuggestionLink={SuggestionLink}
                    />
                  ))}
                </ul>
              </div>
            ))
          : null}
        {suggestions.status === 'ready' && suggestions.partial ? (
          <StatusText showIcon status="warning">
            {t('shell.search.partial')}
          </StatusText>
        ) : null}
        {suggestions.status === 'ready' && suggestions.groups.length > 0 ? (
          <Button
            block
            onBlur={handleBlur}
            onClick={handleSubmit}
            onMouseDown={keepFieldFocus}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            {t('shell.search.suggestions.all', { query: suggestions.query })}
          </Button>
        ) : null}
      </section>
    </div>
  );
};
