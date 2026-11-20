/** Bound each newline-delimited message in the executable Catalog TEST fixture. */
export const priceGroupCurrentInputGuard = () => {
  let bytes = 0;
  let rejected = false;
  return (chunk: Uint8Array): boolean => {
    if (rejected) {
      return false;
    }
    for (const byte of chunk) {
      if (byte === 10) {
        bytes = 0;
      } else {
        bytes += 1;
        if (bytes > 262_144) {
          rejected = true;
          return false;
        }
      }
    }
    return true;
  };
};
