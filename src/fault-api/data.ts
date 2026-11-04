// The fake business: customers and payments. No HTTP objects and no faults in here,
// so what the API does when it behaves stays separate from how it misbehaves.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export interface Reply {
  status: number;
  body: JsonObject;
}

export interface Effect {
  kind: 'customer.created' | 'customer.deleted' | 'payment.created';
  id: string;
}

interface Customer extends JsonObject {
  id: string;
  name: string;
  email: string;
  status: string;
  notes: string;
}

interface Payment extends JsonObject {
  id: string;
  customerId: string;
  amountCents: number;
  currency: string;
  status: string;
}

export interface Data {
  customers: Map<string, Customer>;
  payments: Map<string, Payment>;
  nextCustomer: number;
  nextPayment: number;
  effects: Effect[];
  maxRecords: number;
  maxLogEntries: number;
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

// Obviously fake on purpose: example.com is reserved, and nobody is called this.
const SEED: Customer[] = [
  { id: 'cus_1', name: 'Ada Example', email: 'ada@example.com', status: 'active', notes: 'Prefers email.' },
  { id: 'cus_2', name: 'Grace Sample', email: 'grace@example.com', status: 'active', notes: 'Annual plan.' },
  { id: 'cus_3', name: 'Alan Placeholder', email: 'alan@example.com', status: 'inactive', notes: 'Paused in March.' },
];

export function createData(limits: { maxRecords: number; maxLogEntries: number }): Data {
  return {
    customers: new Map(SEED.map((customer) => [customer.id, { ...customer }])),
    payments: new Map(),
    nextCustomer: SEED.length + 1,
    nextPayment: 1,
    effects: [],
    ...limits,
  };
}

export function failure(status: number, code: string, message: string): Reply {
  return { status, body: { error: { code, message } } };
}

function record(data: Data, effect: Effect): void {
  data.effects.push(effect);
  if (data.effects.length > data.maxLogEntries) data.effects.shift();
}

function parseObject(text: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

const NOT_JSON = failure(400, 'invalid_body', 'The request body must be a JSON object.');
const DATA_FULL = failure(507, 'data_full', 'This demo holds a limited number of records. Reset it to add more.');

function listCustomers(data: Data, query: URLSearchParams): Reply {
  const raw = query.get('limit');
  const limit = raw === null ? DEFAULT_LIST_LIMIT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    return failure(400, 'invalid_limit', 'limit must be a whole number of 1 or more.');
  }
  return { status: 200, body: { items: [...data.customers.values()].slice(0, Math.min(limit, MAX_LIST_LIMIT)) } };
}

function createCustomer(data: Data, text: string): Reply {
  const input = parseObject(text);
  if (!input) return NOT_JSON;
  if (typeof input['name'] !== 'string' || input['name'] === '') {
    return failure(400, 'invalid_name', 'name is required and must be text.');
  }
  if (data.customers.size >= data.maxRecords) return DATA_FULL;

  const id = `cus_${data.nextCustomer++}`;
  const email = typeof input['email'] === 'string' ? input['email'] : `${id}@example.com`;
  const customer: Customer = { id, name: input['name'], email, status: 'active', notes: '' };
  data.customers.set(id, customer);
  record(data, { kind: 'customer.created', id });
  return { status: 201, body: customer };
}

function deleteCustomer(data: Data, id: string): Reply {
  if (!data.customers.delete(id)) return failure(404, 'not_found', `There is no customer ${id}.`);
  record(data, { kind: 'customer.deleted', id });
  return { status: 200, body: { id, deleted: true } };
}

function createPayment(data: Data, text: string): Reply {
  const input = parseObject(text);
  if (!input) return NOT_JSON;
  const { customerId, amountCents } = input;
  if (typeof customerId !== 'string') return failure(400, 'invalid_customer', 'customerId is required.');
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents < 1) {
    return failure(400, 'invalid_amount', 'amountCents must be a whole number of 1 or more.');
  }
  if (!data.customers.has(customerId)) return failure(404, 'not_found', `There is no customer ${customerId}.`);
  if (data.payments.size >= data.maxRecords) return DATA_FULL;

  const id = `pay_${data.nextPayment++}`;
  const payment: Payment = { id, customerId, amountCents, currency: 'usd', status: 'succeeded' };
  data.payments.set(id, payment);
  record(data, { kind: 'payment.created', id });
  return { status: 201, body: payment };
}

export function route(data: Data, method: string, path: string, query: URLSearchParams, text: string): Reply {
  const wrongMethod = failure(405, 'method_not_allowed', `${path} doesn't support ${method}.`);

  if (path === '/customers') {
    if (method === 'GET') return listCustomers(data, query);
    if (method === 'POST') return createCustomer(data, text);
    return wrongMethod;
  }

  if (path === '/payments') return method === 'POST' ? createPayment(data, text) : wrongMethod;

  const customer = /^\/customers\/([^/]+)$/.exec(path)?.[1];
  if (customer !== undefined) {
    if (method === 'DELETE') return deleteCustomer(data, customer);
    if (method !== 'GET') return wrongMethod;
    const found = data.customers.get(customer);
    return found ? { status: 200, body: found } : failure(404, 'not_found', `There is no customer ${customer}.`);
  }

  const payment = /^\/payments\/([^/]+)$/.exec(path)?.[1];
  if (payment !== undefined) {
    if (method !== 'GET') return wrongMethod;
    const found = data.payments.get(payment);
    return found ? { status: 200, body: found } : failure(404, 'not_found', `There is no payment ${payment}.`);
  }

  return failure(404, 'unknown_path', `There is nothing at ${path}.`);
}
