// expect-count: 2
// Evasion: an abstract property is a TSAbstractPropertyDefinition, not a PropertyDefinition,
// so declaring the credential on the abstract base silences every concrete subclass too.
export abstract class BaseGatewayConfig {
  abstract readonly connectionString: string;
  abstract readonly issuer: string;
  abstract readonly preSharedKey: string;
}
