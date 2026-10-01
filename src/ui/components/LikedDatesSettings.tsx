import { connectLikedDates, disconnectLikedDates, syncLikedDates, useLikedDates } from "../../datasource/youtube/likedDates";
import styles from "../pages/SettingsPage.module.css";

export function LikedDatesSettings({ signedIn }: { signedIn: boolean }) {
  const dates = useLikedDates();
  return (
    <section className={styles.card} aria-labelledby="liked-dates-settings-title">
      <div className={styles.cardHeader}>
        <div>
          <h2 id="liked-dates-settings-title">Liked song dates</h2>
          <p>{dates.connected ? `Connected as ${dates.channelTitle}` : "Show when you added songs to your liked list."}</p>
        </div>
      </div>
      <p>Exact added dates are cached and refreshed at most once a day. Missing dates can show clearly labeled estimates from playlist order and cached video publication dates; songs without enough evidence show a dash.</p>
      {!dates.connected && <p>Choose your Google Desktop OAuth client JSON, then grant read-only YouTube access in your browser. Select the same YouTube channel you use for your music library.</p>}
      {!dates.connected && <details>
        <summary>Set up a Google connection</summary>
        <ol>
          <li>In Google Cloud Console, select a project and enable YouTube Data API v3.</li>
          <li>Configure Google Auth Platform and add your Google account as a test user if the project is in Testing.</li>
          <li>Create an OAuth client with application type Desktop app, then download its JSON file.</li>
          <li>Click Connect liked dates below and select that file. Keep the file private.</li>
        </ol>
      </details>}
      {dates.connected && <p>{dates.syncedAt
        ? `${Object.keys(dates.dates).length.toLocaleString()} dates cached. Last updated ${new Date(dates.syncedAt * 1000).toLocaleString()}.`
        : "The first sync has not finished yet."}</p>}
      <div className={styles.accountRow}>
        <button className={styles.signInButton} type="button" disabled={!signedIn || dates.busy}
          onClick={() => void (dates.connected ? syncLikedDates() : connectLikedDates())}>
          {dates.busy ? "Connecting / syncing…" : dates.connected ? "Check for due refresh" : "Connect liked dates"}
        </button>
        {dates.connected && <button className={styles.signOutButton} type="button" disabled={dates.busy}
          onClick={() => { void disconnectLikedDates().catch(() => {}); }}>Disconnect and delete dates</button>}
      </div>
      {!signedIn && <p>Sign in to YouTube Music first.</p>}
      {dates.error && <p className={styles.error} role="status">{dates.error}</p>}
      <p>Disconnecting deletes this app’s saved authorization and date cache; it does not change your likes on YouTube.</p>
    </section>
  );
}
