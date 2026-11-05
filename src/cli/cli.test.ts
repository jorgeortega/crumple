import { statSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanTempDbs, runOnce, start, tempDb, type Started } from '../../tests/helpers/cli.js';
import { AUDIENCE, ISSUER } from '../../tests/helpers/issuer.js';
import { callTool, rpc, textOf } from '../../tests/helpers/mcp.js';
import { createFaultApi, DEFAULT_CREDENTIAL, OPENAPI, type FaultApi } from '../fault-api/index.js';
import { serveOnNode, type NodeServer } from '../node.js';

const DOC = 'openapi.json';
const FILES = { [DOC]: JSON.stringify(OPENAPI) };
const CREDENTIAL = `Bearer ${DEFAULT_CREDENTIAL}`;
const ENV = { CRUMPLE_UPSTREAM_CREDENTIAL: CREDENTIAL };
const PAYMENT = { body: { customerId: 'cus_1', amountCents: 5000 } };

const servers: NodeServer[] = [];
const running: Started[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) {
    server.stop();
    await server.finished;
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
  cleanTempDbs();
});

async function upstream(): Promise<{ api: FaultApi; url: string }> {
  const api = createFaultApi();
  const server = await serveOnNode((request) => api.fetch(request));
  servers.push(server);
  return { api, url: server.url };
}

async function serve(args: string[], options: Parameters<typeof start>[1] = {}): Promise<Started> {
  const started = await start(['serve', DOC, '--port', '0', ...args], { files: FILES, env: ENV, ...options });
  running.push(started);
  return started;
}

const call = (server: Started, tool: string, args: Record<string, unknown>, token = server.key) =>
  callTool(fetch, tool, args, { token, url: server.endpoint });

describe('the first run', () => {
  it('goes from a printed key to a tool call', async () => {
    const { api, url } = await upstream();
    const server = await serve(['--upstream', url]);

    expect(server.out()).toContain('Crumple is serving 6 tools from openapi.json');
    expect(server.out()).toContain('Your API key, shown once:');
    expect(server.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const answer = await call(server, 'getCustomer', { id: 'cus_1' });
    expect(JSON.parse(textOf(answer))).toMatchObject({ id: 'cus_1' });
    expect(api.requests()[0]?.headers.authorization).toBe(CREDENTIAL);
  });

  it('prints a line that connects Claude Code', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url]);
    expect(server.out()).toContain(`claude mcp add --transport http crumple ${server.endpoint} --header "Authorization: Bearer ${server.key ?? ''}"`);
  });

  it('runs with no credential for an open API, and says so', async () => {
    const { api, url } = await upstream();
    const server = await serve(['--upstream', url], { env: {} });
    expect(server.out()).toContain('with no credential');
    await call(server, 'listCustomers', {});
    expect(api.requests()[0]?.headers.authorization).toBeUndefined();
  });

  it('uses the document\'s server when no upstream is given', async () => {
    const { api, url } = await upstream();
    const server = await serve([], { files: { [DOC]: JSON.stringify({ ...OPENAPI, servers: [{ url }] }) } });
    await call(server, 'getCustomer', { id: 'cus_1' });
    expect(api.requests()).toHaveLength(1);
  });

  it('puts the credential in the query when told to', async () => {
    const seen: string[] = [];
    const api = await serveOnNode((request) => {
      seen.push(request.url);
      return Promise.resolve(Response.json([]));
    });
    servers.push(api);
    const server = await serve(['--upstream', api.url, '--credential-query', 'api_key']);
    await call(server, 'listCustomers', {});
    expect(new URL(seen[0] ?? 'http://x').searchParams.get('api_key')).toBe(CREDENTIAL);
  });

  it('puts the credential in another header when told to', async () => {
    const { api, url } = await upstream();
    const server = await serve(['--upstream', url, '--credential-header', 'x-custom-auth']);
    await call(server, 'listCustomers', {});
    expect(api.requests()[0]?.headers['x-custom-auth']).toBe(CREDENTIAL);
  });

  it('reads the document from a URL', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url], { files: {} });
    expect(server.endpoint).toBe('');
    expect(server.err()).toContain('Couldn\'t read');
    running.pop();
    const fromUrl = await start(['serve', `${url}/openapi.json`, '--upstream', url, '--port', '0'], { env: ENV });
    running.push(fromUrl);
    expect(fromUrl.out()).toContain('6 tools');
  });
});

