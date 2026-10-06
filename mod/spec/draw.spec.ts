// Plain unit tests for the draw logic. Run: node --test mod/spec/
// (named *.spec.ts so `claude plugin test`, which runs *.test.ts, leaves them alone)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryFor, drawName, pickName, type Pool } from '../hooks/draw.ts';
import { POOL } from '../hooks/pool.ts';

const pool: Pool = {
  categories: [
    { key: 'explore', subagent_types: ['Explore'], keywords: ['search', 'find'], names: ['Magellan', 'Cook'] },
    { key: 'code', subagent_types: ['general-purpose', 'worker'], keywords: ['implement'], names: ['Hopper', 'Lovelace', 'Turing'] },
    { key: 'debug', subagent_types: ['debugger'], keywords: ['debug', 'bug', 'crash'], names: ['Holmes'] },
    { key: 'default', subagent_types: ['default'], keywords: [], names: ['Vega', 'Rigel'] },
  ],
};
const first = () => 0; // always the first candidate

test('a specific subagent_type picks its category', () => {
  assert.equal(categoryFor(pool, 'Explore', 'implement the parser'), 'explore');
});

test('subagent_type match is case-insensitive', () => {
  assert.equal(categoryFor(pool, 'explore', undefined), 'explore');
});

test('a generic role is task-first: keywords on the description win', () => {
  assert.equal(categoryFor(pool, 'general-purpose', 'Find the crash bug in auth'), 'debug'); // 2 debug hits (crash, bug) vs 1 explore hit
});

test('a generic role with no keyword hit falls back to its own category', () => {
  assert.equal(categoryFor(pool, 'general-purpose', 'sleep 5 seconds'), 'code');
});

test('an omitted subagent_type counts as general-purpose', () => {
  assert.equal(categoryFor(pool, undefined, 'say ok'), 'code');
});

test('an unknown custom role uses keywords, then the default pool', () => {
  assert.equal(categoryFor(pool, 'my-custom-agent', 'search the repo'), 'explore');
  assert.equal(categoryFor(pool, 'my-custom-agent', 'say ok'), 'default');
});

test('keyword ties go to the earlier category', () => {
  assert.equal(categoryFor(pool, 'my-custom-agent', 'search for the crash'), 'explore');
});

test('a theme override pins the category', () => {
  assert.equal(categoryFor(pool, 'Explore', 'search', 'debug'), 'debug');
});

test('an unknown theme is ignored', () => {
  assert.equal(categoryFor(pool, 'Explore', 'x', 'nope'), 'explore');
});

test('drawName skips live names, case-insensitively', () => {
  assert.equal(drawName(pool, 'code', ['hopper'], first), 'Lovelace');
});

test('drawName uses rand to choose among free names', () => {
  assert.equal(drawName(pool, 'code', [], () => 0.99), 'Turing');
});

test('an exhausted category spills to the default pool', () => {
  assert.equal(drawName(pool, 'debug', ['Holmes'], first), 'Vega');
});

test('when default is exhausted too, any free name in the registry is used', () => {
  assert.equal(drawName(pool, 'debug', ['Holmes', 'Vega', 'Rigel'], first), 'Magellan');
});

test('when every name is taken, a numbered suffix keeps it unique', () => {
  const all = pool.categories.flatMap(c => c.names);
  assert.equal(drawName(pool, 'debug', all, first), 'Holmes-2');
  assert.equal(drawName(pool, 'debug', [...all, 'Holmes-2'], first), 'Holmes-3');
});

test('three same-type draws in a row are distinct', () => {
  const taken: string[] = [];
  for (let i = 0; i < 3; i++) taken.push(pickName(pool, { subagentType: 'general-purpose', description: 'say ok', taken, rand: first }).name);
  assert.deepEqual(taken, ['Hopper', 'Lovelace', 'Turing']);
});

test('pickName reports the category it drew from', () => {
  assert.deepEqual(pickName(pool, { subagentType: 'debugger', description: '', taken: [], rand: first }), { name: 'Holmes', category: 'debug' });
});

test('the generated pool matches the registry shape: 14 categories, 395 unique names', () => {
  assert.equal(POOL.categories.length, 14);
  const names = POOL.categories.flatMap(c => c.names);
  assert.equal(names.length, 395);
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, 395);
  assert.ok(POOL.categories.some(c => c.key === 'default'));
});

test('real pool: Explore draws an explorer, general-purpose "implement" draws code', () => {
  const ex = POOL.categories.find(c => c.key === 'explore')!;
  assert.ok(ex.names.includes(pickName(POOL, { subagentType: 'Explore', description: 'x', taken: [], rand: Math.random }).name));
  assert.equal(pickName(POOL, { subagentType: 'general-purpose', description: 'implement the endpoint', taken: [], rand: Math.random }).category, 'code');
});
