import type { CheckOutcome } from './checks.js';

// The project's claims, as SPEC.md lists them. A claim only passes when all of its parts ran, so
// `pending` is how a report says "this held, and that part hasn't been checked here".

export interface Claim {
  id: string;
  text: string;
  /** A part of this claim that prove --self doesn't check, and where it's checked instead. */
  pending?: string;
}

export const CLAIMS: readonly Claim[] = [
  { id: 'C1', text: 'Access is denied by default' },
  { id: 'C2', text: 'The model can\'t talk its way past a permission', pending: 'the part with a real model needs evals (Task 28)' },
  { id: 'C3', text: 'The agent\'s token never reaches the upstream API' },
  { id: 'C4', text: 'The stored credential never leaks' },
  { id: 'C5', text: 'A write is never applied twice' },
  { id: 'C6', text: 'No call outlives its deadline' },
  { id: 'C7', text: 'Only temporary failures are retried' },
  { id: 'C8', text: 'A failing upstream stops being hit' },
  { id: 'C9', text: 'One noisy caller can\'t starve another' },
  { id: 'C10', text: 'Failures tell the agent what to do next', pending: 'the part where an agent recovers needs evals (Task 28)' },
  { id: 'C11', text: 'Every call can be traced end to end', pending: 'needs the agent runner (Task 27)' },
  { id: 'C12', text: 'Each run reports its tokens and cost', pending: 'needs the agent runner (Task 27)' },
  { id: 'C13', text: 'A behaviour regression gets caught', pending: 'needs evals (Task 28)' },
  { id: 'C14', text: 'It speaks real MCP', pending: 'needs Python, so it runs in npm run test:interop' },
  { id: 'C15', text: 'The public demo can\'t run up a bill or be abused', pending: 'needs the hosted demo (Task 31)' },
  { id: 'C16', text: 'A stranger succeeds in 60 seconds', pending: 'needs the demo command (Task 24)' },
  { id: 'C17', text: 'prove is safe to point at a real server' },
  { id: 'C18', text: 'Tool definitions have a visible cost' },
];

export type ClaimState = 'pass' | 'partly' | 'fail' | 'not_run';

export interface ClaimOutcome {
  id: string;
  text: string;
  state: ClaimState;
  checks: string[];
  pending?: string;
}

export function rollUpClaims(outcomes: readonly CheckOutcome[], claims: readonly Claim[] = CLAIMS): ClaimOutcome[] {
  return claims.map((claim) => {
    const mine = outcomes.filter((outcome) => outcome.claim === claim.id);
    const ran = mine.filter((outcome) => outcome.state !== 'not_run');
    let state: ClaimState;
    if (mine.some((outcome) => outcome.state === 'fail')) state = 'fail';
    else if (ran.length === 0) state = 'not_run';
    // One thing that didn't run is enough to stop a claim passing.
    else if (claim.pending !== undefined || ran.length < mine.length) state = 'partly';
    else state = 'pass';
    return {
      id: claim.id,
      text: claim.text,
      state,
      checks: mine.map((outcome) => outcome.id),
      ...(claim.pending === undefined ? {} : { pending: claim.pending }),
    };
  });
}
