import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { SearchForm } from '@techsio/ui-kit/molecules/search-form';
import { useEffect, useRef } from 'react';

export interface ShellSearchBarProps {
  readonly onSearch: (query: string) => void;
  readonly onValueChange: (value: string) => void;
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

/** The Shell's global search: one wide controlled field centred in the top bar; Enter submits. */
export const ShellSearchBar = ({ onSearch, onValueChange, value }: ShellSearchBarProps) => {
  const { t } = useModernI18n();
  const inputRef = useRef<HTMLInputElement>(null);

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

  return (
    <SearchForm
      className="w-full"
      gapped
      onSubmit={() => {
        const query = value.trim();
        if (query.length > 0) {
          onSearch(query);
        }
      }}
      onValueChange={onValueChange}
      value={value}
    >
      <SearchForm.Control className="relative">
        <Icon
          aria-hidden
          className="pointer-events-none absolute start-150 top-1/2 z-20 -translate-y-1/2 text-fg-secondary"
          icon="token-icon-search"
          size="sm"
        />
        <SearchForm.Input
          aria-keyshortcuts="/ Control+K Meta+K"
          aria-label={t('shell.search.label')}
          autoComplete="off"
          className="ps-500"
          enterKeyHint="search"
          placeholder={t('shell.search.placeholder')}
          ref={inputRef}
        />
        <SearchForm.ClearButton aria-label={t('shell.search.clear')} />
      </SearchForm.Control>
    </SearchForm>
  );
};
