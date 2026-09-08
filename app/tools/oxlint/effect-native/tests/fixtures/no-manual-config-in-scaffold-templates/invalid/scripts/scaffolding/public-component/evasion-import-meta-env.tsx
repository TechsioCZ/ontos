/** Browser scaffold reading ambient configuration through `import.meta.env` (A3). */
export const renderRoute = (path: string): string => `
export const Route = () => {
  const base = import.meta.env.ONTOS_API_BASE_URL;
  const issuer = import.meta.env.ONTOS_GATEWAY_ISSUER;
  return <a href={base + '${path}'}>{issuer}</a>;
};
`;

export const Preview = (): JSX.Element => <section>generated</section>;
