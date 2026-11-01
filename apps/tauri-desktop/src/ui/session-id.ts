import { el } from "../dom";

/** The full native id, demoted to a copyable detail. */
export function idChip(id: string): HTMLElement {
  const chip = el("button", { class: "session-id dim", title: `copy session id ${id}`, "aria-label": `copy session id ${id}` }, id);
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(id).then(
      () => chip.classList.add("copied"),
      () => {},
    );
  });
  return chip;
}