describe('the first key', () => {
  it('can read, and is refused a write', async () => {
    const { api, url } = await upstream();
    const server = await serve(['--upstream', url]);
    expect(server.out()).toContain('It can read, and it can\'t write.');
    expect((await call(server, 'createPayment', PAYMENT)).body.error?.code).toBe(-32602);
    expect(api.effects()).toEqual([]);
  });

  it('can make the write that --write names, and only that', async () => {
    const { api, url } = await upstream();
    const server = await serve(['--upstream', url, '--write', 'createPayment']);
    expect(server.out()).toContain('it can write with: createPayment');
    expect((await call(server, 'createPayment', PAYMENT)).body.result?.isError).toBeUndefined();
    expect(api.effects()).toHaveLength(1);
    expect((await call(server, 'deleteCustomer', { id: 'cus_1' })).body.error?.code).toBe(-32602);
  });

  it.each([
    ['a tool that doesn\'t exist', 'noSuchTool', /there's no tool with that name.*createPayment/],
    ['a tool that only reads', 'getCustomer', /that tool only reads/],
  ])('refuses --write with %s', async (_name, tool, message) => {
    const { code, err } = await runOnce(['serve', DOC, '--upstream', 'http://x.test', '--write', tool], { files: FILES });
    expect(code).toBe(2);
    expect(err).toMatch(message);
  });
});

describe('the log', () => {
  it('has one line a call, with no arguments', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url]);
    await call(server, 'getCustomer', { id: 'cus_1' });
    await call(server, 'getCustomer', { id: 'cus_secret_marker' });
    await call(server, 'deleteCustomer', { id: 'cus_1' });
    await call(server, 'getCustomer', { id: 'cus_1' }, `crumple_${'a'.repeat(43)}`);

    const log = server.err();
    expect(log).toMatch(/tools\/call getCustomer {2}key_\w+ {2}ok {2}\d+ ms/);
    expect(log).toMatch(/tools\/call deleteCustomer {2}key_\w+ {2}denied {2}writes_not_allowed/);
    expect(log).toMatch(/tools\/call getCustomer {2}key_\w+ {2}failed {2}tool_error/);
    expect(log).toMatch(/sign-in refused {2}invalid_key/);
    expect(log).not.toContain('secret_marker');
  });

  it('goes quiet with --quiet', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url, '--quiet']);
    await call(server, 'getCustomer', { id: 'cus_1' });
    expect(server.err()).toBe('');
  });

  it('skips tools/list', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url]);
    await rpc(fetch, 'tools/list', {}, { token: server.key, url: server.endpoint });
    expect(server.err()).toBe('');
  });
});

// C4 at the outermost layer: the key is shown once, and the credential never.
describe('what gets printed', () => {
  it('never holds the credential, and holds the key only where it\'s first shown', async () => {
    const { api, url } = await upstream();
    const server = await serve(['--upstream', url, '--write', 'createPayment']);
    expect(api.requests()).toEqual([]);
    await call(server, 'getCustomer', { id: 'cus_1' });
    await call(server, 'deleteCustomer', { id: 'cus_1' });
    await call(server, 'getCustomer', { id: 'cus_1' }, 'bad');

    expect(server.all()).not.toContain(DEFAULT_CREDENTIAL);
    expect(server.err()).not.toContain(server.key);
    // Once to show it, and once in the line that connects Claude Code.
    expect(server.out().split(server.key ?? '')).toHaveLength(3);
  });

  it('keeps the credential out of the stored database too', async () => {
    const { url } = await upstream();
    const db = tempDb();
    const server = await serve(['--upstream', url, '--db', db]);
    await call(server, 'getCustomer', { id: 'cus_1' });
    expect(server.all()).not.toContain(DEFAULT_CREDENTIAL);
  });
});

