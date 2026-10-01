import { IconLayoutDashboard } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./TitleBar.module.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logInternalError } from "../../internal/logging";
import { MusicTabs } from "./MusicTabs";
import type { Tab } from "../types/tab";
import {
  useNativeWindowControls,
  useWindowsStyleWindowControls,
} from "../settings/windowControls";
import { DownloadsPopover } from "./DownloadsPopover";

interface TitleBarProps {
  tabs: Tab[];
  activeTabId: string;
  playingTabId: string | null;
  sidebarWidth: number;
  isHomeActive: boolean;
  onNavigateHome: () => void;
  onCreateTab: () => void;
  onCloseTab: (tabId: string) => void;
  onSwitchTab: (tabId: string) => void;
  onReorderTab: (draggedTabId: string, targetTabId: string, insertAfter: boolean) => void;
  onboardingFirstTabId?: string;
}

export function TitleBar({
  tabs,
  activeTabId,
  playingTabId,
  sidebarWidth,
  isHomeActive,
  onNavigateHome,
  onCreateTab,
  onCloseTab,
  onSwitchTab,
  onReorderTab,
  onboardingFirstTabId,
}: TitleBarProps) {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [isMaximized, setIsMaximized] = useState(false);
  const nativeWindowControls = useNativeWindowControls();
  const windowsStyleWindowControls = useWindowsStyleWindowControls();
  const homePointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const suppressHomeClickRef = useRef(false);
  const hideHomeText = sidebarWidth <= 120;

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    const updateMaximized = async () => {
      try {
        const maximized = await appWindow.isMaximized();
        if (active) setIsMaximized(maximized);
      } catch (error) {
        logInternalError("TitleBar.isMaximized failed", error);
      }
    };
    void appWindow.onResized(() => void updateMaximized()).then((dispose) => {
      if (active) {
        unlisten = dispose;
        void updateMaximized();
      } else {
        dispose();
      }
    }).catch((error) => logInternalError("TitleBar.onResized failed", error));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [appWindow]);

  const homeButtonClasses = useMemo(() => [
    styles.homeButton,
    isHomeActive ? styles.homeButtonActive : "",
    hideHomeText ? styles.homeButtonIconOnly : "",
  ].filter(Boolean).join(" "), [isHomeActive, hideHomeText]);

  const windowControlsClasses = [
    styles.windowControls,
    windowsStyleWindowControls ? styles.windowControlsWindows : "",
  ].filter(Boolean).join(" ");

  const startWindowDrag = async () => {
    try {
      window.dispatchEvent(new Event("main-window-drag-started"));

      if (await appWindow.isMaximized()) {
        await appWindow.unmaximize();
      }

      await appWindow.startDragging();
    } catch (error) {
      logInternalError("TitleBar.startWindowDrag failed", error);
    }
  };

  const handleMinimize = async () => {
    try {
      if (await appWindow.isFullscreen()) {
        await appWindow.setFullscreen(false);
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }

      await appWindow.minimize();
    } catch (error) {
      logInternalError("TitleBar.minimize failed", error);
    }
  };

  const handleToggleMaximize = async () => {
    try {
      if (await appWindow.isMaximized()) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
    } catch (error) {
      logInternalError("TitleBar.maximize failed", error);
    }
  };

  return (
    <div className={styles.root}>
      <button
        type="button"
        className={homeButtonClasses}
        style={{ width: `${sidebarWidth}px` }}
        onClick={() => {
          if (suppressHomeClickRef.current) {
            suppressHomeClickRef.current = false;
            return;
          }
          onNavigateHome();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          suppressHomeClickRef.current = false;
          homePointerRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const pointer = homePointerRef.current;
          if (!pointer || pointer.pointerId !== event.pointerId) return;

          const distance = Math.hypot(
            event.clientX - pointer.startX,
            event.clientY - pointer.startY,
          );
          if (distance < 5) return;

          homePointerRef.current = null;
          suppressHomeClickRef.current = true;
          void startWindowDrag();
        }}
        onPointerUp={(event) => {
          if (homePointerRef.current?.pointerId === event.pointerId) {
            homePointerRef.current = null;
          }
        }}
        onPointerCancel={() => {
          homePointerRef.current = null;
        }}
        aria-label="Home"
        aria-current={isHomeActive ? "page" : undefined}
      >
        <IconLayoutDashboard size={18} aria-hidden="true" />
        {!hideHomeText && <span>Home</span>}
      </button>

      <MusicTabs
        tabs={tabs}
        activeTabId={activeTabId}
        playingTabId={playingTabId}
        onCreateTab={onCreateTab}
        onCloseTab={onCloseTab}
        onSwitchTab={onSwitchTab}
        onReorderTab={onReorderTab}
        onboardingFirstTabId={onboardingFirstTabId}
      />

      <div
        className={styles.dragArea}
        aria-label="Drag window"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          void startWindowDrag();
        }}
        onDoubleClick={() => void handleToggleMaximize()}
      />

      <DownloadsPopover />

      {!nativeWindowControls && (
        <div className={windowControlsClasses} aria-label="Window controls">
          <button
            type="button"
            aria-label="Minimize"
            className={`${styles.windowButton} ${styles.windowButtonMinimize}`}
            onClick={() => void handleMinimize()}
          >
            <span aria-hidden="true" className={styles.windowIcon}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M0 5.5H10" stroke="currentColor" />
              </svg>
            </span>
          </button>
          <button
            type="button"
            aria-label={isMaximized ? "Restore" : "Maximize"}
            className={`${styles.windowButton} ${styles.windowButtonMaximize}`}
            onClick={() => void handleToggleMaximize()}
          >
            <span aria-hidden="true" className={styles.windowIcon}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                {isMaximized ? (
                  <path d="M2.5 2.5V.5H9.5V7.5H7.5M.5 2.5H7.5V9.5H.5Z" stroke="currentColor" />
                ) : (
                  <rect x=".5" y=".5" width="9" height="9" stroke="currentColor" />
                )}
              </svg>
            </span>
          </button>
          <button
            type="button"
            aria-label="Close"
            className={`${styles.windowButton} ${styles.windowButtonClose}`}
            onClick={() => {
              void appWindow.close().catch((error) => {
                logInternalError("TitleBar.close failed", error);
              });
            }}
          >
            <span aria-hidden="true" className={styles.windowIcon}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M.5.5L9.5 9.5M9.5.5L.5 9.5" stroke="currentColor" />
              </svg>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
