// Daemon/UI compatibility rule (docs/compatibility.md): the client probes
// GET /health and refuses to render events unless the schema versions match
// exactly. schema_version 0/absent means a pre-versioning daemon, treated
// as version 1 per the platform contract.

import type { Health } from "./api";

export interface Compat {
  compatible: boolean;
  reason?: string;
}

export function checkCompat(h: Health, clientSchemaVersion: number): Compat {
  const daemon = h.schema_version > 0 ? h.schema_version : 1;
  if (daemon === clientSchemaVersion) {
    return { compatible: true };
  }
  return {
    compatible: false,
    reason:
      `daemon ${h.version} speaks event schema v${daemon}, ` +
      `this app speaks v${clientSchemaVersion} — update the older side`,
  };
}
