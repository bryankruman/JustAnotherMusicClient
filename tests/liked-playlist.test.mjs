import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { YTMusic } from 'youtubei.js';

const code = await readFile(new URL('../src/datasource/youtube/playlistSnapshot.ts', import.meta.url), 'utf8');
const compiled = await transform(code, { loader: 'ts', format: 'esm' });
const { collectPlaylistSnapshot, playlistDateOrder, playlistItemVideoId } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);

function pages(rows) {
  return rows.map((items, index) => ({
    items, has_continuation: index < rows.length - 1,
    async getContinuation() { return pages(rows.slice(index + 1)); },
  }))[0];
}
test('loads past the first 100 songs and across duplicate-only pages', async () => {
  const initial = Array.from({ length: 100 }, (_, i) => ({ id: `song-${i}` }));
  let counts;
  const result = await collectPlaylistSnapshot(pages([initial, initial, [], [{ id: 'older' }]]), p => p.items, value => { counts = value; });
  assert.equal(result.length, 101);
  assert.deepEqual(counts, { pageCount: 4, rowCount: 201, uniqueCount: 101 });
  assert.deepEqual(result.slice(0, 2), initial.slice(0, 2));
  assert.equal(result.at(-1).id, 'older');
});
test('failed continuation never returns a partial success', async () => {
  const page = { items: [{ id: 'recent' }], has_continuation: true, async getContinuation() { throw new Error('offline'); } };
  await assert.rejects(collectPlaylistSnapshot(page, p => p.items), /offline/);
});
test('endless continuation is rejected instead of saving a truncated list', async () => {
  const page = { items: [], has_continuation: true, async getContinuation() { return page; } };
  await assert.rejects(collectPlaylistSnapshot(page, p => p.items), /did not finish/);
});
test('unknown dates do not bury recent songs, and oldest reverses without mutating', () => {
  const tracks = [{ id: 'new-without-date' }, { id: 'dated' }, { id: 'old-without-date' }];
  assert.deepEqual(playlistDateOrder(tracks, 'desc').map(t => t.id), ['new-without-date', 'dated', 'old-without-date']);
  assert.deepEqual(playlistDateOrder(tracks, 'asc').map(t => t.id), ['old-without-date', 'dated', 'new-without-date']);
  assert.equal(tracks[0].id, 'new-without-date');
});

test('music videos without a recognized music type retain their title play-link ID', () => {
  const response = { data: { continuationContents: { musicPlaylistShelfContinuation: { contents: [
    { musicResponsiveListItemRenderer: { flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Live concert', navigationEndpoint: { watchEndpoint: { videoId: 'SYAZLU5VHfc' } } }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Artist' }] } } },
    ] } },
  ] } } } };
  const item = new YTMusic.Playlist(response, {}).items[0];
  assert.equal(item.id, undefined);
  assert.equal(playlistItemVideoId(item), 'SYAZLU5VHfc');
  assert.equal(playlistItemVideoId({ flex_columns: [{ title: { runs: [{ endpoint: { payload: { browseId: 'UCartist' } } }] } }] }), undefined);
});

test('YouTube parser follows shelf continuation into append-action rows using the music client', async () => {
  const row = (id) => ({ musicResponsiveListItemRenderer: {
    playlistItemData: { videoId: id },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: id, navigationEndpoint: { watchEndpoint: {
        videoId: id, watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' } },
      } } }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Artist', navigationEndpoint: { browseEndpoint: { browseId: 'UCartist' } } }] } } },
    ],
  } });
  const requests = [];
  const actions = { async execute(endpoint, args) {
    requests.push({ endpoint, args });
    return { data: { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [row('older000000')] } }] } };
  } };
  const first = new YTMusic.Playlist({ data: { contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: {
    sectionListRenderer: { contents: [{ musicPlaylistShelfRenderer: { contents: [row('newest00000')], continuations: [{ nextContinuationData: { continuation: 'next' } }] } }] },
  } } }] } } } }, actions);
  const tracks = await collectPlaylistSnapshot(first, page => page.items.filter(item => item.id).map(item => ({ id: item.id })));
  assert.deepEqual(tracks.map(t => t.id), ['newest00000', 'older000000']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].args.client, 'YTMUSIC');
});
