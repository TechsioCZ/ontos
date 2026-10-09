/**
 * The one normalization every Commerce portal authentication path applies to an address before it
 * becomes a stored value, a durable key or a predicate: the enrollment intent key, the sign-in and
 * recovery rate-limit keys, the audit subject digest, the provider `user.email` column and the
 * owner's existence probes all agree on this form. A path that compares or keys on the caller's raw
 * casing silently disagrees with every other one — the duplicate guard stops seeing the account it
 * is guarding, the budget key splits into one bucket per spelling.
 */
export const normalizeCommercePortalAuthEmail = (email: string): string => email.trim().toLowerCase();
