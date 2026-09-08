// expect-count: 2
const cookieName = '__Host-preferences';

export const Banner = (props: { readonly locale: string }) => {
  document.cookie = `${cookieName}=${props.locale}; Path=/; SameSite=Lax`;
  return <span data-name={cookieName}>{props.locale}</span>;
};
