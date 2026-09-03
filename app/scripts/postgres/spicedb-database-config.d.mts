export interface SpiceDbDatabaseBootstrapConfig {
  readonly adminUrl: string;
  readonly database: 'spicedb';
  readonly password: string;
  readonly user: 'spicedb';
}
export declare const parseSpiceDbDatabaseBootstrapConfig: (
  environment: Readonly<Record<string, string | undefined>>,
) => SpiceDbDatabaseBootstrapConfig;
