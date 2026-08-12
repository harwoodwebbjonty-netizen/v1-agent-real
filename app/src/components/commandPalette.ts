import { hasPermission } from "../auth";
import { type Lead } from "../api";
import { getLeads } from "../state";
import { openTab, type ViewName } from "../tabs";
import { escapeHtml } from "../utils";
import { openOverlay } from "./modal";
import { NAV_PERMISSIONS, NAV_TITLES } from "./tabBar";
import { openSidePanel } from "./sidePanel";

interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

const MAX_LEAD_RESULTS = 6;

function navItems(): PaletteItem[] {
  return (Object.keys(NAV_TITLES) as ViewName[])
    .filter((view) => {
      const perm = NAV_PERMISSIONS[view];
      return !perm || hasPermission(perm);
    })
    // Outreach's sub-tabs (email-writer/sequences) aren't real top-level
    // destinations reachable via the router — skip them here too.
    .filter((view) => view !== "email-writer" && view !== "sequences")
    .map((view) => ({
      id: `nav:${view}`,
      label: NAV_TITLES[view],
      hint: "Go to",
      run: () => openTab(view, NAV_TITLES[view]),
    }));
}

function leadItems(query: string): PaletteItem[] {
  if (!query.trim()) return [];
  const q = query.trim().toLowerCase();
  return getLeads()
    .filter((l) => l.company.toLowerCase().includes(q))
    .slice(0, MAX_LEAD_RESULTS)
    .map((lead: Lead) => ({
      id: `lead:${lead.id}`,
      label: lead.company,
      hint: "Open lead",
      run: () => {
        openTab("dashboard", "Leads");
        openSidePanel(lead);
      },
    }));
}

function buildItems(query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const nav = navItems().filter((item) => !q || item.label.toLowerCase().includes(q));
  const leads = leadItems(query);
  // Leads first when there's a real query (most common intent: "find this
  // company") — nav entries first when the palette just opened with nothing
  // typed yet, so Cmd+K alone still gives a useful destination list.
  return q ? [...leads, ...nav] : nav;
}

let closeActive: (() => void) | null = null;

function openPalette(): void {
  if (closeActive) return; // already open

  let items: PaletteItem[] = buildItems("");
  let selectedIndex = 0;

  const { overlay, close: closeOverlay } = openOverlay(
    `<div class="command-palette">
      <input id="cmdk-input" class="command-palette-input" type="text"
        placeholder="Search leads, or jump to a section…" autocomplete="off" />
      <ul id="cmdk-list" class="command-palette-list"></ul>
    </div>`,
    { overlayClassName: "command-palette-overlay", onEscape: () => close() }
  );

  // Every code path that closes the palette (Escape, backdrop click, item
  // activation) must go through this so closeActive resets — otherwise a
  // second Cmd+K press after closing thinks it's still open and no-ops.
  function close(): void {
    closeOverlay();
    closeActive = null;
  }
  closeActive = close;

  const input = overlay.querySelector<HTMLInputElement>("#cmdk-input")!;
  const list = overlay.querySelector<HTMLUListElement>("#cmdk-list")!;

  function renderList(): void {
    list.innerHTML = items.length
      ? items
          .map(
            (item, i) => `
        <li class="command-palette-row ${i === selectedIndex ? "active" : ""}" data-index="${i}">
          <span class="command-palette-row-label">${escapeHtml(item.label)}</span>
          <span class="command-palette-row-hint">${escapeHtml(item.hint)}</span>
        </li>`
          )
          .join("")
      : `<li class="command-palette-empty">No matches</li>`;
    list.querySelectorAll<HTMLLIElement>(".command-palette-row").forEach((row) => {
      row.addEventListener("mouseenter", () => {
        selectedIndex = Number(row.dataset.index);
        renderList();
      });
      row.addEventListener("click", () => activate(Number(row.dataset.index)));
    });
  }

  function activate(index: number): void {
    const item = items[index];
    if (!item) return;
    close();
    item.run();
  }

  input.addEventListener("input", () => {
    items = buildItems(input.value);
    selectedIndex = 0;
    renderList();
  });

  overlay.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      renderList();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(selectedIndex);
    }
  });

  // Click on the backdrop (not the palette itself) closes it.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  renderList();
  setTimeout(() => input.focus(), 20);
}

export function initCommandPalette(): void {
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (closeActive) {
        closeActive();
      } else {
        openPalette();
      }
    }
  });
}
