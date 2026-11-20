/** Bound each newline-delimited wire message, including its delimiter, in the executable Catalog TEST fixture. */
export const priceGroupCurrentInputGuard = () => {
  let bytes = 0;
  let rejected = false;
  return (chunk: Uint8Array): boolean => {
    if (rejected) {
      return false;
    }
    for (const byte of chunk) {
      bytes += 1;
      if (bytes > 262_144) {
        rejected = true;
        return false;
      }
      if (byte === 10) {
        bytes = 0;
      }
    }
    return true;
  };
};
