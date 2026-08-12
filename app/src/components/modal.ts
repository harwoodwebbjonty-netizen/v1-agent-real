import { escapeHtml } from "../utils";

/** Shared boilerplate every hand-rolled overlay in this codebase used to
 * duplicate: create the backdrop div, append it, restore focus and remove it
 * on close, and close on Escape. Callers own their own body markup and
 * button wiring — this only owns the create/mount/close lifecycle, so it
 * fits both a simple confirm dialog and a more complex custom surface
 * (a form, a live-editable cost breakdown, etc.) without forcing either
 * shape. `overlayClassName` defaults to "conflict-modal-overlay" (the
 * existing, already-styled backdrop class) so this is a drop-in replacement
 * for the create-div-and-append pattern, not a new visual language. */
export function openOverlay(
  bodyHtml: string,
  options: { overlayClassName?: string; onEscape?: () => void } = {}
): { overlay: HTMLDivElement; close: () => void } {
  const overlay = document.createElement("div");
  overlay.className = options.overlayClassName ?? "conflict-modal-overlay";
  overlay.innerHTML = bodyHtml;
  document.body.appendChild(overlay);

  const previouslyFocused = document.activeElement as HTMLElement | null;
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") options.onEscape?.();
  };
  document.addEventListener("keydown", onKeydown);

  const close = () => {
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
    previouslyFocused?.focus();
  };

  return { overlay, close };
}

export interface ConfirmDialogAction {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "ghost";
}

/** The simple "title + description + N buttons" shape — resolves with the
 * clicked action's id, or "cancel" on Escape if no action is literally named
 * "cancel" (falls back to the first action otherwise never resolving isn't
 * an option, so Escape always resolves something). Matches the existing
 * .conflict-modal markup/CSS exactly (style.css:3404-3456) — this is a
 * behind-the-scenes consolidation of duplicated boilerplate, not a new look. */
export function confirmDialog(opts: {
  title: string;
  descriptionHtml?: string;
  listItemsHtml?: string;
  questionHtml?: string;
  hintHtml?: string;
  actions: ConfirmDialogAction[];
}): Promise<string> {
  return new Promise((resolve) => {
    const buttonsHtml = opts.actions
      .map((a) => {
        const variantClass = `btn-${a.variant ?? "secondary"}`;
        return `<button class="btn ${variantClass} btn-sm" data-action-id="${escapeHtml(a.id)}">${escapeHtml(a.label)}</button>`;
      })
      .join("");

    const { overlay, close } = openOverlay(
      `<div class="conflict-modal">
        <h3 class="conflict-modal-title">${escapeHtml(opts.title)}</h3>
        ${opts.descriptionHtml ? `<p class="conflict-modal-desc">${opts.descriptionHtml}</p>` : ""}
        ${opts.listItemsHtml ? `<ul class="conflict-modal-list">${opts.listItemsHtml}</ul>` : ""}
        ${opts.questionHtml ? `<p class="conflict-modal-question">${opts.questionHtml}</p>` : ""}
        <div class="conflict-modal-actions">${buttonsHtml}</div>
        ${opts.hintHtml ? `<p class="conflict-modal-hint">${opts.hintHtml}</p>` : ""}
      </div>`,
      {
        onEscape: () => {
          const cancelAction = opts.actions.find((a) => a.id === "cancel") ?? opts.actions[opts.actions.length - 1];
          settle(cancelAction.id);
        },
      }
    );

    const settle = (actionId: string) => {
      close();
      resolve(actionId);
    };

    overlay.querySelectorAll<HTMLButtonElement>("[data-action-id]").forEach((btn) => {
      btn.addEventListener("click", () => settle(btn.dataset.actionId!));
    });
  });
}
