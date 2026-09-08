// A local function named `require` that has nothing to do with module loading, plus JSX lookalikes:
// none of these bindings resolve to a dotenv import.
type Dotenv = { readonly Config: (props: { readonly path: string }) => JSX.Element };

const dotenv: Dotenv = { Config: () => <span /> };

export const Panel = (props: { readonly keys: readonly string[] }) => {
  const require = (key: string): string => key.toUpperCase();
  const config = (): string => 'local';
  const load = { config: (): string => 'also local' };
  return (
    <div data-a={require('dotenv')} data-b={config()} data-c={load['config']()}>
      <dotenv.Config path=".env" />
      {props.keys.map((key) => (
        <span key={key}>{key}</span>
      ))}
    </div>
  );
};
