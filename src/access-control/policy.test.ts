import { describe, expect, it } from 'vitest';
import { decide, findWildcardWrite, type Grant, type Principal, type ToolInfo } from './policy.js';

const READ: ToolInfo = { name: 'get_customer', writes: false };
const WRITE: ToolInfo = { name: 'create_payment', writes: true };

const caller = (grants: Grant[]): Principal => ({ id: 'key_1', kind: 'key', grants });

describe('decide', () => {
  it.each<[string, Grant[], ToolInfo | undefined, ReturnType<typeof decide>]>([
    ['nothing granted, a read', [], READ, { allow: false, reason: 'no_grant' }],
    ['nothing granted, a write', [], WRITE, { allow: false, reason: 'no_grant' }],
    ['a tool that doesn\'t exist', [{ tool: '*' }], undefined, { allow: false, reason: 'no_grant' }],
    ['another tool\'s grant', [{ tool: 'list_customers' }], READ, { allow: false, reason: 'no_grant' }],
    ['* allows a read', [{ tool: '*' }], READ, { allow: true, grant: '*' }],
    ['* refuses a write', [{ tool: '*' }], WRITE, { allow: false, reason: 'writes_not_allowed' }],
    ['the name allows a read', [{ tool: 'get_customer' }], READ, { allow: true, grant: 'get_customer' }],
    ['the name alone refuses a write', [{ tool: 'create_payment' }], WRITE, { allow: false, reason: 'writes_not_allowed' }],
    ['writes: false refuses a write', [{ tool: 'create_payment', writes: false }], WRITE, { allow: false, reason: 'writes_not_allowed' }],
    ['the name with writes allows a write', [{ tool: 'create_payment', writes: true }], WRITE, { allow: true, grant: 'create_payment' }],
    ['a write grant also allows reading that tool', [{ tool: 'get_customer', writes: true }], READ, { allow: true, grant: 'get_customer' }],
  ])('%s', (_name, grants, tool, expected) => {
    expect(decide(caller(grants), tool)).toEqual(expected);
  });

  // The decision the owner approved: a broad grant can never delete anything, whatever it says.
  it('never lets * write, even if a grant claims it can', () => {
    expect(decide(caller([{ tool: '*', writes: true }]), WRITE)).toEqual({ allow: false, reason: 'writes_not_allowed' });
  });

  it('doesn\'t let a tool literally named * pick up a wildcard grant', () => {
    expect(decide(caller([{ tool: '*', writes: true }]), { name: '*', writes: true })).toEqual({ allow: false, reason: 'writes_not_allowed' });
  });

  // The sample first written in SPEC.md stopped at the first match, so this depended on order.
  it('gives the same answer whatever the order of the grants', () => {
    const wildcard: Grant = { tool: '*' };
    const named: Grant = { tool: 'create_payment', writes: true };
    expect(decide(caller([wildcard, named]), WRITE)).toEqual({ allow: true, grant: 'create_payment' });
    expect(decide(caller([named, wildcard]), WRITE)).toEqual({ allow: true, grant: 'create_payment' });
  });

  it('names the specific grant when both match a read', () => {
    expect(decide(caller([{ tool: '*' }, { tool: 'get_customer' }]), READ)).toEqual({ allow: true, grant: 'get_customer' });
  });

  it('matches names exactly', () => {
    expect(decide(caller([{ tool: 'GET_CUSTOMER' }]), READ)).toEqual({ allow: false, reason: 'no_grant' });
    expect(decide(caller([{ tool: 'get_*' }]), READ)).toEqual({ allow: false, reason: 'no_grant' });
  });
});

describe('findWildcardWrite', () => {
  it('finds the grant that can\'t mean what it says', () => {
    expect(findWildcardWrite([{ tool: 'a' }, { tool: '*', writes: true }])).toBe(true);
    expect(findWildcardWrite([{ tool: '*' }, { tool: 'a', writes: true }])).toBe(false);
  });
});
