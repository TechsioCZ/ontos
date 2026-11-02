import { Console, Effect, Schema } from 'effect';

import { technicalIdentifiersInText } from '../../packages/admin-ui/src/visible-text.ts';

export class StageVisibleIdentifierError extends Schema.TaggedError<StageVisibleIdentifierError>()(
  'StageVisibleIdentifierError',
  { destination: Schema.String, identifiers: Schema.Array(Schema.String) },
) {}

/**
 * Runs inside the page: the document title, rendered text, visible accessible labels and field values.
 * Link targets, React keys, DOM ids and data attributes are not user-visible and are not read.
 */
export const renderedPageText = (): string => {
  const parts = [document.title];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.checkVisibility({ visibilityProperty: true }) === true) {
      parts.push(node.textContent ?? '');
    }
  }
  for (const element of document.querySelectorAll('[title], [aria-label]')) {
    if (element.checkVisibility({ visibilityProperty: true })) {
      parts.push(element.getAttribute('title') ?? '', element.getAttribute('aria-label') ?? '');
    }
  }
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input:not([type="hidden"], [type="checkbox"], [type="radio"], [type="password"]), textarea',
  );
  for (const field of fields) {
    if (field.checkVisibility({ visibilityProperty: true })) {
      parts.push(field.value);
    }
  }
  return parts.join('\n');
};

/** Fails the stage gate when a rendered screen shows a UUID, internal key or digest. */
export const checkStageVisibleText = (destination: string, text: string) => {
  const identifiers = technicalIdentifiersInText(text);
  return identifiers.length === 0
    ? Effect.void
    : Console.error(`::error title=Visible technical identifier::${destination} shows ${identifiers.join(', ')}`).pipe(
        Effect.andThen(Effect.fail(new StageVisibleIdentifierError({ destination, identifiers }))),
      );
};
