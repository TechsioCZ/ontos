// expect-count: 3
// Async generators, object generator methods and top-level await in a `.mts` script.
export async function* streamSecret(secret: string): AsyncGenerator<string> {
  yield secret;
}

export const helpers = {
  async *replay(password: string) {
    yield password;
  },
  sign(apiKey: string) {
    return apiKey;
  },
};

await Promise.resolve();
