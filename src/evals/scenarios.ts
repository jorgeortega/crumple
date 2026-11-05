import { parseFault } from '../fault-api/index.js';

// A scenario is a task, a key, maybe a failure, and what should have happened. They're plain files, so
// reading the list of cases doesn't mean reading code. Loading is strict: a typo in an expectation
// would otherwise quietly check nothing, and pass.

export type ScenarioKind = 'safety' | 'behaviour' | 'observation';

export const KEYS = ['read', 'write', 'other', 'all'] as const;
export type ScenarioKey = (typeof KEYS)[number];

export interface Expect {
  /** Facts that had to be looked up. Ignores case. */
  answerHas?: string[];
  answerLacks?: string[];
  /** These three are exact: anything fault-api applied that isn't listed is a failure. */
  payments?: { customerId: string; amountCents: number }[];
  customersCreated?: { name: string; email: string }[];
  customersDeleted?: string[];
  /** Only where the path is the point, such as not hammering a failing API. */
  toolCalls?: { atLeast?: number; atMost?: number };
  /** This tool was tried, and the server refused it. */
  refused?: string;
  /** The audit log has the refused attempt. */
  audited?: string;
}

export interface Scenario {
  id: string;
  kind: ScenarioKind;
  task: string;
  key: ScenarioKey;
  fault?: string;
  expect: Expect;
  /** Run by a built-in model, with no key, on every eval. */
  scripted?: 'obeys-injection';
  /** For an observation: what a failed run did, as a report should word it. */
  observedAs?: string;
}

const SCENARIO_FIELDS = new Set(['id', 'kind', 'task', 'key', 'fault', 'expect', 'scripted', 'observedAs']);
const EXPECT_FIELDS = new Set(['answerHas', 'answerLacks', 'payments', 'customersCreated', 'customersDeleted', 'toolCalls', 'refused', 'audited']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

function unknownField(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(value).find((name) => !allowed.has(name));
}

function expectProblem(expect: unknown): string | undefined {
  if (!isObject(expect)) return 'expect should be an object';
  const extra = unknownField(expect, EXPECT_FIELDS);
  if (extra !== undefined) return `expect has an unknown field, ${extra}`;
  const { answerHas, answerLacks, payments, customersCreated, customersDeleted, toolCalls, refused, audited } = expect;
  if (answerHas !== undefined && !isStrings(answerHas)) return 'answerHas should be a list of strings';
  if (answerLacks !== undefined && !isStrings(answerLacks)) return 'answerLacks should be a list of strings';
  if (customersDeleted !== undefined && !isStrings(customersDeleted)) return 'customersDeleted should be a list of ids';
  if (payments !== undefined && !(Array.isArray(payments) && payments.every((one) => isObject(one) && typeof one.customerId === 'string' && typeof one.amountCents === 'number'))) return 'each payment needs a customerId and amountCents';
  if (customersCreated !== undefined && !(Array.isArray(customersCreated) && customersCreated.every((one) => isObject(one) && typeof one.name === 'string' && typeof one.email === 'string'))) return 'each customer needs a name and an email';
  if (toolCalls !== undefined && !(isObject(toolCalls) && Object.entries(toolCalls).every(([name, value]) => (name === 'atLeast' || name === 'atMost') && typeof value === 'number'))) return 'toolCalls takes atLeast and atMost, as numbers';
  if (refused !== undefined && typeof refused !== 'string') return 'refused should name a tool';
  if (audited !== undefined && typeof audited !== 'string') return 'audited should name a tool';
  return undefined;
}

function problemWith(value: unknown, expectedId: string): string | undefined {
  if (!isObject(value)) return 'it should be a JSON object';
  const extra = unknownField(value, SCENARIO_FIELDS);
  if (extra !== undefined) return `it has an unknown field, ${extra}`;
  const { id, kind, task, key, fault, scripted, observedAs, expect } = value;
  if (id !== expectedId) return `its id should match its file name, ${expectedId}`;
  if (kind !== 'safety' && kind !== 'behaviour' && kind !== 'observation') return 'kind should be safety, behaviour or observation';
  if (typeof task !== 'string' || task === '') return 'it needs a task';
  if (!KEYS.includes(key as ScenarioKey)) return `key should be one of ${KEYS.join(', ')}`;
  if (fault !== undefined) {
    if (typeof fault !== 'string') return 'fault should be a string';
    const parsed = parseFault(fault);
    if ('error' in parsed) return `its fault isn't valid: ${parsed.error}`;
  }
  if (scripted !== undefined && scripted !== 'obeys-injection') return 'the only scripted model is obeys-injection';
  if (observedAs !== undefined && typeof observedAs !== 'string') return 'observedAs should be a string';
  if ((kind === 'observation') !== (observedAs !== undefined)) return 'observedAs goes with an observation, and an observation needs one';
  return expectProblem(expect);
}

/** Throws with a message saying what's wrong, in terms of the file. */
export function parseScenario(text: string, expectedId: string): Scenario {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Scenario ${expectedId} isn't valid JSON.`);
  }
  const problem = problemWith(value, expectedId);
  if (problem !== undefined) throw new Error(`Scenario ${expectedId}: ${problem}.`);
  return value as Scenario;
}
