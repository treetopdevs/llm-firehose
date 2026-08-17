// Daemon connect flow: health/compat check, history load, single shared SSE.
// Extracted from main.ts so concurrent connect() calls can be serialized and
// regression-tested without mounting the full app shell.

import type { FirehoseEvent, Health } from "./api";
import type { Compat } from "./compat";

export type ConnectDeps = {
  health(): Promise<Health>;
  recent(limit: number): Promise<FirehoseEvent[]>;
  stream(
    onEvent: (ev: FirehoseEvent) => void,
    onOpenChange: (open: boolean) => void,
  ): () => void;
  checkCompat(h: Health, clientSchemaVersion: number): Compat;
  clientSchemaVersion: number;
  onEvent(ev: FirehoseEvent): void;
  setStatus(opts: {
    kind: "ok" | "warn" | "err";
    text: string;
    compatReason?: string;
  }): void;
  onStreamOpen?(): void;
};

export type Connector = {
  connect(): Promise<void>;
  stop(): void;
};

/** Normalize daemon schema_version: 0/absent → 1 (docs/compatibility.md). */
export function normalizeSchemaVersion(raw: number | undefined): number {
  return raw && raw > 0 ? raw : 1;
}

export function createConnector(deps: ConnectDeps): Connector {
  let stopStream: (() => void) | null = null;
  let inFlight: Promise<void> | null = null;
  let reconnecting = false;

  async function attempt(): Promise<void> {
    try {
      const h = await deps.health();
      const compat = deps.checkCompat(h, deps.clientSchemaVersion);
      if (!compat.compatible) {
        deps.setStatus({
          kind: "err",
          text: `daemon ${h.version} — blocked`,
          compatReason: `incompatible: ${compat.reason}`,
        });
        return;
      }
      const schema = normalizeSchemaVersion(h.schema_version);
      deps.setStatus({
        kind: "ok",
        text: `daemon ${h.version} · schema v${schema} · LIVE`,
      });

      if (!stopStream) {
        const history = await deps.recent(reconnecting ? 10000 : 500);
        for (const ev of history) {
          deps.onEvent(ev);
        }
        stopStream = deps.stream(deps.onEvent, (open) => {
          if (open) {
            deps.setStatus({
              kind: "ok",
              text: `daemon ${h.version} · schema v${schema} · LIVE`,
            });
            deps.onStreamOpen?.();
          } else {
			const stop = stopStream;
			stopStream = null;
			reconnecting = true;
			stop?.();
            deps.setStatus({
              kind: "warn",
              text: "stream interrupted — reconnecting…",
            });
          }
        });
      }
    } catch {
      stopStream?.();
      stopStream = null;
      deps.setStatus({
        kind: "err",
        text: "engine offline — waiting for firehosed…",
      });
    }
  }

  return {
    async connect() {
      if (inFlight) {
        await inFlight;
        return;
      }
      inFlight = attempt().finally(() => {
        inFlight = null;
      });
      await inFlight;
    },
    stop() {
      stopStream?.();
      stopStream = null;
    },
  };
}
