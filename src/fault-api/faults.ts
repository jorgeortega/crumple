// Reads the x-fault header. Pure, so a table of cases can test every rule, and strict,
// because a typo in a test must never quietly mean "no fault" and look like a pass.

export interface Fault {
  status?: number;
  retryAfterSeconds?: number;
  times?: number;
  delayMs?: number;
  hang?: boolean;
  stallBody?: boolean;
  drop?: boolean;
  inject?: boolean;
  echoAuth?: boolean;
  largeBytes?: number;
  notJson?: boolean;
}

export type ParsedFault = { ok: true; fault: Fault } | { ok: false; error: string };

// A public demo must not become a way to tie up resources, so these live here.
export const MAX_WAIT_MS = 30_000;
export const MAX_LARGE_BYTES = 10 * 1024 * 1024;
const MAX_HEADER_LENGTH = 256;
const MAX_RETRY_AFTER_SECONDS = 86_400;

const refuse = (error: string): ParsedFault => ({ ok: false, error });

function wholeNumber(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

type Rule = (fault: Fault, value: number) => string | undefined;

const NUMBERS: Record<string, Rule> = {
  status(fault, value) {
    if (value < 400 || value > 599) return 'status must be a failure, from 400 to 599.';
    fault.status = value;
    return undefined;
  },
  'retry-after'(fault, value) {
    fault.retryAfterSeconds = Math.min(value, MAX_RETRY_AFTER_SECONDS);
    return undefined;
  },
  times(fault, value) {
    if (value < 1) return 'times must be 1 or more.';
    fault.times = value;
    return undefined;
  },
  delay(fault, value) {
    fault.delayMs = Math.min(value, MAX_WAIT_MS);
    return undefined;
  },
  large(fault, value) {
    fault.largeBytes = Math.min(value, MAX_LARGE_BYTES);
    return undefined;
  },
};

const FLAGS: Record<string, keyof Fault> = {
  hang: 'hang',
  'stall-body': 'stallBody',
  drop: 'drop',
  inject: 'inject',
  'echo-auth': 'echoAuth',
  'not-json': 'notJson',
};

// Rules about combinations, so a request can't ask for something meaningless and get an
// answer that looks deliberate.
function checkCombination(fault: Fault): string | undefined {
  const shapes = [fault.hang, fault.stallBody, fault.drop, fault.largeBytes !== undefined, fault.notJson].filter(Boolean);
  if (shapes.length > 1) return 'Use only one of hang, stall-body, drop, large and not-json.';

  const endsWithoutAStatus = fault.hang === true || fault.stallBody === true || fault.drop === true || fault.largeBytes !== undefined;
  if (fault.status !== undefined && endsWithoutAStatus) return 'status can only be combined with not-json, inject, echo-auth, delay and times.';
  if (fault.retryAfterSeconds !== undefined && fault.status === undefined) return 'retry-after needs a status.';
  if (fault.delayMs !== undefined && fault.hang) return 'delay and hang can\'t be combined.';
  if (shapes.length > 0 && fault.inject) return 'inject needs a JSON body, so it can\'t be combined with hang, stall-body, drop, large or not-json.';
  if (shapes.length > 0 && fault.echoAuth) return 'echo-auth needs a JSON body, so it can\'t be combined with hang, stall-body, drop, large or not-json.';

  const { times, ...rest } = fault;
  if (times !== undefined && Object.keys(rest).length === 0) return 'times needs a fault to count.';
  return undefined;
}

export function parseFault(header: string | null): ParsedFault {
  if (header === null || header.trim() === '') return { ok: true, fault: {} };
  if (header.length > MAX_HEADER_LENGTH) return refuse(`x-fault is too long. It can be at most ${MAX_HEADER_LENGTH} characters.`);

  const fault: Fault = {};
  const seen = new Set<string>();

  for (const part of header.split(';')) {
    const [rawName = '', value] = part.split('=', 2);
    const name = rawName.trim();
    if (seen.has(name)) return refuse(`${name} appears more than once in x-fault.`);
    seen.add(name);

    const flag = FLAGS[name];
    const rule = NUMBERS[name];
    if (flag) {
      if (value !== undefined) return refuse(`${name} takes no value.`);
      Object.assign(fault, { [flag]: true });
    } else if (rule) {
      const number = wholeNumber((value ?? '').trim());
      if (number === undefined) return refuse(`${name} needs a whole number, such as ${name}=1.`);
      const problem = rule(fault, number);
      if (problem) return refuse(problem);
    } else {
      return refuse(`"${name}" is an unknown fault. Known ones: ${[...Object.keys(NUMBERS), ...Object.keys(FLAGS)].join(', ')}.`);
    }
  }

  const problem = checkCombination(fault);
  return problem ? refuse(problem) : { ok: true, fault };
}
