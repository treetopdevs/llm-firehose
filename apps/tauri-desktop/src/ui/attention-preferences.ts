// UI preferences are not captured history. Only episode IDs and timestamps
// belong here; evidence content always comes from the local engine.
export type LocalStorage = Pick<Storage, "getItem" | "setItem">;
export const PREFERENCES_KEY = "firehose.attention.v1";
export const SNOOZE_MS = 15 * 60_000;

export function createAttentionPreferences(storage?: LocalStorage) {
  const snoozes = new Map<string, number>();
  let warning = "";
  let enabled = false;
  const notified = new Set<string>();
  try {
    storage ??= window.localStorage;
    if (!storage) throw new Error("storage unavailable");
    const raw = storage.getItem(PREFERENCES_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      enabled = data.enabled === true;
      if (Array.isArray(data.notified))
        for (const key of data.notified) {
          if (typeof key === "string") notified.add(key);
        }
      if (!Array.isArray(data.snoozes)) throw new Error("invalid preferences");
      for (const entry of data.snoozes) {
        if (
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "number" &&
          Number.isFinite(entry[1])
        )
          snoozes.set(entry[0], entry[1]);
      }
    }
  } catch {
    enabled = false;
    notified.clear();
    snoozes.clear();
    warning =
      "Local preferences unavailable; snooze will last only until this window closes.";
  }
  function save() {
    try {
      if (!storage) throw new Error("storage unavailable");
      storage.setItem(
        PREFERENCES_KEY,
        JSON.stringify({
          enabled,
          notified: [...notified],
          snoozes: [...snoozes],
        }),
      );
    } catch {
      warning =
        "Local preferences could not be saved; snooze will last only until this window closes.";
    }
  }
  return {
    get warning() {
      return warning;
    },
    get enabled() {
      return enabled;
    },
    setEnabled(value: boolean) {
      enabled = value;
      save();
    },
    notified(key: string) {
      return notified.has(key);
    },
    markNotified(keys: string[]) {
      let changed = false;
      for (const key of keys) {
        if (!notified.has(key)) {
          notified.add(key);
          changed = true;
        }
      }
      if (changed) save();
    },
    retain(keys: Set<string>) {
      let changed = false;
      for (const key of snoozes.keys()) {
        if (!keys.has(key)) {
          snoozes.delete(key);
          changed = true;
        }
      }
      for (const key of notified) {
        if (!keys.has(key)) {
          notified.delete(key);
          changed = true;
        }
      }
      if (changed) save();
    },
    snoozed(key: string, now = Date.now()) {
      return (snoozes.get(key) ?? 0) > now;
    },
    snooze(key: string) {
      snoozes.set(key, Date.now() + SNOOZE_MS);
      save();
    },
    unsnooze(key: string) {
      snoozes.delete(key);
      save();
    },
  };
}
