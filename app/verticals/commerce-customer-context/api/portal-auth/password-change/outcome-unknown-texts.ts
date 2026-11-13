/**
 * What the customer is told when the provider has not answered in time: the change may still complete. Czech and
 * English, chosen by the request's `Accept-Language` (Czech when it names neither).
 */
const TEXTS = {
  cs: {
    detail:
      'Zatím nevíme, zda se heslo změnilo; změna se může ještě dokončit. Než to zkusíte znovu, zkuste se přihlásit novým heslem.',
    title: 'Změna hesla se možná ještě dokončí',
  },
  en: {
    detail:
      'We do not know yet whether the password was changed; the change may still complete. Before trying again, try signing in with the new password.',
    title: 'The password change may still complete',
  },
} as const;

export type OutcomeUnknownLanguage = keyof typeof TEXTS;

/** The first of Czech or English the request prefers, in the order it lists them; Czech when it names neither. */
export const outcomeUnknownLanguageOf = (headers: Headers): OutcomeUnknownLanguage => {
  const preferred = (headers.get('accept-language') ?? '')
    .split(',')
    .map((entry) => entry.trim().split(';')[0]?.toLowerCase() ?? '')
    .find((tag) => tag.startsWith('cs') || tag.startsWith('en'));
  return preferred?.startsWith('en') === true ? 'en' : 'cs';
};

export const outcomeUnknownTexts = (language: OutcomeUnknownLanguage) => TEXTS[language];
