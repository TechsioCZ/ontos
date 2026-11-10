import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Helmet } from '@modern-js/runtime/head';
import { constVoid } from 'effect/Function';
import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

export interface UltramodernRouteHeadProps {
  /** Locale key of the page title, e.g. `party-registry.pages.customers.title`. */
  readonly titleKey: string;
}

/** Sets the document title from the page's own locale key, so the browser tab reads in Czech. */
export const UltramodernRouteHead = ({ titleKey }: UltramodernRouteHeadProps): ReactElement => {
  const { language, t } = useModernI18n();
  return (
    <Helmet htmlAttributes={{ lang: language ?? 'cs' }}>
      <title>{t(titleKey)}</title>
      <meta content="noindex, nofollow" name="robots" />
    </Helmet>
  );
};

/** The Shell's title format, so a record's tab reads like every other page. */
const shellTitle = (name: string) => `${name} | OntOS`;

/**
 * Names the browser tab after the record a detail page shows. The browser shows the first title of the document, and
 * the Shell's frame renders its own title with the page (React inserts each new title first). This one is kept first
 * while it is shown, so the tab reads the record's name whatever renders after it; once it is gone, the Shell's title
 * shows again. Nothing is rendered while the record has no name.
 */
export const RecordRouteTitle = ({ name }: { readonly name: string | null | undefined }): ReactElement | null => {
  const element = useRef<HTMLTitleElement>(null);
  const shown = name !== null && name !== undefined && name.trim() !== '';
  useEffect(() => {
    const title = element.current;
    if (!shown || title === null) {
      return constVoid;
    }
    const { head } = title.ownerDocument;
    const keepFirst = () => {
      const first = head.querySelector('title');
      if (first === null) {
        head.append(title);
      } else if (first !== title) {
        first.before(title);
      }
    };
    keepFirst();
    const observer = new MutationObserver(keepFirst);
    observer.observe(head, { childList: true });
    return () => {
      observer.disconnect();
    };
  }, [shown]);
  return shown ? <title ref={element}>{shellTitle(name.trim())}</title> : null;
};