describe('a database', () => {
  it('keeps the first key, and the second start prints none', async () => {
    const { url } = await upstream();
    const db = tempDb();
    const first = await serve(['--upstream', url, '--db', db]);
    const { key } = first;
    expect(first.out()).toContain('so later starts won\'t print a new one');
    first.stop();
    await first.finished;
    running.pop();

    const second = await serve(['--upstream', url, '--db', db]);
    expect(second.key).toBeUndefined();
    expect(second.out()).not.toContain('Your API key');
    expect((await call(second, 'getCustomer', { id: 'cus_1' }, key)).status).toBe(200);
  });

  it('warns that --write only applies to a first key', async () => {
    const { url } = await upstream();
    const db = tempDb();
    const first = await serve(['--upstream', url, '--db', db]);
    first.stop();
    await first.finished;
    running.pop();

    const second = await serve(['--upstream', url, '--db', db, '--write', 'createPayment']);
    expect(second.err()).toContain('--write only applies when the first key is made');
  });

  it('is closed cleanly on stop, with exit code 0', async () => {
    const { url } = await upstream();
    const db = tempDb();
    const server = await serve(['--upstream', url, '--db', db]);
    server.stop();
    expect(await server.finished).toBe(0);
    running.pop();
    expect(statSync(db).mode & 0o777).toBe(0o600);
    expect((await runOnce(['keys', 'list', '--db', db])).code).toBe(0);
  });

  it('says what to do when it can\'t be opened', async () => {
    const { url } = await upstream();
    const { code, err } = await runOnce(['serve', DOC, '--upstream', url, '--port', '0', '--db', '/no/such/folder/crumple.db'], { files: FILES });
    expect(code).toBe(1);
    expect(err).toContain('Check that its folder exists');
  });
});

describe('keys', () => {
  it('creates, lists and revokes, and a revoked key stops working', async () => {
    const { url } = await upstream();
    const db = tempDb();

    const created = await runOnce(['keys', 'create', '--db', db, '--label', 'ci', '--write', 'createPayment']);
    expect(created.code).toBe(0);
    expect(created.out).toContain('It can: read everything, write createPayment');
    const key = /crumple_[\w-]{43}/.exec(created.out)?.[0] ?? '';
    const id = /key_[0-9a-f]+/.exec(created.out)?.[0] ?? '';

    const listed = await runOnce(['keys', 'list', '--db', db]);
    expect(listed.out).toMatch(new RegExp(`${id} {2}crumple_\\S+\\.\\.\\. {2}active {2}ci {2}can: read everything, write createPayment`));
    expect(listed.out).not.toContain(key);

    const server = await serve(['--upstream', url, '--db', db]);
    expect(server.key).toBeUndefined();
    expect((await call(server, 'getCustomer', { id: 'cus_1' }, key)).status).toBe(200);

    expect((await runOnce(['keys', 'revoke', id, '--db', db])).code).toBe(0);
    expect((await call(server, 'getCustomer', { id: 'cus_1' }, key)).status).toBe(401);
    expect((await runOnce(['keys', 'list', '--db', db])).out).toContain('revoked');
  });

  it('can be limited to named reads', async () => {
    const db = tempDb();
    const { out } = await runOnce(['keys', 'create', '--db', db, '--read', 'getCustomer']);
    expect(out).toContain('It can: read getCustomer.');
  });

  it('says there are none yet', async () => {
    const db = tempDb();
    await runOnce(['keys', 'create', '--db', db]);
    const empty = tempDb();
    writeFileSync(empty, '');
    expect((await runOnce(['keys', 'list', '--db', empty])).out).toContain('no keys yet');
  });

  it.each<[string, string[], number, RegExp]>([
    ['no action', ['keys'], 2, /keys create, keys list or keys revoke/],
    ['an unknown action', ['keys', 'delete'], 2, /keys create, keys list or keys revoke/],
    ['no database', ['keys', 'create'], 2, /needs a database/],
    ['revoke with no id', ['keys', 'revoke', '--db', 'x.db'], 2, /Say which key/],
    ['list of a database that isn\'t there', ['keys', 'list', '--db', '/no/such.db'], 1, /no database at/],
    ['revoke of a database that isn\'t there', ['keys', 'revoke', 'key_1', '--db', '/no/such.db'], 1, /no database at/],
  ])('refuses %s', async (_name, argv, code, message) => {
    const result = await runOnce(argv);
    expect(result.code).toBe(code);
    expect(result.err).toMatch(message);
  });

  it('refuses to revoke a key that isn\'t there', async () => {
    const db = tempDb();
    await runOnce(['keys', 'create', '--db', db]);
    const { code, err } = await runOnce(['keys', 'revoke', 'key_missing', '--db', db]);
    expect(code).toBe(1);
    expect(err).toContain('no active key');
  });

  it('refuses a grant that could never work', async () => {
    const { code, err } = await runOnce(['keys', 'create', '--db', tempDb(), '--write', '*']);
    expect(code).toBe(2);
    expect(err).toContain('only covers reads');
  });
});

