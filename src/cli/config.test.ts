import { describe, expect, it } from 'vitest';
import { checkConfig, parseConfig } from './config.js';

const JWT = {
  issuer: 'https://login.test/',
  audience: 'https://mcp.test/mcp',
  jwksUri: 'https://login.test/jwks.json',
  resource: 'https://mcp.test/mcp',
  scopes: { read: [{ tool: '*' }], pay: [{ tool: 'createPayment', writes: true }] },
};

describe('a good config', () => {
  it('passes with everything in it', () => {
    const config = { jwt: { ...JWT, requireAccessTokenType: true }, deadlineMs: 15_000, attemptTimeoutMs: 5_000, retry: { attempts: 2, baseMs: 100, capMs: 1_000 }, limits: { perCaller: 5, perUpstream: 10, queuePerCaller: 2, queueUpstream: 3 } };
    expect(checkConfig(config)).toEqual(config);
  });

  it('passes empty', () => {
    expect(checkConfig({})).toEqual({});
  });

  it('reads YAML and JSON', () => {
    expect(parseConfig('deadlineMs: 100', 'c.yaml')).toEqual({ deadlineMs: 100 });
    expect(parseConfig('{"deadlineMs": 100}', 'c.json')).toEqual({ deadlineMs: 100 });
  });
});

// Each message names the field, so a person can fix it without reading the source.
describe('a bad config', () => {
  it.each<[string, unknown, RegExp]>([
    ['a misspelt top-level field', { deadlineMS: 100 }, /deadlineMS isn't something Crumple knows/],
    ['a list at the top', [], /the top level should be an object/],
    ['nothing at all', null, /the top level should be an object/],
    ['a secret, which has no field', { credential: 'Bearer x' }, /credential isn't something Crumple knows/],
    ['a deadline that isn\'t a number', { deadlineMs: 'soon' }, /deadlineMs should be a whole number/],
    ['a zero deadline', { deadlineMs: 0 }, /deadlineMs should be a whole number/],
    ['a negative timeout', { attemptTimeoutMs: -1 }, /attemptTimeoutMs should be a whole number/],
    ['a fractional limit', { limits: { perCaller: 1.5 } }, /limits.perCaller should be a whole number/],
    ['a misspelt limit', { limits: { perCaler: 1 } }, /limits.perCaler isn't something/],
    ['limits that aren\'t an object', { limits: 5 }, /limits should be an object/],
    ['a misspelt retry field', { retry: { attempt: 1 } }, /retry.attempt isn't something/],
    ['a jwt that isn\'t an object', { jwt: 'x' }, /jwt should be an object/],
    ['a misspelt jwt field', { jwt: { ...JWT, issuerr: 'x' } }, /jwt.issuerr isn't something/],
    ['no scopes', { jwt: { ...JWT, scopes: undefined } }, /jwt.scopes is required/],
    ['no issuer', { jwt: { ...JWT, issuer: undefined } }, /jwt.issuer is required/],
    ['an empty audience', { jwt: { ...JWT, audience: '' } }, /jwt.audience is required/],
    ['a jwksUri that isn\'t a URL', { jwt: { ...JWT, jwksUri: 'nope' } }, /jwt.jwksUri should be a full URL/],
    ['a resource that isn\'t a URL', { jwt: { ...JWT, resource: 'nope' } }, /jwt.resource should be a full URL/],
    ['a scope that isn\'t a list', { jwt: { ...JWT, scopes: { read: 'x' } } }, /jwt.scopes.read should be a list/],
    ['a grant with no tool', { jwt: { ...JWT, scopes: { read: [{}] } } }, /jwt.scopes.read\[0\].tool is required/],
    ['a grant that isn\'t an object', { jwt: { ...JWT, scopes: { read: ['x'] } } }, /jwt.scopes.read\[0\] should be an object/],
    ['a misspelt grant field, which must not silently do nothing', { jwt: { ...JWT, scopes: { pay: [{ tool: 'pay', write: true }] } } }, /jwt.scopes.pay\[0\].write isn't something/],
    ['writes that isn\'t a boolean', { jwt: { ...JWT, scopes: { pay: [{ tool: 'pay', writes: 'yes' }] } } }, /writes should be true or false/],
    ['a type check that isn\'t a boolean', { jwt: { ...JWT, requireAccessTokenType: 'yes' } }, /requireAccessTokenType should be true or false/],
  ])('refuses %s', (_name, value, message) => {
    expect(() => checkConfig(value)).toThrow(message);
  });

  it('refuses text that isn\'t JSON or YAML, and says which file', () => {
    expect(() => parseConfig('{ nope: [', 'bad.yaml')).toThrow(/bad.yaml.*Check that it's JSON or YAML/);
  });
});
