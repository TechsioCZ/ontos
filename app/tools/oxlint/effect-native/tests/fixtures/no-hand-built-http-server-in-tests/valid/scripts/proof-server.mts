// The audit preserves the outer Node process seam. This is not a test file.
import { createServer } from 'node:http';
const server = createServer(() => {});
server.listen(0);
