// No Effect import at all: `Schema` and `Config` here are local objects.
const Schema = { String: 'string' as const, Struct: (fields: unknown) => fields };
const Config = { string: (key: string) => key };

export const LocalPayload = Schema.Struct({
  password: Schema.String,
  secret: Schema.String,
});

export const LocalSecret = Config.string('BETTER_AUTH_SECRET');

export const Panel = (): unknown => LocalPayload;
