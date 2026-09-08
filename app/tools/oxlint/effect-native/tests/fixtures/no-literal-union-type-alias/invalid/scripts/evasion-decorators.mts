// expect-count: 1
function log(target: unknown, key: string): void {
  void target;
  void key;
}

class Runner {
  @log
  run(): void {}
}

export type RunnerPhase = 'finish' | 'start';

void new Runner();
