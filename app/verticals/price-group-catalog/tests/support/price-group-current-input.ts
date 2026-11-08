/** Cumulative private-input bound for the executable Catalog TEST fixture. */
export const priceGroupCurrentInputGuard = () => {
  let bytes = 0;
  return (chunk: Uint8Array): boolean => {
    bytes += chunk.byteLength;
    return bytes <= 262_144;
  };
};
