import { createFaultApi, DEFAULT_CREDENTIAL } from '../fault-api/index.js';
import { serveOnNode } from '../node.js';
import { explainListenError, parseFlags, parsePort, type Io } from './io.js';

// The API that fails on command, for pointing another server at. It's only on 127.0.0.1, with no
// way to change that, so /_fault/* can be on: the reason to run this is to ask what arrived.

const DEFAULT_PORT = 8787;
const HOST = '127.0.0.1';

export async function faultApiCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseFlags(args, { port: { type: 'string' } });
  const port = parsePort(values.port, DEFAULT_PORT);
  const api = createFaultApi({ control: true });

  let server;
  try {
    server = await serveOnNode((request) => api.fetch(request), { port, host: HOST });
  } catch (error) {
    throw explainListenError(error, port);
  }

  io.stdout([
    'fault-api, the API that fails on command, is running. All of its data is fake.',
    `  Address      ${server.url}`,
    `  Credential   Bearer ${DEFAULT_CREDENTIAL}`,
    `  Document     ${server.url}/openapi.json`,
    '',
    'Choose a failure with a request header, such as x-fault: status=503;times=2.',
    `What arrived:  ${server.url}/_fault/requests`,
  ].join('\n'));

  await io.waitForStop();
  await server.close();
  return 0;
}
