import { Option } from 'effect';

import { TemplateRevisionIdSchema, TemplateTypeIdSchema } from '../../../shared/template-revision.ts';
import type { TemplateIdentity } from '../../../shared/template-revision.ts';
import { PORTAL_AUTH_DEFAULT_COPY_VERSION, portalAuthDefaultCopy } from './portal-auth-copy-draft.ts';

/**
 * The built-in default texts as code-versioned Template Revisions (#1398, #1406): the last step of template resolution
 * for an identity the Tenant never took over. A built-in text has no row, no creator and no activation: it was approved
 * by the product owner, not by a Tenant user, so nothing here names a principal. Its identifiers are derived from its
 * content digest, so the same text always pins the same reference and any changed word is a different one.
 *
 * Not a template registry (see the gray-area note in `portal-auth-copy-draft.ts`): the set is fixed in code.
 */
export interface BuiltInTemplateDefault {
  readonly body: string;
  readonly contentDigest: string;
  readonly language: TemplateIdentity['language'];
  readonly messageType: string;
  readonly optionalPlaceholders: readonly string[];
  readonly requiredPlaceholders: readonly string[];
  readonly revisionId: typeof TemplateRevisionIdSchema.Type;
  readonly subject: string;
  readonly templateTypeId: typeof TemplateTypeIdSchema.Type;
  /** The catalog version of the wording; it is what a pin of this text records as its revision number. */
  readonly version: number;
}

/** A UUID v8 (RFC 9562, custom) over 32 hex digits of the digest: version nibble 8, variant bits 10. */
const uuidOf = (hex: string) => {
  const variant = ((Number.parseInt(hex.charAt(16), 16) % 4) + 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const builtInDefaults: readonly BuiltInTemplateDefault[] = portalAuthDefaultCopy.map((copy) => ({
  body: copy.body,
  contentDigest: copy.contentDigest,
  language: copy.language,
  messageType: copy.messageType,
  optionalPlaceholders: [],
  requiredPlaceholders: [copy.ownerRenderedSlot],
  revisionId: TemplateRevisionIdSchema.make(uuidOf(copy.contentDigest.slice(0, 32))),
  subject: copy.subject,
  templateTypeId: TemplateTypeIdSchema.make(uuidOf(copy.contentDigest.slice(32, 64))),
  version: PORTAL_AUTH_DEFAULT_COPY_VERSION,
}));

/** The built-in default of exactly this message type, channel and language, if one exists. Scope does not choose it. */
export const builtInTemplateDefaultOf = (identity: Pick<TemplateIdentity, 'channel' | 'language' | 'messageType'>) =>
  Option.fromNullishOr(
    builtInDefaults.find(
      (candidate) =>
        identity.channel === 'email' &&
        candidate.messageType === identity.messageType &&
        candidate.language === identity.language,
    ),
  );

/** Every built-in default, Czech first per message type. */
export const allBuiltInTemplateDefaults = (): readonly BuiltInTemplateDefault[] => builtInDefaults;
