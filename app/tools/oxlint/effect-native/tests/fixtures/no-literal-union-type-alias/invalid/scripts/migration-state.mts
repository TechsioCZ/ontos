// expect-count: 2
export type ContactsJournalState = 'ambiguous' | 'contacts' | 'fresh' | 'legacy';

// an expression-free template literal member is still a closed literal.
type Channel = `email` | `sms`;

export const state: ContactsJournalState = 'fresh';
export const channel: Channel = 'sms';
