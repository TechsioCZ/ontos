import type { ComponentProps, ReactElement, ReactNode } from 'react';

import { ultramodernLocalisedUrls } from '../../src/routes/ultramodern-route-metadata.ts';

/** Props the localised framework link receives from the pages under test. */
export type LocalizedLinkDoubleProps = Omit<ComponentProps<'a'>, 'href'> & {
  readonly children?: ReactNode;
  readonly href?: string | undefined;
  readonly params?: Readonly<Record<string, string>>;
  readonly to: string;
};

/** One canonical navigation target a page handed to the framework link. */
export interface LocalizedLinkCall {
  readonly href: string | undefined;
  readonly params: Readonly<Record<string, string>> | undefined;
  readonly to: string;
}

/**
 * Recording state supplied by a single test file. Each file owns its own
 * array and language holder, so navigation evidence never leaks between
 * suites.
 */
export interface LocalizedLinkRecording {
  readonly calls: LocalizedLinkCall[];
  readonly language: { readonly current: string };
}

const localisedUrlPatterns = new Map<string, Readonly<Record<string, string>>>(
  Object.entries(ultramodernLocalisedUrls).map(
    ([canonicalPattern, localisedPatterns]): readonly [string, Readonly<Record<string, string>>] => [
      canonicalPattern,
      { cs: localisedPatterns.cs, en: localisedPatterns.en },
    ],
  ),
);

/**
 * Resolves the destination the framework link would produce, using the
 * application's own canonical-to-localised route map instead of a hand-written
 * expectation, so the page is proven to hand over a language-agnostic target.
 */
const resolveLocalizedHref = (
  to: string,
  params: Readonly<Record<string, string>> | undefined,
  language: string,
): string => {
  const canonicalPattern = to.replaceAll('$', ':');
  const localisedPattern = localisedUrlPatterns.get(canonicalPattern)?.[language] ?? canonicalPattern;
  const segments = localisedPattern
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? encodeURIComponent(params?.[segment.slice(1)] ?? '') : segment));
  return `/${[language, ...segments].join('/')}`;
};

/**
 * Stands in for the localised framework link: it records the canonical target
 * the page handed over and renders the destination the framework would resolve
 * for the file's current language.
 */
export const renderLocalizedLinkDouble = (
  { children, href, params, to, ...anchorProps }: LocalizedLinkDoubleProps,
  recording: LocalizedLinkRecording,
): ReactElement => {
  recording.calls.push({ href, params, to });
  return (
    <a href={resolveLocalizedHref(to, params, recording.language.current)} {...anchorProps}>
      {children}
    </a>
  );
};
