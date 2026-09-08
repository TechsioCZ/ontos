// Local bindings that merely share dotenv's names must never report.
import { config } from './contacts-config.ts';
import { parse } from './contact-parser.ts';

const dotenv = { config: (): string => 'local' };
const expand = (value: string): string => value.toUpperCase();

export const Panel = (props: { readonly name: string }) => {
  const require = (key: string): string => key;
  const settings = config();
  const parsed = parse(props.name);
  return (
    <section data-settings={settings} data-parsed={parsed}>
      {dotenv.config()}
      {expand(require('dotenv'))}
    </section>
  );
};