describe('audit', () => {
  it('shows the attempted delete, which is the point of one door', async () => {
    const { url } = await upstream();
    const db = tempDb();
    const server = await serve(['--upstream', url, '--db', db]);
    await call(server, 'getCustomer', { id: 'cus_1' });
    await call(server, 'deleteCustomer', { id: 'cus_1' });

    const everything = await runOnce(['audit', '--db', db]);
    expect(everything.out).toMatch(/getCustomer {2}allowed/);
    expect(everything.out).toMatch(/deleteCustomer {2}denied \(writes_not_allowed\)/);

    const denied = await runOnce(['audit', '--db', db, '--denied']);
    expect(denied.out).not.toContain('getCustomer');
    expect(denied.out).toContain('deleteCustomer');

    const limited = await runOnce(['audit', '--db', db, '--limit', '1']);
    expect(limited.out).not.toContain('getCustomer');
  });

  it('says when there\'s nothing to show', async () => {
    const db = tempDb();
    await runOnce(['keys', 'create', '--db', db]);
    expect((await runOnce(['audit', '--db', db])).out).toContain('Nothing has been recorded');
    expect((await runOnce(['audit', '--db', db, '--denied'])).out).toContain('Nothing has been refused');
  });

  it.each<[string, string[], number, RegExp]>([
    ['no database', ['audit'], 2, /needs a database/],
    ['a database that isn\'t there, rather than making an empty one', ['audit', '--db', '/no/such.db'], 1, /no database at/],
    ['a bad limit', ['audit', '--db', 'x.db', '--limit', 'lots'], 2, /--limit should be/],
    ['a zero limit', ['audit', '--db', 'x.db', '--limit', '0'], 2, /--limit should be/],
  ])('refuses %s', async (_name, argv, code, message) => {
    const result = await runOnce(argv);
    expect(result.code).toBe(code);
    expect(result.err).toMatch(message);
  });
});

