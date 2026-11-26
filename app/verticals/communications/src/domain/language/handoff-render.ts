import type { Result } from 'effect';
import type { TemplateContract } from '../catalog/template-contract.ts';
import { renderMessage } from './interpolation.ts';
import type { PlaceholderContract, RenderedMessage, RenderRefusal } from './interpolation.ts';
import type { LinkPolicy } from './links.ts';
import type { GenericValue } from './values.ts';
import type { SupportedLanguage } from './vocabulary.ts';

/** A link is only ever approved against an origin the owner listed: a type that lists none approves no link at all. */
const NO_LINKS: LinkPolicy = { allowedOrigins: [] };

/** The approved text of a pinned revision with the placeholder names it declares. */
interface PinnedRevisionText {
  readonly body: string;
  readonly optionalPlaceholders: readonly string[];
  readonly requiredPlaceholders: readonly string[];
  readonly subject: string;
}

interface HandoffRenderInput {
  /** The template contract of the approved message type the pinned revision belongs to. */
  readonly contract: TemplateContract;
  readonly language: SupportedLanguage;
  readonly revision: PinnedRevisionText;
  /**
   * The owner-published values for the revision's generic placeholders. A secret-bearing value is never one of them: the
   * owner fills those slots itself. No owner publishes values to Communications yet, so the last stoppable handoff passes none
   * and a revision with a required generic placeholder stops with `required_value_missing` instead of sending half a message.
   */
  readonly values?: Readonly<Record<string, GenericValue>>;
}

/**
 * The safe interpolation of the pinned revision against the type's contract at the last stoppable handoff (#1399 D.5-D.7,
 * AC-05/06/08): required values are validated, every value is formatted and escaped, a link is approved against the owner's
 * link policy of the type, a secret slot is left for its owner, and a message that cannot be rendered safely stops here with
 * a distinct closed reason. It only validates: the Messaging Adapter renders the same pinned revision and no other.
 */
export const renderPinnedRevision = (input: HandoffRenderInput): Result.Result<RenderedMessage, RenderRefusal> => {
  const declared = new Set([...input.revision.requiredPlaceholders, ...input.revision.optionalPlaceholders]);
  const contract: readonly PlaceholderContract[] = input.contract.placeholders.flatMap(({ kind, name, omission }) => {
    if (!declared.has(name)) {
      return [];
    }
    return [omission === undefined ? { kind, name } : { kind, name, omission }];
  });
  return renderMessage({
    contract,
    language: input.language,
    linkPolicy: input.contract.linkPolicy ?? NO_LINKS,
    template: input.revision,
    values: input.values ?? {},
  });
};
