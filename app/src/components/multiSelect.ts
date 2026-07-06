import { escapeHtml } from "../utils";

export const CHARGE_TYPES: string[] = [
  "Debenture",
  "Fixed Charge",
  "Floating Charge",
  "Fixed & Floating Charge",
  "All Assets Charge",
  "Legal Mortgage",
  "Share Charge",
  "Charge over Intellectual Property",
  "Charge over Book Debts",
  "Cross Guarantees",
  "Facility Agreement Security",
  "Property Charge",
  "Assignment of Receivables",
  "Negative Pledge",
  "Security Assignment",
  "Composite Security",
  "Equipment Finance",
  "Invoice Finance",
  "Stock Charge",
  "Plant & Machinery Charge",
];

export function buildMultiSelectHtml(
  id: string,
  options: { value: string; label: string; group?: string }[],
  selected: string[],
  placeholder: string
): string {
  const chips = selected
    .map((v) => {
      const opt = options.find((o) => o.value === v);
      const lbl = opt?.label ?? v;
      return `<span class="p-chip" data-ms-id="${escapeHtml(id)}" data-ms-val="${escapeHtml(v)}"><span>${escapeHtml(lbl.length > 28 ? lbl.slice(0, 27) + "…" : lbl)}</span><span class="p-chip-x" title="Remove">✕</span></span>`;
    })
    .join("");

  const grouped: Record<string, typeof options> = {};
  for (const opt of options) {
    const g = opt.group ?? "Other";
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(opt);
  }

  const dropdownRows = Object.entries(grouped)
    .map(([grp, opts]) => {
      const rows = opts
        .map(
          (o) =>
            `<div class="p-ms-option${selected.includes(o.value) ? " selected" : ""}" data-ms-id="${escapeHtml(id)}" data-ms-val="${escapeHtml(o.value)}">
              <input type="checkbox" ${selected.includes(o.value) ? "checked" : ""} tabindex="-1" />
              <span>${escapeHtml(o.label)}</span>
            </div>`
        )
        .join("");
      return `<div class="p-ms-group" data-ms-group="${escapeHtml(grp)}">${escapeHtml(grp)}<button class="p-ms-group-btn" data-ms-group="${escapeHtml(grp)}" type="button">Select all</button></div>${rows}`;
    })
    .join("");

  return `<div class="p-multiselect" id="ms-${escapeHtml(id)}">
    <div class="p-multiselect-trigger" id="ms-trigger-${escapeHtml(id)}">
      ${chips}
      <input class="p-multiselect-search" id="ms-search-${escapeHtml(id)}" placeholder="${selected.length === 0 ? escapeHtml(placeholder) : "Search…"}" autocomplete="off" />
    </div>
    <div class="p-multiselect-dropdown" id="ms-dropdown-${escapeHtml(id)}" style="display:none">
      ${dropdownRows || `<div class="p-ms-empty">No options</div>`}
    </div>
  </div>`;
}

