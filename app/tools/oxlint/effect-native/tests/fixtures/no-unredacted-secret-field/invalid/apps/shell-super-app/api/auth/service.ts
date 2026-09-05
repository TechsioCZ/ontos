// expect-count: 8
import { Effect } from 'effect';

export interface ShellResourceProviderGateway {
  readonly detail: (input: {
    readonly apiKey: string;
    readonly appId: string;
    readonly ref: string;
  }) => Effect.Effect<unknown>;
}

export interface AuthConfigValue {
  readonly connectionString: string;
  readonly secret: string;
}

export interface ApiKeyBundle {
  readonly credentials: ReadonlyArray<string>;
  readonly refreshTokens: readonly string[];
  readonly sessionToken: null | string;
}

export const signIn = async (email: string, password: string): Promise<void> => {
  await Promise.resolve([email, password]);
};

export class Signer {
  constructor(private readonly signingKey: string) {}
}
