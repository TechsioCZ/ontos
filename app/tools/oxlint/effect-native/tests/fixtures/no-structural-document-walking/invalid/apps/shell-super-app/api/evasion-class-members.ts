// expect-count: 3
export class TopologyGate {
  readonly #document: Record<string, unknown>;

  constructor(document: Record<string, unknown>) {
    this.#document = document;
  }

  get hasRemotes(): boolean {
    return 'remotes' in this.#document;
  }

  static keyFingerprint(record: Record<string, unknown>): string {
    return Object.keys(record).toSorted().join(' ');
  }

  async *walk(entry: Record<string, unknown>): AsyncGenerator<string> {
    if (typeof entry['kind'] === 'string') yield entry['kind'];
  }
}
