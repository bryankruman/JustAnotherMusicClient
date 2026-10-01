import { useEffect } from "react";
import { IconX } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UpdateInfo } from "../../internal/updateChecker";
import { snoozeUpdate } from "../../internal/updateChecker";
import styles from "./UpdateToast.module.css";

const AUTO_DISMISS_MS = 60_000;

interface UpdateToastProps {
  update: UpdateInfo;
  onDismiss: () => void;
}

export function UpdateToast({ update, onDismiss }: UpdateToastProps) {
  const releaseButtonClassName = `${styles.changesButton} ${styles.primaryButton}`;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      snoozeUpdate(update.version);
      onDismiss();
    }, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [onDismiss, update.version]);

  const dismiss = () => {
    snoozeUpdate(update.version);
    onDismiss();
  };

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <div className={styles.message}>
        <strong>Version {update.version} is available</strong>
        <span>Automatic installation is disabled; review the release before downloading.</span>
      </div>
      <div className={styles.actions}>
        <a
          className={releaseButtonClassName}
          href={update.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open version ${update.version} release on GitHub`}
          onClick={(e) => {
            e.preventDefault();
            void openUrl(update.releaseUrl);
          }}
        >
          View release
        </a>
        <button
          className={styles.closeButton}
          type="button"
          onClick={dismiss}
          aria-label="Close update notification"
          title="Close"
        >
          <IconX size={16} />
        </button>
      </div>
    </div>
  );
}
