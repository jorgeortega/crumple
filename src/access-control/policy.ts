// What a caller may do. This is the check that prompt injection can't reach: its only inputs
// are who is calling and which tool. No arguments, no prompt, no tool output, so nothing the
// model read or wrote can change the answer. The limit: a caller who does hold a permission can
// still be talked into using it. This limits the damage. It doesn't prevent the attack.

export interface Grant {
  /** A tool's exact name, or '*' for every read. */
  tool: string;
  /** Only counts on a named grant: '*' can never write. */
  writes?: boolean;
}

export interface Principal {
  /** Safe to record: a key's id or a hash, never the key or a person's name. */
  id: string;
  kind: 'key' | 'jwt';
  // There's deliberately no token here. Later code has nothing to forward upstream (C3).
  grants: readonly Grant[];
}

export interface ToolInfo {
  name: string;
  writes: boolean;
}

export type Decision =
  | { allow: true; grant: string }
  | { allow: false; reason: 'no_grant' | 'writes_not_allowed' };

/**
 * Deny by default. Pure: no network, no clock, no throwing. Pass `undefined` for a tool that
 * doesn't exist, so that it gets the same answer as one the caller can't use.
 */
export function decide(principal: Principal, tool: ToolInfo | undefined): Decision {
  if (!tool) return { allow: false, reason: 'no_grant' };

  // Every grant is considered, so their order can't change the answer.
  const named = principal.grants.find((grant) => grant.tool === tool.name && grant.tool !== '*' && (!tool.writes || grant.writes === true));
  if (named) return { allow: true, grant: named.tool };

  const matches = principal.grants.some((grant) => grant.tool === tool.name || grant.tool === '*');
  if (!matches) return { allow: false, reason: 'no_grant' };
  if (tool.writes) return { allow: false, reason: 'writes_not_allowed' };
  return { allow: true, grant: '*' };
}

/** A grant of `*` with `writes` would never work, so it's refused where it's written rather than left to confuse someone. */
export function findWildcardWrite(grants: readonly Grant[]): boolean {
  return grants.some((grant) => grant.tool === '*' && grant.writes === true);
}
