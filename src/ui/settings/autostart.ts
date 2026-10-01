import { invoke } from "@tauri-apps/api/core";
import { isEnabled } from "@tauri-apps/plugin-autostart";

export function getAutostartEnabled() {
  return isEnabled();
}

export async function setAutostartEnabled(enabled: boolean) {
  await invoke("autostart_set_confirmed", { enabled });
}