export function bindMultiSelect(
  container: Element,
  id: string,
  selected: string[],
  onChange: (vals: string[]) => void,
  onClose?: () => void
): void {
  const trigger = container.querySelector<HTMLDivElement>(`#ms-trigger-${id}`);
  const search = container.querySelector<HTMLInputElement>(`#ms-search-${id}`);
  const dropdown = container.querySelector<HTMLDivElement>(`#ms-dropdown-${id}`);
  if (!trigger || !search || !dropdown) return;

  const placeholder = search.getAttribute("placeholder") || "";
  const openDropdown = () => { dropdown.style.display = "block"; };
  const closeDropdown = () => { dropdown.style.display = "none"; search.value = ""; filterOptions(""); };

  const filterOptions = (q: string) => {
    const lower = q.toLowerCase();
    dropdown.querySelectorAll<HTMLDivElement>(".p-ms-option").forEach((opt) => {
      const text = opt.textContent?.toLowerCase() ?? "";
      opt.style.display = text.includes(lower) ? "" : "none";
    });
    dropdown.querySelectorAll<HTMLDivElement>(".p-ms-group").forEach((grp) => {
      let hasVisible = false;
      let el: Element | null = grp.nextElementSibling;
      while (el && !el.classList.contains("p-ms-group")) {
        if ((el as HTMLElement).style.display !== "none") hasVisible = true;
        el = el.nextElementSibling;
      }
      (grp as HTMLElement).style.display = hasVisible ? "" : "none";
    });
  };

  trigger.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).classList.contains("p-chip-x")) return;
    openDropdown();
    search.focus();
  });

  search.addEventListener("input", () => filterOptions(search.value));
  search.addEventListener("focus", openDropdown);

  const updateGroupBtns = () => {
    dropdown.querySelectorAll<HTMLButtonElement>(".p-ms-group-btn").forEach((btn) => {
      const grpName = btn.dataset.msGroup ?? "";
      const groupVals = Array.from(dropdown.querySelectorAll<HTMLDivElement>(".p-ms-option")).filter((opt) => {
        let el: Element | null = opt.previousElementSibling;
        while (el && !el.classList.contains("p-ms-group")) el = el.previousElementSibling;
        return el?.getAttribute("data-ms-group") === grpName;
      }).map((o) => o.dataset.msVal ?? "");
      btn.textContent = groupVals.every((v) => selected.includes(v)) ? "Deselect all" : "Select all";
    });
  };

  const rebuildChips = () => {
    const allOptions = Array.from(dropdown.querySelectorAll<HTMLDivElement>(".p-ms-option"))
      .map(o => ({ value: o.dataset.msVal ?? "", label: o.querySelector("span")?.textContent ?? o.dataset.msVal ?? "" }));
    trigger.querySelectorAll(".p-chip").forEach(c => c.remove());
    const searchInput = trigger.querySelector(".p-multiselect-search")!;
    selected.forEach(v => {
      const lbl = allOptions.find(o => o.value === v)?.label ?? v;
      const chip = document.createElement("span");
      chip.className = "p-chip";
      chip.dataset.msId = id;
      chip.dataset.msVal = v;
      const short = lbl.length > 28 ? lbl.slice(0, 27) + "…" : lbl;
      chip.innerHTML = `<span>${escapeHtml(short)}</span><span class="p-chip-x" title="Remove">✕</span>`;
      chip.querySelector(".p-chip-x")!.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = selected.indexOf(v);
        if (idx !== -1) selected.splice(idx, 1);
        onChange([...selected]);
        rebuildChips();
        onClose?.();
      });
      trigger.insertBefore(chip, searchInput);
    });
    searchInput.setAttribute("placeholder", selected.length === 0 ? placeholder : "Search…");
    updateGroupBtns();
  };

  dropdown.querySelectorAll<HTMLDivElement>(".p-ms-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const val = opt.dataset.msVal ?? "";
      const idx = selected.indexOf(val);
      if (idx === -1) selected.push(val);
      else selected.splice(idx, 1);
      onChange([...selected]);
      opt.classList.toggle("selected");
      const cb = opt.querySelector<HTMLInputElement>("input[type=checkbox]");
      if (cb) cb.checked = idx === -1;
      rebuildChips();
    });
  });

  dropdown.querySelectorAll<HTMLButtonElement>(".p-ms-group-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const grpName = btn.dataset.msGroup ?? "";
      const groupOpts = Array.from(dropdown.querySelectorAll<HTMLDivElement>(".p-ms-option")).filter((opt) => {
        let el: Element | null = opt.previousElementSibling;
        while (el && !el.classList.contains("p-ms-group")) el = el.previousElementSibling;
        return el?.getAttribute("data-ms-group") === grpName;
      });
      const groupVals = groupOpts.map((o) => o.dataset.msVal ?? "");
      const allSelected = groupVals.every((v) => selected.includes(v));
      if (allSelected) {
        groupVals.forEach((v) => { const i = selected.indexOf(v); if (i !== -1) selected.splice(i, 1); });
        btn.textContent = "Select all";
      } else {
        groupVals.forEach((v) => { if (!selected.includes(v)) selected.push(v); });
        btn.textContent = "Deselect all";
      }
      onChange([...selected]);
      groupOpts.forEach((opt) => {
        const isNowSelected = selected.includes(opt.dataset.msVal ?? "");
        opt.classList.toggle("selected", isNowSelected);
        const cb = opt.querySelector<HTMLInputElement>("input[type=checkbox]");
        if (cb) cb.checked = isNowSelected;
      });
      rebuildChips();
    });
  });

  document.addEventListener("click", (e) => {
    if (!trigger.closest(`#ms-${id}`)?.contains(e.target as Node)) {
      if (dropdown.style.display !== "none") {
        closeDropdown();
        onClose?.();
      }
    }
  }, { capture: false });
}
