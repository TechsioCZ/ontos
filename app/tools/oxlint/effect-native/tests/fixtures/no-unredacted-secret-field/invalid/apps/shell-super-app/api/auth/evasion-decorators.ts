// expect-count: 3
// Decorators on properties, accessors, methods and parameters, plus a static block.
declare const log: (target: unknown, key?: unknown) => void;

export class CredentialService {
  @log accessor connectionString: string = '';
  @log readonly password: string = '';

  @log
  issue(@log secret: string): string {
    return secret;
  }

  static {
    void 0;
  }
}
