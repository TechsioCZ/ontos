// expect-count: 3
interface Row { id: string }
namespace Other { type Outcome = Promise<Row>; }
type Outcome = Promise<Row | undefined>;
export interface Repo { load(): Outcome }
// A first-party annotation is not proof of a framework-owned nullable signature.
type Owned = () => Promise<Row | null>;
export const own: Owned = async (): Promise<Row | null> => null;
