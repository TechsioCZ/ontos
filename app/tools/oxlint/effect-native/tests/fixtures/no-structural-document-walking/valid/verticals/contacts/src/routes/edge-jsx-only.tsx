const identity = <T,>(value: T): T => value;

export const Shell = (props: { readonly items: readonly string[] }): JSX.Element => (
  <>
    <div {...props} className={identity('shell')}>
      {props.items.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  </>
);
