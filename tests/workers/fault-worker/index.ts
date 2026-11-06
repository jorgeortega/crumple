import { createFaultApi } from '../../../src/fault-api/index.js';

// Only for test:workers: fault-api on its own in workerd, with its control routes on, so a test can
// count what it did. Never deployed, and the public demo has no such routes.
const api = createFaultApi({ control: true });

export default {
  fetch: (request: Request): Promise<Response> => api.fetch(request),
};
