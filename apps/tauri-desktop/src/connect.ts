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

const reconciliationPendingCapacity = 10000;

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
        const limit = reconnecting ? 10000 : 500;
        const history = await deps.recent(limit);
        const pending: FirehoseEvent[] = [];
        let reconciling = true;
        let streamFailed = false;
        const stop = deps.stream((ev) => {
          if (reconciling) {
            if (pending.length === reconciliationPendingCapacity) pending.shift();
            pending.push(ev);
          } else deps.onEvent(ev);
        }, (open) => {
          if (open) {
            deps.setStatus({
              kind: "ok",
              text: `daemon ${h.version} · schema v${schema} · LIVE`,
            });
            deps.onStreamOpen?.();
          } else {
            streamFailed = true;
            const active = stopStream;
            stopStream = null;
            reconnecting = true;
            active?.();
            deps.setStatus({
              kind: "warn",
              text: "stream interrupted — reconnecting…",
            });
          }
        });
        if (streamFailed) stop();
        else stopStream = stop;

        const catchup = await deps.recent(limit);
        const reconciledIds = new Set<string>();
        for (const ev of [...history, ...catchup, ...pending]) {
          if (ev.id && reconciledIds.has(ev.id)) continue;
          if (ev.id) reconciledIds.add(ev.id);
          deps.onEvent(ev);
        }
        reconciling = false;
        if (!streamFailed) reconnecting = false;
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
