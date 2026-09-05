// expect-count: 2
/** Offset probe: CRLF line endings inside the emitted template. */
export const renderLoader = (name: string): string => `export const load${name} = async () => {
  return await undefined;
};
`;
