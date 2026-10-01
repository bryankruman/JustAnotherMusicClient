# Liked song history and date filters

Open **Liked Songs** to use **Liked during**: all time, the last 30/90/365
calendar days, a custom inclusive date range, or songs with an unknown date.
Date filtering combines with playlist search and sorting; playing or shuffling
uses the visible results. Downloads still download the whole playlist.
Historical like dates require the existing optional connection in
**Settings → About → Liked song dates**; see [setup](liked-song-dates.md).
Unknown dates are excluded from date ranges, never guessed from upload dates
or the order in the playlist. Either custom range bound can be left blank.

**Song history** retains a song's title, artist, album, video ID, first/last
observation and most recent disappearance/return. Expand it to see missing
songs, returned songs, or songs deliberately unliked inside this app. Use
**Open song** or **Find replacement** to locate a missing recording.

The first successful full refresh creates the baseline. Further library
refreshes, opening Liked Songs, and **Check now** compare complete server lists.
Cached data, failed requests, repeated continuation tokens, and interrupted
pagination never establish removals. Empty responses must be structurally
valid and are checked twice. A like/unlike during pagination invalidates that
scan's comparison. A complete scan replaces the liked-playlist cache instead
of accumulating removed songs in it.

“Missing” means absent from the playlist returned by YouTube Music, not proven
deletion. YouTube limits, unavailable videos, or unlikes on other devices can
all cause absence. Detection time is when this app noticed the absence, not
the actual removal time. No monitoring runs while the app is closed. Songs
lost before the first baseline cannot be reconstructed.

History lives in native app settings, separately from the evictable media
cache and the optional liked-date cache. Clearing the media cache or
disconnecting liked dates does not erase it. History contains no credentials.
Each channel has a separate history when YouTube provides its identity;
otherwise it is scoped to the saved sign-in and account selection. Signing
out hides the history, and a new sign-in without a channel identity starts a
new baseline. Old records are retained in app settings. Resetting app settings
or deleting the application's data also deletes history.

Run focused checks with `node --test tests/liked-songs.test.mjs`, then
`npm run build`.
