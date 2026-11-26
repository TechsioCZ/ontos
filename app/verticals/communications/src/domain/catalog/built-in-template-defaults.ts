import type { TemplateIdentity } from '../../../shared/template-revision.ts';
import { PORTAL_AUTH_DEFAULT_COPY_VERSION, portalAuthDefaultCopy } from './portal-auth-copy-draft.ts';

/**
 * The seed texts an administrator MAY prepare and activate as an own Template Revision (#1398, #1406, R-D1). A seed text
 * is NEVER used by itself: template resolution knows only revisions an authorised administrator prepared AND activated,
 * so an untouched Tenant has no text for the three Portal Auth types (tenant mode B and TPL-05 then apply) and nothing
 * here is a shared or global registry. The set is fixed in code and only feeds the review Read and the review script.
 */
export interface BuiltInTemplateDefault {
  readonly body: string;
  readonly contentDigest: string;
  readonly language: TemplateIdentity['language'];
  readonly messageType: string;
  readonly optionalPlaceholders: readonly string[];
  readonly requiredPlaceholders: readonly string[];
  readonly subject: string;
  /** The catalog version of the wording. */
  readonly version: number;
}

const seedTexts: readonly BuiltInTemplateDefault[] = portalAuthDefaultCopy.map((copy) => ({
  body: copy.body,
  contentDigest: copy.contentDigest,
  language: copy.language,
  messageType: copy.messageType,
  optionalPlaceholders: [],
  requiredPlaceholders: [copy.ownerRenderedSlot],
  subject: copy.subject,
  version: PORTAL_AUTH_DEFAULT_COPY_VERSION,
}));

/** Every seed text, Czech first per message type. */
export const allBuiltInTemplateDefaults = (): readonly BuiltInTemplateDefault[] => seedTexts;
