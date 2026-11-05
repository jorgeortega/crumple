import { CliError, readVersion, usage, type Io } from './io.js';

// Commands load their code when they run, so serve without --db never touches node:sqlite and a
// first run never shows its warning.

const HELP = `crumple-mcp: a crumple zone for AI agents.

  demo                  Break an API on purpose and see what held. No key, under a minute

  serve <file or URL>   Put the crumple zone in front of your API
      --upstream <url>            Where your API is. Default: the document's first server
      --port <n>                  Default: 3333
      --host <addr>               Default: 127.0.0.1
      --db <file>                 Keep keys and audit events in this file
      --write <tool>              Let the first key use this write tool. Repeatable
      --include, --exclude <x>    Filter tools by name or tag. Repeatable
      --credential-header <name>  Default: authorization
      --credential-query <name>   For an API that wants it in the query
      --allowed-origin <origin>   Allow this browser origin. Repeatable
      --allowed-host <name>       Allow this Host. Repeatable
      --otlp <url>                Send traces to this address, and nowhere else
      --config <file>             JWT settings, limits and timeouts
      --quiet                     No per-call log lines

  keys create|list|revoke <id>  --db <file>   Manage keys
      --label <text>  --read <tool>  --write <tool>
  audit --db <file>                           Who did what
      --denied  --limit <n>
  credential set --db <file>                  Seal the upstream credential into the file
  fault-api                                   The API that fails on command
      --port <n>                  Default: 8787

  prove --self                                Crumple's claims, with failures on purpose
  prove --load                                Crumple under load, on this machine
      --step-ms <n>               How long each step runs. Default: 5000
  prove <url>                                 Check a server you own, from outside
  prove -- <command>                          The same, for a local server over stdio
      --call <tool>  --args <json>  The one tool that may be called. None is otherwise
      --parallel <n>              Call it this many at once, only if it says it's read-only
      --max-requests <n>          Default: 30
      --timeout-ms <n>            Default: 10000
      --out <folder>              Write the report here as Markdown, JSON and a badge

  eval [folder]                               Agent scenarios, replayed free from recordings
      --only <id>                 Just this scenario. Repeatable
      --break-descriptions        Give every tool a useless description, to test the gate
      --out <folder>              Write the report here as Markdown and JSON
      --live                      Use a real model. Spends real money, with your key
      --max-usd <n>               Stop at this. Default: 1
      --reps <n>                  Runs per scenario. Default: 5
      --model <id>                Default: claude-haiku-5-5
      --record                    Keep one passing run per scenario, for replay
      --transcripts <folder>      Keep every run in full

  --help, --version

The upstream credential comes from CRUMPLE_UPSTREAM_CREDENTIAL, and prove's token from
CRUMPLE_PROVE_TOKEN, and eval's key from ANTHROPIC_API_KEY. None is ever a flag.
This sends no telemetry. --otlp only sends to an address you typed.`;

async function dispatch(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;

  // After a command, a request for help is still a request for help, and never a bad flag.
  if (rest.includes('--help') || rest.includes('-h')) {
    io.stdout(HELP);
    return 0;
  }

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      io.stdout(HELP);
      return 0;
    case '--version':
    case '-v':
      io.stdout(readVersion());
      return 0;
    case 'serve':
      return (await import('./serve.js')).serveCommand(rest, io);
    case 'keys':
      return (await import('./keys.js')).keysCommand(rest, io);
    case 'audit':
      return (await import('./audit.js')).auditCommand(rest, io);
    case 'credential':
      return (await import('./credentials.js')).credentialCommand(rest, io);
    case 'fault-api':
      return (await import('./fault-api.js')).faultApiCommand(rest, io);
    case 'prove':
      return (await import('./prove.js')).proveCommand(rest, io);
    case 'demo':
      return (await import('./demo.js')).demoCommand(rest, io);
    case 'eval':
      return (await import('./eval.js')).evalCommand(rest, io);
    default:
      throw usage(`There's no command called ${command}. Run crumple-mcp --help to see them.`);
  }
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(error.message);
      return error.exitCode;
    }
    io.stderr(`Something unexpected went wrong: ${(error as Error).message}`);
    return 1;
  }
}
