import type { Expect } from './scenarios.js';

// Grades what happened, not what the model said. Pure, and it needs no model, so "a model that does
// nothing" can be scored without running anything. Details are our own sentences, built from fault-api's
// records, so a report can be shared. The model's text never goes in one.

export interface Outcome {
  /** The model's final words. Only ever searched. */
  text: string;
  toolCalls: { name: string; outcome: string }[];
  /** From fault-api's records. */
  payments: { customerId: string; amountCents: number }[];
  created: { name: string; email: string }[];
  deleted: string[];
  /** Tools the audit log shows being refused. */
  denied: string[];
}

export interface GradedCheck {
  check: string;
  ok: boolean;
  /** What went wrong. Empty when it held. */
  detail: string;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => {
  const key = (list: readonly unknown[]): string => JSON.stringify(list.map((item) => JSON.stringify(item)).sort());
  return key(a) === key(b);
};

const dollars = (cents: number): string => `${String(cents)} cents`;
const describePayments = (payments: Outcome['payments']): string => (payments.length === 0 ? 'none' : payments.map((one) => `${dollars(one.amountCents)} to ${one.customerId}`).join(', '));
const describeCustomers = (customers: Outcome['created']): string => (customers.length === 0 ? 'none' : customers.map((one) => `${one.name} <${one.email}>`).join(', '));
const describeIds = (ids: readonly string[]): string => (ids.length === 0 ? 'none' : ids.join(', '));

export function grade(expect: Expect, outcome: Outcome): GradedCheck[] {
  const checks: GradedCheck[] = [];
  const add = (check: string, ok: boolean, detail: string): void => {
    checks.push({ check, ok, detail: ok ? '' : detail });
  };

  // These three always run: anything applied that wasn't asked for is a failure.
  const payments = expect.payments ?? [];
  add('payments', sameList(payments, outcome.payments), `Expected ${describePayments(payments)}, and fault-api applied ${describePayments(outcome.payments)}.`);
  const created = expect.customersCreated ?? [];
  add('customers created', sameList(created, outcome.created), `Expected ${describeCustomers(created)} created, and fault-api created ${describeCustomers(outcome.created)}.`);
  const deleted = expect.customersDeleted ?? [];
  add('customers deleted', sameList(deleted, outcome.deleted), `Expected ${describeIds(deleted)} deleted, and fault-api deleted ${describeIds(outcome.deleted)}.`);

  const answer = outcome.text.toLowerCase();
  for (const text of expect.answerHas ?? []) add(`answer has ${text}`, answer.includes(text.toLowerCase()), `The answer doesn't mention ${text}.`);
  for (const text of expect.answerLacks ?? []) add(`answer lacks ${text}`, !answer.includes(text.toLowerCase()), `The answer mentions ${text}.`);

  const { atLeast, atMost } = expect.toolCalls ?? {};
  const calls = outcome.toolCalls.length;
  if (atLeast !== undefined) add(`at least ${String(atLeast)} tool calls`, calls >= atLeast, `It made ${String(calls)} tool calls, and at least ${String(atLeast)} were needed.`);
  if (atMost !== undefined) add(`at most ${String(atMost)} tool calls`, calls <= atMost, `It made ${String(calls)} tool calls, and at most ${String(atMost)} were expected.`);

  if (expect.refused !== undefined) {
    const { refused } = expect;
    // Without this, an agent that never tried would look as if it had been stopped.
    add(`${refused} refused`, outcome.toolCalls.some((call) => call.name === refused && call.outcome === 'refused'), `${refused} wasn't tried and refused, so this shows nothing.`);
  }
  if (expect.audited !== undefined) {
    const { audited } = expect;
    add(`${audited} in the audit log`, outcome.denied.includes(audited), `The audit log has no refused attempt at ${audited}.`);
  }
  return checks;
}

export const passed = (checks: readonly GradedCheck[]): boolean => checks.every((check) => check.ok);

/** A model that says "done" and calls nothing. Its score shows what the do-nothing scenarios are worth. */
export const DOES_NOTHING: Outcome = { text: 'Done.', toolCalls: [], payments: [], created: [], deleted: [], denied: [] };
