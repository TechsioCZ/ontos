/** A UUID whose version and variant bits are fixed, so a digest is a stable identifier. */
export const uuidFromDigest = (digest: string): string =>
  `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${'89ab'.charAt(Number.parseInt(digest.charAt(16), 16) % 4)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
