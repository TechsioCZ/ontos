import { Config, Schema } from 'effect';

/** Not a generator: a hand-written module whose template literals are messages, not emitted code. */
export const describeMisconfiguration = (variable: string): string => `
  ${variable} is missing. Set it in .env, then rerun. The loader reads process.env once,
  through JSON.parse of the dotenv file, and validates it with Array.isArray before use.
`;

export const GatewayConfig = Config.schema(
  Schema.Struct({ ONTOS_GATEWAY_ISSUER: Schema.URL }),
);
