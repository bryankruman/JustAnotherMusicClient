# Liked song dates

The optional connection in **Settings → About → Liked song dates** reads
`playlistItems.snippet.publishedAt` from the official YouTube Data API. This is
when the video was added to the liked playlist, not the video's upload date.
Dates are matched to YouTube Music songs by video ID. Unmatched songs show an
estimate when enough evidence is available, otherwise a dash. The API's liked-video playlist also includes non-music videos, and it may
not expose every older like in a large library.

## One-time Google setup

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **YouTube Data API v3** for that project.
3. Configure the Google Auth Platform consent screen. For a personal project in
   Testing, add your Google account as a test user. Request only the
   `https://www.googleapis.com/auth/youtube.readonly` scope.
4. Under **Google Auth Platform → Clients**, create an OAuth client with
   application type **Desktop app**. Download its JSON configuration.
5. Sign in to YouTube Music in the app, then choose **Connect liked dates** and
   select that JSON file. The system browser opens Google's consent screen.
   Choose the same YouTube channel used by the music app and grant read-only
   access. Return to the app; the first date sync starts automatically.

Do not paste the JSON, authorization codes, or tokens into chat or commit them.
The native backend reads the selected file directly. The app does not use API
Explorer credentials. Google projects in Testing can require reconnecting when
their authorization expires.

## Cache behavior

The music list and the date list are separate sources. Liked Songs loads every
YouTube Music playlist page and replaces the saved ordered snapshot only after
the complete scan succeeds. “Date Added” keeps YouTube Music's newest-first
order (or its reverse), including songs without an exact timestamp. Unknown
dates no longer push recent songs to the bottom. The page displays date coverage.
For music videos whose type is not recognized by the upstream parser, the app
recovers the video ID from the title's play link instead of dropping the row.

For song IDs missing from the main date snapshot, the app also tries the official
`playlistItems.list` `videoId` filter, in batches of up to 200 missing IDs. Each ID
costs one request. Exact matches and no-result answers are cached; successful
no-result checks are not repeated until the next daily scan, and failed lookups
wait 30 minutes. These lookups may recover dates omitted by the broad playlist
response. They cannot manufacture dates Google does not return, and do not
match different uploads by song title. The music list remains complete regardless
of date coverage. The UI reports any lookup failure while keeping saved dates.

The lookup status reports completed requests within each batch, separately from
the number of dates found. Native cache writes are grouped every 20 requests
(and at completion or failure), with progress updates every five requests.
Large remote playlists render only the visible rows and a small scrolling buffer;
search, date filters, shuffle, and playback queues still use the complete list.
Date labels reuse shared formatters instead of creating one for every row.

When Liked Songs is sorted by **Date Added**, a sticky timeline on the right
highlights the current year and month. Only the active year expands; clicking a
year or month jumps to its first matching song in the filtered list. Reversing
the date order reverses timeline navigation too. Estimates spanning multiple
months appear under their year without a month entry; year ranges remain ranges,
and undated songs have an Unknown entry. Jumps use row
positions so songs do not need to be rendered before navigating to them.

## Estimated added dates

Songs without an exact added date can show **Estimated** with a day, month,
year, or year range (for example `Jun 2022`, `2022`, or `2022–2023`). If the
estimate spans multiple months within one year, only that year is displayed.
Hovering explains the underlying date bounds.
Estimates never replace the official added-date cache or reorder the playlist.

The complete newest-first playlist supplies the nearest known added dates above
and below each gap. The song's publication date and compatible publication dates
of older songs in that gap can tighten the earliest plausible date. Publication
does not supply an upper bound. If only an upper bound is available, or known
dates contradict playlist order, the affected songs stay unknown. Contradictory
publication dates are not used to force an estimate.

Publication is a heuristic, not proof of upload/like timing: a private video can
be published later, and re-likes or replacement uploads can change ordering.
The app does not choose a midpoint or invent an exact timestamp. Date filters
include estimated ranges that overlap the selected period; “Unknown date” means
neither an exact date nor a usable estimate is available.

The existing read-only connection retrieves `videos.list` publication dates in
batches of 50. Successfully retrieved publication dates are cached permanently
and never fetched again, including dates already saved by older app versions.
Empty results retry after one day, and errors back off 30 minutes. Publication
metadata is deleted with the date connection. Estimates are computed locally from the
current playlist and cached evidence, so new likes and restored exact
dates update the ranges without a separate estimate cache.

- The native backend fetches pages of 50 IDs and timestamps. It commits a new
  snapshot only after the complete pagination succeeds. At 4,999 returned likes,
  a complete scan is approximately 100 list requests.
- Opening the liked list immediately shows the in-memory/disk cache. A background
  refresh runs only when the last successful snapshot is at least 24 hours old.
  An open liked list checks whether a refresh is due once an hour.
- Failed requests retain the previous snapshot and wait at least 30 minutes
  before retrying. The retry timestamp survives restarts.
- Cached data is isolated by the authorized YouTube channel ID. Signing out or
  replacing the music session disconnects the date connection and deletes its
  cache. Select the same channel when authorizing both connections.
- Dates changed by like/unlike actions in this app are invalidated, so re-likes
  do not show an old date. The next scheduled scan retrieves the server date.
- Exact liked-date snapshots older than 29 days are removed on the next cache read or app start and
  never displayed after expiry, including when a refresh fails offline.
- **Disconnect and delete dates** removes local credentials and dates; it does
  not modify your YouTube likes. Google account access can also be revoked in
  [Google Account permissions](https://myaccount.google.com/permissions).

Client configuration and the refresh token are saved in the operating system's
credential store. Access tokens live only in the native request code. Tokens,
client secrets, and raw authorization responses never reach the frontend or
logs. The sign-in uses an external browser, a loopback callback, state validation,
and PKCE. No API key is needed for these authorized API calls.

References: [Playlist item fields](https://developers.google.com/youtube/v3/docs/playlistItems),
[Desktop OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app),
[API data refresh policy](https://developers.google.com/youtube/terms/developer-policies).