describe('a sealed credential', () => {
  const SEAL_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

  async function sealed(db: string, args: string[] = []) {
    return runOnce(['credential', 'set', '--db', db, ...args], { env: { ...ENV, CRUMPLE_SEAL_KEY: SEAL_KEY } });
  }

  it('goes from the environment into the database, and reaches the API', async () => {
    const { api, url } = await upstream();
    const db = tempDb();
    expect((await sealed(db)).code).toBe(0);

    const server = await serve(['--upstream', url, '--db', db], { env: { CRUMPLE_SEAL_KEY: SEAL_KEY } });
    expect(server.out()).toContain('using the sealed credential');
    await call(server, 'listCustomers', {});
    expect(api.requests()[0]?.headers.authorization).toBe(CREDENTIAL);
  });

  it('keeps where it goes', async () => {
    const { api, url } = await upstream();
    const db = tempDb();
    await sealed(db, ['--credential-header', 'x-custom-auth']);
    const server = await serve(['--upstream', url, '--db', db], { env: { CRUMPLE_SEAL_KEY: SEAL_KEY } });
    await call(server, 'listCustomers', {});
    expect(api.requests()[0]?.headers['x-custom-auth']).toBe(CREDENTIAL);
  });

  it('isn\'t in the file in plain text, and neither is the seal key', async () => {
    const db = tempDb();
    await sealed(db);
    const { DatabaseSync } = await import('node:sqlite');
    const direct = new DatabaseSync(db);
    const stored = JSON.stringify(direct.prepare('SELECT * FROM credentials').all());
    direct.close();
    expect(stored).not.toContain(DEFAULT_CREDENTIAL);
    expect(stored).not.toContain(SEAL_KEY);
  });

  it('is an error alongside a plain one, rather than a silent choice', async () => {
    const { url } = await upstream();
    const db = tempDb();
    await sealed(db);
    const { code, err } = await runOnce(['serve', DOC, '--upstream', url, '--port', '0', '--db', db], { files: FILES, env: { ...ENV, CRUMPLE_SEAL_KEY: SEAL_KEY } });
    expect(code).toBe(1);
    expect(err).toContain('is set too');
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ['no seal key', {}, /opening it needs CRUMPLE_SEAL_KEY/],
    ['the wrong seal key', { CRUMPLE_SEAL_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))) }, /won't open with this CRUMPLE_SEAL_KEY/],
  ])('says so at start with %s, rather than on every call', async (_name, env, message) => {
    const { url } = await upstream();
    const db = tempDb();
    await sealed(db);
    const { code, err } = await runOnce(['serve', DOC, '--upstream', url, '--port', '0', '--db', db], { files: FILES, env });
    expect(code).toBe(1);
    expect(err).toMatch(message);
  });

  it('refuses a flag saying where it goes, since it already knows', async () => {
    const { url } = await upstream();
    const db = tempDb();
    await sealed(db);
    const { code, err } = await runOnce(['serve', DOC, '--upstream', url, '--db', db, '--credential-header', 'x'], { files: FILES, env: { CRUMPLE_SEAL_KEY: SEAL_KEY } });
    expect(code).toBe(2);
    expect(err).toContain('already says where it goes');
  });

  it.each<[string, string[], Record<string, string>, RegExp]>([
    ['no action', ['credential'], {}, /credential set/],
    ['no database', ['credential', 'set'], ENV, /needs a database/],
    ['no credential in the environment', ['credential', 'set', '--db', 'x.db'], {}, /never a flag/],
    ['no seal key, with how to make one', ['credential', 'set', '--db', 'x.db'], ENV, /openssl rand -base64 32/],
    ['a seal key of the wrong size', ['credential', 'set', '--db', 'x.db'], { ...ENV, CRUMPLE_SEAL_KEY: btoa('short') }, /32 bytes in base64/],
    ['both places', ['credential', 'set', '--db', 'x.db', '--credential-header', 'a', '--credential-query', 'b'], { ...ENV, CRUMPLE_SEAL_KEY: SEAL_KEY }, /not both/],
  ])('refuses %s', async (_name, argv, env, message) => {
    const result = await runOnce(argv, { env });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
  });
});

