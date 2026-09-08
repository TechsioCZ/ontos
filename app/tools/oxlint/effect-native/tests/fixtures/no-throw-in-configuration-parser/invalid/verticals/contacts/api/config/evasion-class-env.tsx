// expect-count: 1
// A3 evasion: the environment record is held as a class field, so the bag read is `this.environment`
// rather than a bare identifier and the method that throws is never marked as a parser.
export class ContactsConfiguration {
  constructor(private readonly environment: Readonly<Record<string, string | undefined>>) {}

  require(key: string): string {
    const value = this.environment[key];
    if (value === undefined || value.length === 0) {
      throw new Error(`${key} is required`);
    }
    return value;
  }
}

export const ConfigurationBadge = (props: { readonly config: ContactsConfiguration }) => (
  <span>{props.config.require('ONTOS_CONTACTS_API_BASE')}</span>
);
