#!/usr/bin/env node
// Copies the latest report to where the demo's page reads it, with only what the page shows. Wrangler
// runs this before dev and deploy, so the page can't show a report older than the one in the repo.

import { readFileSync, writeFileSync } from 'node:fs';

const proof = JSON.parse(readFileSync(new URL('../proof/latest.json', import.meta.url), 'utf8'));
const { commit, os, cpu, memoryGb, node } = proof.environment;

writeFileSync(new URL('../workers/public/proof.json', import.meta.url), `${JSON.stringify({
  startedAt: proof.startedAt,
  environment: { commit, os, cpu, memoryGb, node },
  counts: proof.counts,
  claims: proof.claims.map((/** @type {{ id: string, text: string, state: string }} */ { id, text, state }) => ({ id, text, state })),
}, null, 2)}\n`);
