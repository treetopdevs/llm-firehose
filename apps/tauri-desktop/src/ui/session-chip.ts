import { el } from "../dom";

/**
 * The full native session id, demoted to a copyable detail next to the
 * session's name. Same chip the Sessions panel draws; a click copies the id.
 */
export function sessionIdChip(id: string): HTMLElement {
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
