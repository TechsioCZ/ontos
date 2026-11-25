import { Schema } from 'effect';

import { TemplatePlaceholderNameSchema } from '../../../shared/template-revision.ts';

/**
 * What an approved Transactional Message Type tells its Template Revisions (#1398 D.3 "před aktivací je známá
 * slučitelnost s typem zprávy", #1399 L-08): the complete set of placeholders a revision of the type may use, which of
 * them it must carry, what each accepts, and the owner's link policy. It is data of the approved type, never message
 * copy, and it holds names and rules only, never a value or a secret.
 */

/**
 * What a declared placeholder accepts. `owner-rendered` is the secret-bearing kind (OTP, reset or claim URL): the generic
 * path refuses any value for it and leaves its slot untouched, so the owner completes it under its own authority.
 */
const PlaceholderKindSchema = Schema.Literals(['date', 'link', 'money', 'owner-rendered', 'text']);
export type PlaceholderKind = typeof PlaceholderKindSchema.Type;

const TemplatePlaceholderContractSchema = Schema.Struct({
  kind: PlaceholderKindSchema,
  name: TemplatePlaceholderNameSchema,
  /**
   * The approved rule that lets an optional placeholder be left out: the whole paragraph that uses it is dropped. An
   * optional placeholder without this rule must have a value. Never valid for a required or owner-rendered placeholder.
   */
  omission: Schema.optionalKey(Schema.Literal('omit-paragraph')),
  /** A revision of the type MUST declare and use a required placeholder, or it cannot be activated. */
  required: Schema.Boolean,
});
type TemplatePlaceholderContract = typeof TemplatePlaceholderContractSchema.Type;

const httpsOrigin = Schema.makeFilter((origin: string) =>
  URL.canParse(origin) && new URL(origin).protocol === 'https:' && new URL(origin).origin === origin
    ? undefined
    : 'a link origin must be an exact https origin',
);

/** The owner's link policy: the exact HTTPS origins its links may point to and the only query parameters they may carry. */
const LinkPolicySchema = Schema.Struct({
  allowedOrigins: Schema.Array(Schema.String.check(httpsOrigin)),
  allowedQueryParameters: Schema.optionalKey(Schema.Array(Schema.String)),
});

const placeholderNamesAreUnique = Schema.makeFilter((placeholders: readonly TemplatePlaceholderContract[]) =>
  new Set(placeholders.map(({ name }) => name)).size === placeholders.length
    ? undefined
    : 'template placeholder names must be unique',
);
const placeholdersAreConsistent = Schema.makeFilter((placeholders: readonly TemplatePlaceholderContract[]) =>
  placeholders.every(
    ({ kind, omission, required }) => omission === undefined || (!required && kind !== 'owner-rendered'),
  )
    ? undefined
    : 'only an optional, non-secret placeholder may be omitted',
);

export const TemplateContractSchema = Schema.Struct({
  /** Absent means the type publishes no link, so a link value is never approved for it. */
  linkPolicy: Schema.optionalKey(LinkPolicySchema),
  placeholders: Schema.Array(TemplatePlaceholderContractSchema).check(
    placeholderNamesAreUnique,
    placeholdersAreConsistent,
  ),
});
export type TemplateContract = typeof TemplateContractSchema.Type;

const NO_PLACEHOLDERS: TemplateContract = { placeholders: [] };

/** The template contract of an approved type: absent is "no placeholder at all", so a type that declares nothing allows none. */
export const templateContractOf = (type: { readonly placeholderContract?: TemplateContract }): TemplateContract =>
  type.placeholderContract ?? NO_PLACEHOLDERS;
