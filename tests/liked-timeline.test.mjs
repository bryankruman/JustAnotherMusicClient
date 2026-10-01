import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const source = await readFile(new URL('../src/ui/pages/likedTimeline.ts', import.meta.url), 'utf8');
const code = await transform(source, { loader: 'ts', format: 'esm' });
const { buildLikedTimeline } = await import(`data:text/javascript;base64,${Buffer.from(code.code).toString('base64')}`);
const at = value => Date.parse(`${value}T12:00:00-04:00`);
const date = value => new Date(at(value)).toISOString();
const estimate = (from, to) => ({ earliest: at(from), latest: at(to), usesPublication: false });
test('timeline preserves month, year, range, and unknown precision without inventing a month', () => {
  const timeline = buildLikedTimeline(['a', 'b', 'c', 'd', 'e'].map(id => ({ id })),
    { a: date('2026-09-01') }, { b: estimate('2026-06-01', '2026-08-20'),
      c: estimate('2025-01-01', '2025-12-31'), d: estimate('2022-01-01', '2023-12-31') });
  assert.deepEqual(timeline.years.map(y => y.label), ['2026', '2025', '2022–2023', 'Unknown']);
  assert.deepEqual(timeline.years[0].months.map(m => m.label), ['Sep']);
  assert.equal(timeline.positions[1].year, '2026');
  assert.equal(timeline.positions[1].month, undefined);
  assert.equal(timeline.years[1].months.length, 0);
  assert.equal(timeline.years[2].months.length, 0);
  assert.equal(timeline.positions[4].year, 'unknown');
});
test('jumps use indices in the displayed filtered order, including oldest-first and repeated years', () => {
  const tracks = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  const dates = { a: date('2026-09-01'), b: date('2025-06-01'), c: date('2026-08-01'), d: date('2024-01-01') };
  const forward = buildLikedTimeline(tracks, dates, {});
  assert.equal(forward.years[0].months[1].index, 2);
  assert.equal(forward.positions[2].year, '2026');
  const reverse = buildLikedTimeline([...tracks].reverse(), dates, {});
  assert.equal(reverse.years[0].label, '2024');
  assert.equal(reverse.years[1].months[0].index, 1);
  const filtered = buildLikedTimeline(tracks.slice(2), dates, {});
  assert.equal(filtered.years[0].index, 0);
  assert.equal(filtered.years[1].index, 1);
  assert.deepEqual(buildLikedTimeline([], dates, {}), { years: [], positions: [] });
});
