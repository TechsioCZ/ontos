/** Throw-based configuration failures with a qualified callee instead of a typed Schema.TaggedError. */
export const renderConfigLoader = (): string => `
import { ConfigErrors, Errors } from './errors';
export const requireIssuer = (value: string | undefined) => {
  if (value === undefined) {
    throw ConfigErrors.missingEnvironment('gateway issuer');
  }
  if (!value.startsWith('https://')) {
    throw new Errors.ConfigurationError('gateway issuer must be https');
  }
  return value;
};
`;
