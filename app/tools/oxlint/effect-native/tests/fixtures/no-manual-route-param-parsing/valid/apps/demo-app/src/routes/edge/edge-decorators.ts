const logged = <T,>(value: T, _context: unknown): T => value;

class Loader {
  @logged
  load(searchParams: string): string {
    return searchParams;
  }
}

export const loader = new Loader();
