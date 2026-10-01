import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Bundle TypeScript with the same compiler used by Vite. Replace only native
// I/O; the data source and library controller under test are the real classes.
const result = await build({
  stdin: {
    contents: `export { YouTubeMusicDataSource } from './src/datasource/youtube/YouTubeMusicDataSource';
      export { LibraryController } from './src/player/LibraryController';
      export * from './src/datasource/youtube/artwork';`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: "esm", platform: "browser",
  plugins: [{ name: "native-test-double", setup(builder) {
    builder.onResolve({ filter: /\/logging$|@tauri-apps\/api\/core$|\/tauriFetch$|\/isolatedPlayerScript$/ }, (args) => ({
      path: args.path, namespace: "test-double",
    }));
    builder.onLoad({ filter: /.*/, namespace: "test-double" }, (args) => ({ contents:
      args.path.endsWith("logging")
        ? `export const logInternalDebug = () => {}; export const logInternalWarn = () => {};
           export const logInternalInfo = () => {}; export const logInternalError = () => {};`
        : args.path.endsWith("isolatedPlayerScript")
          ? `export const evaluatePlayerScript = () => { throw new Error('Unexpected player script'); };`
        : args.path.endsWith("tauriFetch")
          ? `export const BACKEND_AUTH_MARKER = 'SAPISID=backend-managed';
             export const getBackendSessionActive = () => globalThis.testSessionActive;
             export const setBackendSessionActive = value => { globalThis.testSessionActive = value; };
             export const tauriFetch = () => { throw new Error('Unexpected network request'); };`
          : `export const invoke = (command, args) => globalThis.nativeInvoke(command, args);`,
    }));
  } }],
});
const { YouTubeMusicDataSource, LibraryController, collectArtworkCandidates, selectArtworkUrl,
  getVideoArtworkFallback } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)
    .catch((error) => { throw new Error(`Unable to load test bundle: ${error.message}`); });

const library = () => ({ account: { name: "Listener" }, albums: [], playlists: [],
  likedSongsPlaylist: { id: "LM", title: "Liked Songs", owner: "Listener" },
  likedSongs: [], recentlyPlayed: [] });
const seed = { id: "abcdefghijk", source: "youtube", title: "First song", artist: "Artist", artworkUrl: "https://example.com/cover.jpg" };

function sourceWithResponse(response) {
  globalThis.testSessionActive = true;
  const cache = new Map([["youtube-music:library:v5", JSON.stringify(library())]]);
  globalThis.nativeInvoke = async (command, args) => {
    if (command === "cache_get") return cache.get(args.key) ?? null;
    if (command === "cache_set") { cache.set(args.key, args.value); return { changed: true }; }
    throw new Error(`Unexpected native command ${command}`);
  };
  const calls = [];
  const source = new YouTubeMusicDataSource();
  source.getMusicClient = async () => ({ actions: { execute: async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    return response;
  } } });
  return { source, calls, cache };
}

test("creates a playlist and first song atomically, preserving privacy and cache", async () => {
  const { source, calls, cache } = sourceWithResponse({ success: true, data: { playlistId: "PLcreated" } });
  const created = await source.createPlaylist({ title: "  Evening mix  ", description: "  Slow songs  ", privacy: "UNLISTED", initialTrack: seed });
  assert.deepEqual(calls, [{ endpoint: "playlist/create", payload: {
    title: "Evening mix", description: "Slow songs", privacyStatus: "UNLISTED", videoIds: [seed.id],
  } }]);
  assert.equal(created.id, "PLcreated");
  assert.equal(created.artworkUrl, seed.artworkUrl);
  assert.equal(created.isEditable, true);
  assert.deepEqual(JSON.parse(cache.get("youtube-music:library:v5")).playlists, [created]);
});

test("can create an empty private playlist", async () => {
  const { source, calls } = sourceWithResponse({ success: true, data: { playlistId: "PLempty" } });
  await source.createPlaylist({ title: "New mix", privacy: "PRIVATE" });
  assert.deepEqual(calls[0].payload.videoIds, []);
  assert.equal(calls[0].payload.privacyStatus, "PRIVATE");
});

