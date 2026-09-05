// RFC 6265 cookie attribute names are case-insensitive and browsers accept them lowercase, so
// lowercasing the attribute list evades the case-sensitive matcher entirely.
export const clearCookie = (name: string): string =>
  `${name}=; path=/; httponly; samesite=lax; max-age=0`;
