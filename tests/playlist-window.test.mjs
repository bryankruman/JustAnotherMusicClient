import test from 'node:test';
import assert from 'node:assert/strict';
import { playlistWindow, PLAYLIST_ROW_HEIGHT } from '../src/ui/pages/playlistWindow.ts';

test('a 10,000-song library mounts a bounded viewport at top, middle, and bottom', () => {
  for (const top of [0, 5000 * PLAYLIST_ROW_HEIGHT, 10000 * PLAYLIST_ROW_HEIGHT - 800]) {
    const { start, end } = playlistWindow(10000, top, 800);
    assert.ok(end - start <= 31);
    assert.ok(start >= 0 && end <= 10000);
    assert.ok(start * PLAYLIST_ROW_HEIGHT <= top);
    assert.ok(end * PLAYLIST_ROW_HEIGHT >= top + 800);
  }
});
test('empty and filtered lists clamp their visible range', () => {
  assert.deepEqual(playlistWindow(0, 0, 800), { start: 0, end: 0 });
  assert.deepEqual(playlistWindow(3, -500, 800), { start: 0, end: 3 });
  const range = playlistWindow(3, 100000, 800);
  assert.ok(range.start <= range.end && range.end <= 3);
});
