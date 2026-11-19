import { Match, Result, Schema } from 'effect';
import { escapeHtml, unescapeHtml } from './escape.ts';
import { approveLink } from './links.ts';
import type { LinkPolicy } from './links.ts';
import { formatDate, formatMoney, safeText } from './values.ts';
import type { GenericValue } from './values.ts';
import type { SupportedLanguage } from './vocabulary.ts';

/**
 * Safe substitution of owner-published business values into one approved Template Revision (#1399 scope 5-8). Pure and
 * deterministic: it validates, formats for presentation and escapes. It never computes a price, a tax or an exchange
 * rate, never invents a value, and never holds a secret.
 */

/**
 * What a declared placeholder accepts. `owner-rendered` is the secret-bearing kind (OTP, reset or claim URL): the generic
 * path refuses any value for it and leaves its slot untouched, so the owner completes it under its own authority.
 */
const OWNER_RENDERED = 'owner-rendered' as const;
export const PlaceholderKindSchema = Schema.Literals(['date', 'link', 'money', OWNER_RENDERED, 'text']);
export type PlaceholderKind = typeof PlaceholderKindSchema.Type;
export interface PlaceholderContract {
  readonly kind: PlaceholderKind;
  readonly name: string;
  /**
   * The approved rule that lets an optional placeholder be left out: the whole paragraph that uses it is dropped, so no
   * half-sentence or empty claim remains. An optional placeholder without this rule must have a value.
   */
  readonly omission?: 'omit-paragraph';
}

/** The text an approved revision carries, with the placeholder names it declares. */
export interface RenderTemplate {
  readonly body: string;
  readonly optionalPlaceholders: readonly string[];
  readonly requiredPlaceholders: readonly string[];
  readonly subject: string;
}

export interface RenderInput {
  readonly contract: readonly PlaceholderContract[];
  readonly language: SupportedLanguage;
  readonly linkPolicy: LinkPolicy;
  readonly template: RenderTemplate;
  readonly values: Readonly<Record<string, GenericValue>>;
}

export const RENDER_REFUSAL_CODES = [
  // the contract does not match what the revision declares, or the text uses a name it does not declare
  'contract_mismatch',
  'content_not_equivalent',
  'link_not_permitted',
  'optional_omission_not_approved',
  'rendered_content_empty',
  'required_value_missing',
  // a value was offered for a secret-bearing placeholder: the generic path never takes one
  'secret_value_in_generic_path',
  'value_kind_mismatch',
  'value_malformed',
  'value_not_declared',
] as const;
export type RenderRefusalCode = (typeof RENDER_REFUSAL_CODES)[number];

/** A refusal names placeholders, never a value: it can be logged and stored without carrying owner data. */
export interface RenderRefusal {
  readonly code: RenderRefusalCode;
  readonly placeholders: readonly string[];
}

export interface RenderedMessage {
  /** One block per paragraph, with every value escaped; meaning-equivalent to `text`. */
  readonly html: string;
  /** Names of owner-rendered slots left in the text and html for the owner to complete. */
  readonly ownerSlots: readonly string[];
  readonly subject: string;
  readonly text: string;
}

const OMISSION_NOT_APPROVED = 'optional_omission_not_approved' as const satisfies RenderRefusalCode;
const slot = /\{\{\s*(?<name>[a-z][a-z0-9_]*)\s*\}\}/gu;
const refuse = (code: RenderRefusalCode, placeholders: readonly string[] = []) =>
  Result.fail<RenderRefusal>({ code, placeholders });
const namesIn = (text: string) => [...text.matchAll(slot)].map((match) => match.groups?.['name'] ?? '');

interface Shown {
  readonly html: string;
  readonly text: string;
}

const present = (
  contract: PlaceholderContract,
  value: GenericValue,
  input: RenderInput,
): Result.Result<Shown, RenderRefusal> => {
  const failure = (code: RenderRefusalCode) => refuse(code, [contract.name]);
  const plain = (shown: Result.Result<string, unknown>): Result.Result<Shown, RenderRefusal> =>
    Result.isSuccess(shown)
      ? Result.succeed({ html: escapeHtml(shown.success), text: shown.success })
      : failure('value_malformed');
  if (value.kind !== contract.kind) {
    return failure('value_kind_mismatch');
  }
  return Match.value(value).pipe(
    Match.discriminatorsExhaustive('kind')({
      date: (date) => plain(formatDate(date.value, input.language)),
      link: (link) => {
        const approved = approveLink(link.url, input.linkPolicy);
        return Result.isSuccess(approved)
          ? Result.succeed({
              html: `<a href="${escapeHtml(approved.success)}">${escapeHtml(approved.success)}</a>`,
              text: approved.success,
            })
          : failure('link_not_permitted');
      },
      money: (money) => plain(formatMoney(money.amount, money.currency, input.language)),
      text: (plainText) => plain(safeText(plainText.value)),
    }),
  );
};