describe('safety on the network', () => {
  // fetch won't let a test set Host, so this goes through the raw socket.
  async function rawStatus(endpoint: string, host: string): Promise<number> {
    const { request } = await import('node:http');
    const { hostname, port, pathname } = new URL(endpoint);
    return new Promise((resolve, reject) => {
      const outgoing = request({ hostname, port, path: pathname, method: 'POST', headers: { host, 'content-length': 2 } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      outgoing.on('error', reject);
      outgoing.end('{}');
    });
  }

  it('binds to 127.0.0.1 by default, with no warning', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url]);
    expect(server.endpoint).toContain('127.0.0.1');
    expect(server.err()).toBe('');
  });

  // DNS rebinding: a web page reaches a local server through a name the attacker controls.
  it('refuses a Host that isn\'t local, and accepts local ones', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url]);
    expect(await rawStatus(server.endpoint, 'evil.test')).toBe(403);
    expect(await rawStatus(server.endpoint, 'localhost:3333')).toBe(401);
    expect(await rawStatus(server.endpoint, '127.0.0.1:3333')).toBe(401);
  });

  it('adds to the list with --allowed-host', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url, '--allowed-host', 'mcp.internal']);
    expect(await rawStatus(server.endpoint, 'mcp.internal')).toBe(401);
    expect(await rawStatus(server.endpoint, 'evil.test')).toBe(403);
  });

  it('refuses a browser by default, and allows an origin it was told about', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url, '--allowed-origin', 'https://app.test']);
    const status = async (origin: string) => (await rpc(fetch, 'tools/list', {}, { token: server.key, url: server.endpoint, headers: { origin } })).status;
    expect(await status('https://evil.test')).toBe(403);
    expect(await status('https://app.test')).toBe(200);
  });

  it('warns when listening beyond this machine, and has no Host check unless given one', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url, '--host', '0.0.0.0']);
    expect(server.err()).toContain('unencrypted');
    expect(await rawStatus(server.endpoint.replace('0.0.0.0', '127.0.0.1'), 'anything.test')).toBe(401);
  });

  it('can check Host beyond this machine, when given names', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url, '--host', '0.0.0.0', '--allowed-host', 'mcp.internal']);
    expect(await rawStatus(server.endpoint.replace('0.0.0.0', '127.0.0.1'), 'evil.test')).toBe(403);
  });

  it('warns before sending a credential over plain HTTP to another machine', async () => {
    const server = await serve(['--upstream', 'http://api.example.test']);
    expect(server.err()).toContain('over plain HTTP');
  });

  it.each([['https://api.example.test'], ['http://localhost:9999'], ['http://127.0.0.1:9999']])('doesn\'t warn for %s', async (address) => {
    const server = await serve(['--upstream', address]);
    expect(server.err()).toBe('');
  });

  it('doesn\'t warn when there\'s no credential to send', async () => {
    const server = await serve(['--upstream', 'http://api.example.test'], { env: {} });
    expect(server.err()).toBe('');
  });
});

describe('filtering tools', () => {
  it('honours --include and --exclude', async () => {
    const { url } = await upstream();
    const included = await serve(['--upstream', url, '--include', 'getCustomer']);
    expect(included.out()).toContain('serving 1 tool from');
    const excluded = await serve(['--upstream', url, '--exclude', 'getCustomer']);
    expect(excluded.out()).toContain('serving 5 tools');
  });
});

describe('a config file', () => {
  it('sets a deadline', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url, '--config', 'c.json'], {
      files: { ...FILES, 'c.json': JSON.stringify({ deadlineMs: 200, attemptTimeoutMs: 100, retry: { attempts: 1 }, limits: { perCaller: 2 } }) },
      env: { ...ENV },
    });
    expect(server.endpoint).not.toBe('');
  });

  it('sends fixed headers upstream, which is how a test tells fault-api what to break', async () => {
    const { api, url } = await upstream();
    const server = await serve(['--upstream', url, '--config', 'c.json'], { files: { ...FILES, 'c.json': JSON.stringify({ upstreamHeaders: { 'x-fault': 'status=404' } }) } });
    const answer = await call(server, 'getCustomer', { id: 'cus_1' });
    expect(JSON.parse(textOf(answer))).toMatchObject({ code: 'rejected' });
    expect(api.requests()[0]?.headers['x-fault']).toBe('status=404');
  });

  const JWT = { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://login.example.test/jwks.json', resource: AUDIENCE, scopes: { read: [{ tool: '*' }] } };

  it('turns on JWT sign-in, which serves metadata and makes no first key', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url, '--config', 'c.json'], { files: { ...FILES, 'c.json': JSON.stringify({ jwt: JWT }) } });
    expect(server.key).toBeUndefined();
    const metadata = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', server.endpoint));
    expect(await metadata.json()).toMatchObject({ authorization_servers: [ISSUER] });
  });

  it('passes on a message that says what to do', async () => {
    const { code, err } = await runOnce(['serve', DOC, '--upstream', 'http://x.test', '--port', '0', '--config', 'c.json'], {
      files: { ...FILES, 'c.json': JSON.stringify({ jwt: { ...JWT, scopes: { all: [{ tool: '*', writes: true }] } } }) },
    });
    expect(code).toBe(1);
    expect(err).toContain('A grant of * only covers reads');
  });

  it.each<[string, string, RegExp]>([
    ['a misspelt field', '{"deadline": 1}', /deadline isn't something Crumple knows/],
    ['bad YAML', '{ nope: [', /Check that it's JSON or YAML/],
  ])('refuses %s', async (_name, text, message) => {
    const { code, err } = await runOnce(['serve', DOC, '--upstream', 'http://x.test', '--config', 'c.json'], { files: { ...FILES, 'c.json': text } });
    expect(code).toBe(1);
    expect(err).toMatch(message);
  });

  it('says so when the file isn\'t there', async () => {
    const { code, err } = await runOnce(['serve', DOC, '--config', '/no/such.json'], { files: FILES });
    expect(code).toBe(1);
    expect(err).toContain('Couldn\'t read the config');
  });
});

