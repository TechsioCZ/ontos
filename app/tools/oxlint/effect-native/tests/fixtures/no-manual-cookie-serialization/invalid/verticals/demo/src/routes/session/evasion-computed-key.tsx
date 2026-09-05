// A template-literal computed key is not resolved by `propertyKeyName`, so the `Set-Cookie`
// property is invisible even though its value is a hand-built concatenation.
export const Panel = (props: { readonly name: string; readonly value: string }) => (
  <form
    data-headers={JSON.stringify({ [`Set-Cookie`]: props.name + '=' + props.value })}
  >
    {props.name}
  </form>
);
