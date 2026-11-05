import { openDatabase, requireDb } from './database.js';
import { parseFlags, usage, type Io } from './io.js';

// Who did what. It's how an operator sees the attempted delete, which is the reason every call
// goes through one door.

const DEFAULT_LIMIT = 50;

export async function auditCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseFlags(args, {
    db: { type: 'string' },
    denied: { type: 'boolean', default: false },
    limit: { type: 'string' },
  });
  const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit);
  if (!Number.isInteger(limit) || limit <= 0) throw usage(`--limit should be a whole number above zero, not ${values.limit ?? ''}.`);

  const store = await openDatabase(requireDb(values.db, 'audit'), io, { mustExist: true });
  try {
    const events = store.audit.recent({ limit, deniedOnly: values.denied });
    if (events.length === 0) io.stdout(values.denied ? 'Nothing has been refused yet.' : 'Nothing has been recorded yet.');
    for (const event of events) {
      const decision = event.decision === 'allow' ? 'allowed' : `denied (${event.reason ?? 'no reason given'})`;
      io.stdout(`${new Date(event.at).toISOString()}  ${event.caller}  ${event.tool}  ${decision}`);
    }
    return 0;
  } finally {
    store.close();
  }
}
