import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

/** The OS boundary; permission is requested only from an explicit user gesture. */
export interface NotificationDelivery {
  enable(): Promise<boolean>;
  granted(): Promise<boolean>;
  send(): Promise<void>;
}

export const desktopNotifications: NotificationDelivery = {
  async enable() {
    if (!isTauri())
      throw new Error("Desktop notifications require the desktop app.");
    return (
      (await isPermissionGranted()) || (await requestPermission()) === "granted"
    );
  },
  async granted() {
    return isTauri() && (await isPermissionGranted());
  },
  async send() {
    // Await the plugin command so a failed native delivery is visible. The
    // convenience sendNotification API returns void and drops its completion.
    await invoke("plugin:notification|notify", {
      options: {
        title: "Agent Firehose",
        body: "An agent session needs attention. Open the Attention inbox.",
      },
    });
  },
};
