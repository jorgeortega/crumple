// Throwaway. The whole Workers adapter: the handler is already web-standard.
import { buildHandler } from './handler.mjs';

const handle = buildHandler();

export default { fetch: (request) => handle(request) };
