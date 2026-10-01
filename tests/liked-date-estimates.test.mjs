import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
process.env.TZ = 'America/New_York';
async function moduleFrom(file) {
  const code = await readFile(new URL(file, import.meta.url), 'utf8');
  const compiled = await transform(code, { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
}
const { estimateLikedDates, formatLikedEstimate } = await moduleFrom('../src/datasource/youtube/likedDateEstimates.ts');
const { matchesLikedDate } = await moduleFrom('../src/datasource/youtube/likedDateFilter.ts');
const at = date => Date.parse(`${date}T12:00:00-04:00`);
const stamp = date => new Date(at(date)).toISOString();
const now = at('2026-09-25');
const pub = date => ({ publishedAt: stamp(date), checkedAt: now / 1000, retryAfter: now / 1000 + 604800 });
const tracks = (...ids) => ids.map(id => ({ id }));

test('neighboring exact added dates bracket an unknown without modifying exact dates', () => {
  const exact = { recent: stamp('2022-08-20'), old: stamp('2022-06-01') };
  const result = estimateLikedDates(tracks('recent', 'unknown', 'old'), exact, {}, now);
  assert.deepEqual(Object.keys(result), ['unknown']);
  assert.equal(formatLikedEstimate(result.unknown).label, '2022');
  assert.equal(result.unknown.earliest, at('2022-06-01'));
  assert.equal(exact.recent, stamp('2022-08-20'));
});
test('own and older neighboring publications tighten lower bounds, never upper bounds', () => {
  const result = estimateLikedDates(tracks('recent', 'a', 'b', 'old'),
    { recent: stamp('2022-08-20'), old: stamp('2022-01-01') }, { b: pub('2022-06-01') }, now);
  for (const id of ['a', 'b']) {
    assert.equal(result[id].earliest, at('2022-06-01'));
    assert.equal(result[id].latest, at('2022-08-20'));
    assert.equal(result[id].usesPublication, true);
  }
});
test('inverted exact anchors and conflicting publications do not invent dates', () => {
  assert.deepEqual(estimateLikedDates(tracks('recent', 'a', 'old'),
    { recent: stamp('2021-01-01'), old: stamp('2022-01-01') }, {}, now), {});
  const result = estimateLikedDates(tracks('recent', 'a', 'bad', 'old'),
    { recent: stamp('2022-08-20'), old: stamp('2022-06-01') }, { bad: pub('2024-01-01') }, now);
  assert.equal(result.bad, undefined);
  assert.equal(formatLikedEstimate(result.a).label, '2022');
});
test('missing lower bounds stay unknown; future publication dates and malformed metadata are ignored', () => {
  for (const publication of [undefined, pub('2027-01-01'), { ...pub('2022-01-01'), publishedAt: 'bad' }]) {
    assert.deepEqual(estimateLikedDates(tracks('a'), {}, { a: publication }, now), {});
  }
  assert.equal(formatLikedEstimate(estimateLikedDates(tracks('a'), {}, { a: pub('2022-01-01') }, now).a).label, '2022–2026');
});

test('publication dates remain usable years after retrieval and legacy retry expiry', () => {
  const publication = { ...pub('2022-06-01'), checkedAt: at('2022-07-01') / 1000, retryAfter: at('2022-07-08') / 1000 };
  const result = estimateLikedDates(tracks('recent', 'a', 'old'),
    { recent: stamp('2022-08-20'), old: stamp('2022-01-01') }, { a: publication }, now);
  assert.equal(result.a.earliest, at('2022-06-01'));
  assert.equal(result.a.usesPublication, true);
});
test('labels use the narrowest supported calendar precision without choosing a midpoint', () => {
  const examples = [
    ['2022-06-01', '2022-06-01', 'Jun 1, 2022'],
    ['2022-06-01', '2022-06-29', 'Jun 2022'],
    ['2022-06-10', '2022-08-09', '2022'],
    ['2022-01-10', '2022-12-19', '2022'],
    ['2022-06-10', '2023-08-09', '2022–2023'],
  ];
  for (const [from, to, label] of examples) {
    const formatted = formatLikedEstimate({ earliest: at(from), latest: at(to), usesPublication: false });
    assert.equal(formatted.label, label);
    assert.match(formatted.title, /Estimated added date/);
  }
});
test('date filters include overlapping estimates and unknown excludes usable estimates', () => {
  const estimate = { earliest: at('2022-06-10'), latest: at('2022-08-09') };
  const filter = { period: 'custom', from: '2022-07-01', to: '2022-07-31' };
  assert.equal(matchesLikedDate(undefined, filter, now, estimate), true);
  assert.equal(matchesLikedDate(undefined, { ...filter, from: '2023-07-01', to: '' }, now, estimate), false);
  assert.equal(matchesLikedDate(undefined, { ...filter, period: 'unknown' }, now, estimate), false);
  assert.equal(matchesLikedDate(undefined, { ...filter, period: 'unknown' }, now), true);
});