test("rejects invalid input before making an account request", async () => {
  const { source, calls } = sourceWithResponse({ success: true, data: { playlistId: "PLbad" } });
  for (const input of [
    { title: "   ", privacy: "PRIVATE" },
    { title: "x".repeat(151), privacy: "PRIVATE" },
    { title: "mix", description: "x".repeat(5001), privacy: "PRIVATE" },
    { title: "mix", privacy: "INVALID" },
    { title: "mix", privacy: "PRIVATE", initialTrack: { ...seed, source: "local" } },
  ]) await assert.rejects(source.createPlaylist(input));
  globalThis.testSessionActive = false;
  await assert.rejects(source.createPlaylist({ title: "mix", privacy: "PRIVATE" }), /Sign in/);
  assert.equal(calls.length, 0);
});

test("does not save a playlist when creation is not confirmed", async () => {
  for (const response of [{ success: false, data: {} }, { success: true, data: {} }]) {
    const { source, cache } = sourceWithResponse(response);
    await assert.rejects(source.createPlaylist({ title: "mix", privacy: "PRIVATE" }), /did not confirm/);
    assert.deepEqual(JSON.parse(cache.get("youtube-music:library:v5")).playlists, []);
  }
});

test("publishes a confirmed playlist immediately and preserves existing library entries", async () => {
  const created = { id: "PLnew", title: "mix", owner: "Listener", isEditable: true };
  const controller = new LibraryController({ createPlaylist: async () => created });
  controller.state = { ...controller.getState(), status: "ready", library: {
    ...library(), playlists: [{ id: "PLold", title: "Old mix", owner: "Listener" }],
  } };
  let updates = 0;
  controller.subscribe(() => updates++);
  assert.equal(await controller.createPlaylist({ title: "mix", privacy: "PRIVATE" }), created);
  assert.deepEqual(controller.getState().library.playlists.map((p) => p.id), ["PLnew", "PLold"]);
  assert.equal(updates, 1);
});

test("controller rejects signed-out creation and leaves the library intact on errors", async () => {
  let calls = 0;
  const controller = new LibraryController({ createPlaylist: async () => { calls++; throw new Error("Unavailable"); } });
  await assert.rejects(controller.createPlaylist({ title: "mix", privacy: "PRIVATE" }), /Sign in/);
  assert.equal(calls, 0);
  const snapshot = library();
  controller.state = { ...controller.getState(), status: "ready", library: snapshot };
  await assert.rejects(controller.createPlaylist({ title: "mix", privacy: "PRIVATE" }), /Unavailable/);
  assert.equal(controller.getState().library, snapshot);
});

test("extracts nested thumbnail shapes, handles cycles, and normalizes protocol-relative URLs", () => {
  const thumbnails = { contents: [{ url: "//example.com/small", width: 50, height: 50 },
    { url: "//example.com/large", width: 500, height: 500 }] };
  thumbnails.circular = thumbnails;
  assert.equal(selectArtworkUrl(collectArtworkCandidates(thumbnails)), "https://example.com/large");
  assert.equal(getVideoArtworkFallback(seed.id), `https://i.ytimg.com/vi/${seed.id}/hqdefault.jpg`);
  assert.equal(getVideoArtworkFallback("local:audio"), undefined);
});

test("hydrates covers for saved playlists even when they are not editable", async () => {
  const { source, cache } = sourceWithResponse({});
  const saved = { id: "PLsaved", title: "Saved mix", owner: "Other listener", privacy: "UNLISTED" };
  cache.set("youtube-music:library:v5", JSON.stringify({ ...library(), playlists: [saved] }));
  source.collectMusicItems = (_response, types) => types.has("playlist")
    ? [{ id: saved.id, title: saved.title, item_type: "playlist" }] : [];
  source.executeMusicBrowse = async () => ({ contents_memo: { getType: type => type.type === "MusicResponsiveHeader"
    ? [{ thumbnail: { contents: [{ url: "//example.com/playlist-cover", width: 400, height: 400 }] },
      description: { description: { toString: () => "A shared collection" } } }] : [] } });
  source.findEditablePlaylistId = () => null;
  const playlists = await source.getCreatedPlaylists({}, {});
  assert.equal(playlists[0].artworkUrl, "https://example.com/playlist-cover");
  assert.equal(playlists[0].description, "A shared collection");
  assert.equal(playlists[0].privacy, "UNLISTED");
  assert.equal(playlists[0].isEditable, false);
});
