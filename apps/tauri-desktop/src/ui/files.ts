import { files } from "../api";
import { clear, el } from "../dom";

// Touched-file artifacts from /artifacts/files.
export function createFiles(): { root: HTMLElement; refresh(): void } {
  const root = el("section", { class: "files" });

  async function refresh() {
    clear(root);
    root.append(el("p", { class: "dim" }, "loading files…"));
    try {
      const all = await files();
      clear(root);
      if (all.length === 0) {
        root.append(el("p", { class: "dim" }, "no file activity captured yet"));
        return;
      }
      const table = el("table", { class: "files-table" });
      table.append(
        el("tr", {}, el("th", {}, "path"), el("th", {}, "events"), el("th", {}, "sources"), el("th", {}, "last touched")),
      );
      for (const f of all) {
        table.append(
          el(
            "tr",
            {},
            el("td", { class: "mono" }, f.path),
            el("td", {}, String(f.events)),
            el("td", {}, f.sources.join(", ")),
            el("td", {}, new Date(f.last_time).toLocaleString()),
          ),
        );
      }
      root.append(table);
    } catch (err) {
      clear(root);
      root.append(el("p", { class: "error" }, String(err)));
    }
  }

  return { root, refresh };
}