/** The text of an HTML block of this renderer: tags removed, entities restored, `<br>` as a line break. */
export const htmlToPlainText = (html: string): string =>
  html
    .split('\n')
    .map((block) =>
      unescapeHtml(
        block
          .replace(/^<p>/u, '')
          .replace(/<\/p>$/u, '')
          .replaceAll('<br>', '\n')
          .replaceAll(/<a href="[^"]*">(?<label>[^<]*)<\/a>/gu, '$<label>'),
      ),
    )
    .join('\n\n');

/**
 * Renders subject, plain text and HTML of one revision. Everything that could mislead stops the message instead: a
 * missing or malformed required value, an optional value with no approved omission rule, a link outside the owner's
 * policy, a value for a secret-bearing placeholder, or a value the revision never declared.
 */
export const renderMessage = (input: RenderInput): Result.Result<RenderedMessage, RenderRefusal> => {
  const { contract, template, values } = input;
  const declared = new Set([...template.requiredPlaceholders, ...template.optionalPlaceholders]);
  const required = new Set(template.requiredPlaceholders);
  const byName = new Map(contract.map((entry) => [entry.name, entry] as const));
  const contractSound =
    byName.size === contract.length &&
    byName.size === declared.size &&
    contract.every(
      (entry) =>
        declared.has(entry.name) &&
        (entry.omission === undefined || (!required.has(entry.name) && entry.kind !== OWNER_RENDERED)),
    );
  const used = new Set([...namesIn(template.subject), ...namesIn(template.body)]);
  const undeclared = [...used].filter((name) => !declared.has(name));
  if (!contractSound || undeclared.length > 0) {
    return refuse(
      'contract_mismatch',
      [...new Set([...undeclared, ...contract.map((entry) => entry.name)])].toSorted(),
    );
  }
  const extra = Object.keys(values).filter((name) => !declared.has(name));
  if (extra.length > 0) {
    return refuse('value_not_declared', extra.toSorted());
  }
  const secret = Object.keys(values).filter((name) => byName.get(name)?.kind === OWNER_RENDERED);
  if (secret.length > 0) {
    return refuse('secret_value_in_generic_path', secret.toSorted());
  }

  const shown = new Map<string, Shown>();
  const omitted = new Set<string>();
  for (const entry of contract.filter((candidate) => candidate.kind !== OWNER_RENDERED)) {
    const value = values[entry.name];
    if (value !== undefined) {
      const presented = present(entry, value, input);
      if (Result.isFailure(presented)) {
        return Result.fail(presented.failure);
      }
      shown.set(entry.name, presented.success);
    } else if (required.has(entry.name)) {
      return refuse('required_value_missing', [entry.name]);
    } else if (entry.omission === undefined) {
      return refuse(OMISSION_NOT_APPROVED, [entry.name]);
    } else {
      omitted.add(entry.name);
    }
  }

  if (namesIn(template.subject).some((name) => omitted.has(name))) {
    // a subject has no paragraph to drop: leaving a value out of it would leave a broken or misleading line
    return refuse(
      OMISSION_NOT_APPROVED,
      namesIn(template.subject).filter((name) => omitted.has(name)),
    );
  }
  const fill = (text: string, as: keyof Shown) =>
    text.replaceAll(slot, (token, name: string) => shown.get(name)?.[as] ?? token.replaceAll(/\s+/gu, ''));
  const subject = fill(template.subject, 'text');
  if (/[\r\n]/u.test(subject)) {
    return refuse('value_malformed');
  }
  const paragraphs = template.body
    .replaceAll('\r\n', '\n')
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0 && !namesIn(paragraph).some((name) => omitted.has(name)));
  if (paragraphs.length === 0) {
    return refuse('rendered_content_empty');
  }
  // The template text is approved copy but is escaped like any value: only this renderer adds markup.
  const htmlLine = (line: string) => {
    const segments = line.split(slot);
    // split with a capture group alternates literal text and placeholder names
    return segments
      .map((segment, index) => (index % 2 === 0 ? escapeHtml(segment) : (shown.get(segment)?.html ?? `{{${segment}}}`)))
      .join('');
  };
  const text = paragraphs.map((paragraph) => fill(paragraph, 'text')).join('\n\n');
  const html = paragraphs.map((paragraph) => `<p>${paragraph.split('\n').map(htmlLine).join('<br>')}</p>`).join('\n');
  if (htmlToPlainText(html) !== text) {
    return refuse('content_not_equivalent');
  }
  const ownerSlots = [...new Set([...namesIn(template.subject), ...paragraphs.flatMap(namesIn)])]
    .filter((name) => byName.get(name)?.kind === OWNER_RENDERED)
    .toSorted();
  return Result.succeed({ html, ownerSlots, subject, text });
};