describe('sending traces', () => {
  it('goes only to the address given, and finishes on stop', async () => {
    const { url } = await upstream();
    const sent: string[] = [];
    const collector = await serveOnNode((request) => {
      sent.push(new URL(request.url).pathname);
      return Promise.resolve(new Response('{}'));
    });
    servers.push(collector);
    const server = await serve(['--upstream', url, '--otlp', `${collector.url}/v1/traces`]);
    await call(server, 'getCustomer', { id: 'cus_1' });
    server.stop();
    expect(await server.finished).toBe(0);
    running.pop();
    expect(sent).toContain('/v1/traces');
  });
});

// The main spec's rule: each error says what went wrong and what to do next.
describe('errors', () => {
  it.each<[string, string[], Record<string, string>, number, RegExp]>([
    ['no document', ['serve'], {}, 2, /Say which API to serve/],
    ['a missing file', ['serve', '/no/such.yaml'], {}, 1, /Couldn't read \/no\/such.yaml. Check the path/],
    ['bad YAML', ['serve', 'x.yaml'], { 'x.yaml': '{ nope: [' }, 1, /Check that it's valid JSON or YAML/],
    ['Swagger 2.0', ['serve', 'x.yaml'], { 'x.yaml': 'swagger: "2.0"' }, 1, /Convert it to OpenAPI 3/],
    ['something else entirely', ['serve', 'x.yaml'], { 'x.yaml': 'just text' }, 1, /isn't an OpenAPI document/],
    ['no tools', ['serve', 'x.yaml'], { 'x.yaml': 'openapi: 3.1.0\npaths: {}' }, 1, /gave no tools to serve/],
    ['no upstream', ['serve', 'x.json'], { 'x.json': JSON.stringify({ ...OPENAPI, servers: [] }) }, 2, /Say where your API is, with --upstream/],
    ['a bad upstream', ['serve', 'x.json', '--upstream', 'nope'], { 'x.json': JSON.stringify(OPENAPI) }, 2, /--upstream should be a full URL/],
    ['a bad port', ['serve', 'x.json', '--port', 'abc'], { 'x.json': JSON.stringify(OPENAPI) }, 2, /--port should be a number/],
    ['a port out of range', ['serve', 'x.json', '--port', '70000'], { 'x.json': JSON.stringify(OPENAPI) }, 2, /--port should be a number/],
    ['both credential places', ['serve', 'x.json', '--upstream', 'http://x.test', '--credential-header', 'a', '--credential-query', 'b'], { 'x.json': JSON.stringify(OPENAPI) }, 2, /not both/],
    // A misspelt flag quietly doing nothing would be a bad surprise in a security tool.
    ['a misspelt flag', ['serve', 'x.json', '--wirte', 'x'], {}, 2, /--wirte.*Run crumple-mcp --help/],
    ['an unknown command', ['nope'], {}, 2, /no command called nope.*--help/],
  ])('%s', async (_name, argv, files, code, message) => {
    const result = await runOnce(argv, { files });
    expect(result.code).toBe(code);
    expect(result.err).toMatch(message);
  });

  it('says so when a port is in use, and suggests another', async () => {
    const { url } = await upstream();
    const taken = await serveOnNode(() => Promise.resolve(new Response('')));
    servers.push(taken);
    const { code, err } = await runOnce(['serve', DOC, '--upstream', url, '--port', new URL(taken.url).port], { files: FILES, env: ENV });
    expect(code).toBe(1);
    expect(err).toMatch(/Port \d+ is already in use. Pick another with --port/);
  });

  it('reports an unexpected failure without a stack trace', async () => {
    const { code, err } = await runOnce(['serve', DOC, '--upstream', 'http://x.test', '--port', '0', '--host', 'not a host name'], { files: FILES });
    expect(code).toBe(1);
    expect(err).toContain('Couldn\'t start the server');
    expect(err).not.toContain('    at ');
  });

  it.each<[string, () => Promise<Response>, RegExp]>([
    ['a failed fetch', () => Promise.reject(new Error('down')), /Couldn't fetch/],
    ['a 404', () => Promise.resolve(new Response('', { status: 404 })), /answered 404/],
    ['a huge document', () => Promise.resolve(new Response('x'.repeat(10 * 1024 * 1024 + 1))), /over 10 MB/],
  ])('says what to do after %s loading a document', async (_name, respond, message) => {
    const { code, err } = await runOnce(['serve', 'https://api.test/openapi.json'], { fetch: respond });
    expect(code).toBe(1);
    expect(err).toMatch(message);
  });
});

describe('help and version', () => {
  it.each([[[]], [['--help']], [['-h']], [['help']], [['serve', '--help']], [['serve', './api.yaml', '-h']], [['keys', 'create', '--help']], [['fault-api', '--help']]])('shows help for %j', async (argv) => {
    const { code, out } = await runOnce(argv);
    expect(code).toBe(0);
    for (const command of ['serve', 'keys', 'audit', 'credential', 'fault-api']) expect(out).toContain(command);
    expect(out).toContain('sends no telemetry');
  });

  it.each([['--version'], ['-v']])('shows the version for %s', async (flag) => {
    const { code, out } = await runOnce([flag]);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('says nothing about Latitude 10 at run time, by the main spec\'s rule', async () => {
    const { url } = await upstream();
    const server = await serve(['--upstream', url]);
    const { out } = await runOnce(['--help']);
    expect((server.all() + out).toLowerCase()).not.toContain('latitude');
  });
});

describe('fault-api', () => {
  it('runs on 127.0.0.1, shows what you need, and reports what arrived', async () => {
    const server = await start(['fault-api', '--port', '0']);
    running.push(server);
    const address = /Address\s+(\S+)/.exec(server.out())?.[1] ?? '';
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.out()).toContain(CREDENTIAL);

    const document = await fetch(`${address}/openapi.json`);
    expect(document.status).toBe(200);
    await fetch(`${address}/customers/cus_1`, { headers: { authorization: CREDENTIAL } });
    expect(await (await fetch(`${address}/_fault/requests`)).text()).toContain('cus_1');
  });

  it('can be served by serve, as a person would do it', async () => {
    const fault = await start(['fault-api', '--port', '0']);
    running.push(fault);
    const address = /Address\s+(\S+)/.exec(fault.out())?.[1] ?? '';
    const server = await start(['serve', `${address}/openapi.json`, '--upstream', address, '--port', '0'], { env: ENV });
    running.push(server);
    expect((await call(server, 'getCustomer', { id: 'cus_1' })).status).toBe(200);
  });

  it('says so when its port is in use', async () => {
    const taken = await serveOnNode(() => Promise.resolve(new Response('')));
    servers.push(taken);
    const { code, err } = await runOnce(['fault-api', '--port', new URL(taken.url).port]);
    expect(code).toBe(1);
    expect(err).toContain('already in use');
  });
});
