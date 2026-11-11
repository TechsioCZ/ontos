import { Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { useEffect, useId, useLayoutEffect, useState } from 'react';

/**
 * The browser tab of a page names what the page shows. The Shell's frame renders the document title (`<name> | OntOS`)
 * from the current navigation destination; a page that shows one record, such as a customer or an order, gives the
 * frame the record's name instead with `<DocumentTitle title={name} />`.
 *
 * Every federated module bundles its own copy of this package, so a page and the frame meet on a window event, like
 * the Shell's other page-to-frame signals, and not on a React context of one copy.
 */
const documentTitleEvent = 'ontos:document-title';

/** A page gives its title (`title`) or takes it back (no `title`); `owner` tells pages apart. */
const DocumentTitleChangeSchema = Schema.Struct({
  owner: Schema.String,
  title: Schema.optional(Schema.String),
});
type DocumentTitleChange = typeof DocumentTitleChangeSchema.Type;
const decodeChange = Schema.decodeUnknownOption(DocumentTitleChangeSchema);

const announce = (change: DocumentTitleChange): void => {
  globalThis.dispatchEvent(new CustomEvent(documentTitleEvent, { detail: change }));
};

interface OwnedTitle {
  readonly owner: string;
  readonly title: string;
}

const settle = (previous: OwnedTitle | undefined, change: DocumentTitleChange): OwnedTitle | undefined => {
  if (change.title !== undefined) {
    return previous?.owner === change.owner && previous.title === change.title
      ? previous
      : { owner: change.owner, title: change.title };
  }
  return previous?.owner === change.owner ? undefined : previous;
};

/**
 * The frame's side: the title a page gives, or `undefined` while none does. The last page to give a title wins; a page
 * that leaves takes back only its own title. The frame listens from its layout effect, which runs before the effects
 * of the pages it renders, so a page's first title is not missed.
 */
export const useDocumentTitle = (): string | undefined => {
  const [current, setCurrent] = useState<OwnedTitle | undefined>();
  useLayoutEffect(() => {
    const apply = (change: DocumentTitleChange) => {
      setCurrent((previous) => settle(previous, change));
    };
    const receive = (event: Event) => {
      Option.match(decodeChange('detail' in event ? event.detail : undefined), { onNone: constVoid, onSome: apply });
    };
    globalThis.addEventListener(documentTitleEvent, receive);
    return () => {
      globalThis.removeEventListener(documentTitleEvent, receive);
    };
  }, []);
  return current?.title;
};

/**
 * Names the browser tab after the record the page shows, in the Shell's title format. Nothing changes while the name
 * is missing or blank, or outside the Shell's frame; once the page is left, the frame's own title shows again.
 */
export const DocumentTitle = ({ title }: { readonly title: string | null | undefined }): null => {
  const owner = useId();
  const shown = title?.trim() ?? '';
  useEffect(() => {
    if (shown === '') {
      return constVoid;
    }
    announce({ owner, title: shown });
    return () => {
      announce({ owner });
    };
  }, [owner, shown]);
  return null;
};
