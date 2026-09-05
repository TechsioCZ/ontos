// Test fixtures hand-build credentials (audit D tier); `ignoreTestFiles` defaults to true.
export interface E2eDatabase {
  readonly connectionString: string;
  readonly password: string;
}

export const seed = (connectionString: string, apiKey: string): string => `${connectionString}:${apiKey}`;
