import { Context, Effect, Layer } from 'effect';

import type { RecipientLanguageContext } from '../language/vocabulary.ts';
import type { OriginalRecipientBinding } from '../recipient/original-binding.ts';

/**
 * Where the TRUSTED recipient or flow language comes from. A source locale is only a hint of the source owner and is not
 * an input; only an owner authority for the recipient's language is. No owner publishes one yet (the trusted-locale
 * source is an open input gate of the Auth owner), so the production composition establishes none and the language is
 * the platform default and fallback `cs`. Nothing is inferred from an address, an IP address, a host or an e-mail domain.
 */
export interface RecipientLanguageAuthorityService {
  readonly languageOf: (binding: OriginalRecipientBinding) => Effect.Effect<RecipientLanguageContext>;
}

export class RecipientLanguageAuthority extends Context.Service<
  RecipientLanguageAuthority,
  RecipientLanguageAuthorityService
>()('@app/communications/domain/intake/recipient-language/RecipientLanguageAuthority') {}

export const notEstablishedRecipientLanguageLayer = Layer.succeed(RecipientLanguageAuthority, {
  languageOf: () => Effect.succeed<RecipientLanguageContext>({ kind: 'not-established' }),
});
