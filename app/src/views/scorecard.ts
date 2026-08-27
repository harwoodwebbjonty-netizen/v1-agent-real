import {
  getScorecardSettings,
  getScorecardWeeks,
  saveScorecardWeek,
  updateScorecardSettings,
  upsertScorecardWeek,
  type ScorecardEntryInput,
  type ScorecardMetricKey,
  type ScorecardSettings,
  type ScorecardWeek,
} from "../api";
import { getCurrentUser, hasPermission, subscribeAuth } from "../auth";
import { showToast } from "../toast";
import { escapeHtml } from "../utils";

// Merged in from the standalone wcf-scorecard.web.app Firebase app (see
// PROJECT_CONTEXT.md). Metric names/units/weights stay hardcoded here,
// matching the source app — only the numeric target and RAG thresholds were
// ever actually editable in its own Settings tab, and that's all the
// backend's scorecard_metric_targets/scorecard_settings store.
const METRICS: { key: ScorecardMetricKey; name: string; unit: string; isPercent?: boolean }[] = [
  { key: "calls", name: "Calls", unit: "" },
  { key: "talk_time", name: "Talk Time", unit: "h" },
  { key: "leads", name: "Qualified Leads Passed", unit: "" },
  { key: "campaigns", name: "Mass Email Campaigns", unit: "" },
  { key: "follow_up", name: "Follow-up Emails", unit: "%", isPercent: true },
  { key: "crm", name: "CRM Compliance", unit: "%", isPercent: true },
];

type Draft = Record<ScorecardMetricKey, { actual: number | null; notes: string; action: string }>;

function emptyDraft(): Draft {
  const draft = {} as Draft;
  for (const m of METRICS) draft[m.key] = { actual: null, notes: "", action: "" };
  return draft;
}

function mondayOf(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatWeekLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function ragClass(pct: number | null, green: number, amber: number): "green" | "amber" | "red" | "none" {
  if (pct === null) return "none";
  if (pct >= green) return "green";
  if (pct >= amber) return "amber";
  return "red";
}

function ragLabel(rag: ReturnType<typeof ragClass>): string {
  switch (rag) {
    case "green":
      return "On track";
    case "amber":
      return "Watch";
    case "red":
      return "Behind";
    default:
      return "—";
  }
}

export function initScorecard(): void {
  const container = document.querySelector<HTMLDivElement>("#view-scorecard")!;
  container.innerHTML = `
    <main class="container">
      <header class="page-head">
        <div>
          <h1 class="page-title">Scorecard</h1>
          <div class="page-meta"><span>Weekly performance tracking</span></div>
        </div>
      </header>

      <div class="sub-view-tabs">
        <button class="sub-view-tab active" data-sub="entry">My Scorecard</button>
        <button class="sub-view-tab hidden" data-sub="settings" id="sc-tab-settings">Settings</button>
      </div>

      <div id="sc-view-entry">
        <div class="sec-head">
          <span class="sec-num">01</span>
          <h3 class="action-section-title">Week of <span id="sc-week-label"></span></h3>
          <span class="sec-rule"></span>
          <span class="sc-week-nav">
            <button type="button" class="btn-ghost" id="sc-week-prev" title="Previous week">‹</button>
            <button type="button" class="btn-ghost" id="sc-week-today">This week</button>
            <button type="button" class="btn-ghost" id="sc-week-next" title="Next week">›</button>
          </span>
        </div>
        <section class="panel">
          <div class="scorecard-table-wrap">
            <table class="scorecard-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Target</th>
                  <th>Actual</th>
                  <th>%</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="sc-entry-rows"></tbody>
            </table>
          </div>
        </section>
        <div class="sc-actions">
          <span class="mono sc-saved-label" id="sc-saved-label"></span>
          <button type="button" class="btn-primary" id="sc-save-btn">Save this week</button>
        </div>
      </div>

      <div id="sc-view-settings" class="hidden">
        <div class="sec-head">
          <span class="sec-num">01</span>
          <h3 class="action-section-title">Targets</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel">
          <div class="scorecard-table-wrap">
            <table class="scorecard-table">
              <thead>
                <tr><th>Metric</th><th>Weekly target</th></tr>
              </thead>
              <tbody id="sc-target-rows"></tbody>
            </table>
          </div>
        </section>

        <div class="sec-head">
          <span class="sec-num">02</span>
          <h3 class="action-section-title">RAG thresholds &amp; visibility</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel sc-settings-form">
          <label>Green threshold (% of target)
            <input type="number" id="sc-green-input" min="0" max="200" />
          </label>
          <label>Amber threshold (% of target)
            <input type="number" id="sc-amber-input" min="0" max="200" />
          </label>
          <label>Notes &amp; action visibility
            <select id="sc-visibility-input">
              <option value="manager_only">Managers only</option>
              <option value="team">Whole team</option>
            </select>
          </label>
        </section>
        <div class="sc-actions">
          <button type="button" class="btn-primary" id="sc-settings-save-btn">Save settings</button>
        </div>
      </div>
    </main>
  `;

  const weekLabelEl = container.querySelector<HTMLSpanElement>("#sc-week-label")!;
  const rowsEl = container.querySelector<HTMLTableSectionElement>("#sc-entry-rows")!;
  const savedLabelEl = container.querySelector<HTMLSpanElement>("#sc-saved-label")!;
  const saveBtn = container.querySelector<HTMLButtonElement>("#sc-save-btn")!;
  const settingsTab = container.querySelector<HTMLButtonElement>("#sc-tab-settings")!;
  const entryView = container.querySelector<HTMLDivElement>("#sc-view-entry")!;
  const settingsView = container.querySelector<HTMLDivElement>("#sc-view-settings")!;
  const targetRowsEl = container.querySelector<HTMLTableSectionElement>("#sc-target-rows")!;
  const greenInput = container.querySelector<HTMLInputElement>("#sc-green-input")!;
  const amberInput = container.querySelector<HTMLInputElement>("#sc-amber-input")!;
  const visibilityInput = container.querySelector<HTMLSelectElement>("#sc-visibility-input")!;
  const settingsSaveBtn = container.querySelector<HTMLButtonElement>("#sc-settings-save-btn")!;

  let currentWeek = toIsoDate(mondayOf(new Date()));
  let draft: Draft = emptyDraft();
  let savedAt: string | null = null;
  let settings: ScorecardSettings | null = null;
  let loadToken = 0;

  function renderRows(): void {
    const green = settings?.green_threshold ?? 100;
    const amber = settings?.amber_threshold ?? 85;
    rowsEl.innerHTML = METRICS.map((m) => {
      const target = settings?.targets.find((t) => t.metric_key === m.key)?.target_value ?? 0;
      const entry = draft[m.key];
      const pct = entry.actual === null ? null : m.isPercent ? entry.actual : target > 0 ? (entry.actual / target) * 100 : null;
      const rag = ragClass(pct, green, amber);
      return `
        <tr data-metric="${m.key}">
          <td>${escapeHtml(m.name)}</td>
          <td class="mono">${target}${m.unit}</td>
          <td><input type="number" class="sc-actual-input" data-metric="${m.key}" value="${entry.actual ?? ""}" /></td>
          <td class="mono">${pct === null ? "—" : `${Math.round(pct)}%`}</td>
          <td><span class="status-badge rag-${rag}">${ragLabel(rag)}</span></td>
          <td><input type="text" class="sc-notes-input" data-metric="${m.key}" value="${escapeHtml(entry.notes)}" /></td>
          <td><input type="text" class="sc-action-input" data-metric="${m.key}" value="${escapeHtml(entry.action)}" /></td>
        </tr>`;
    }).join("");

    rowsEl.querySelectorAll<HTMLInputElement>(".sc-actual-input").forEach((el) => {
      el.addEventListener("input", () => {
        const key = el.dataset.metric as ScorecardMetricKey;
        draft[key].actual = el.value === "" ? null : Number(el.value);
      });
      el.addEventListener("change", renderRows);
    });
    rowsEl.querySelectorAll<HTMLInputElement>(".sc-notes-input").forEach((el) => {
      el.addEventListener("input", () => {
        draft[el.dataset.metric as ScorecardMetricKey].notes = el.value;
      });
    });
    rowsEl.querySelectorAll<HTMLInputElement>(".sc-action-input").forEach((el) => {
      el.addEventListener("input", () => {
        draft[el.dataset.metric as ScorecardMetricKey].action = el.value;
      });
    });
  }

  function applyWeekToDraft(week: ScorecardWeek | undefined): void {
    draft = emptyDraft();
    savedAt = week?.saved_at ?? null;
    if (week) {
      for (const m of METRICS) {
        const e = week.entries[m.key];
        if (e) draft[m.key] = { actual: e.actual, notes: e.notes, action: e.action };
      }
    }
    savedLabelEl.textContent = savedAt ? `Saved ${new Date(savedAt).toLocaleString("en-GB")}` : "Not saved yet";
  }

  async function loadWeek(): Promise<void> {
    const user = getCurrentUser();
    if (!user) return;
    weekLabelEl.textContent = formatWeekLabel(currentWeek);
    const token = ++loadToken;
    try {
      const weeks = await getScorecardWeeks(user.id, currentWeek, currentWeek);
      if (token !== loadToken) return;
      applyWeekToDraft(weeks.find((w) => w.week_commencing === currentWeek));
      renderRows();
    } catch (err) {
      if (token !== loadToken) return;
      showToast(err instanceof Error ? err.message : "Failed to load scorecard week");
    }
  }

  async function loadSettings(): Promise<void> {
    try {
      settings = await getScorecardSettings();
      renderRows();
      renderTargetRows();
      greenInput.value = String(settings.green_threshold);
      amberInput.value = String(settings.amber_threshold);
      visibilityInput.value = settings.notes_visibility;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load scorecard settings");
    }
  }

  function renderTargetRows(): void {
    targetRowsEl.innerHTML = METRICS.map((m) => {
      const target = settings?.targets.find((t) => t.metric_key === m.key)?.target_value ?? 0;
      return `
        <tr>
          <td>${escapeHtml(m.name)}</td>
          <td><input type="number" class="sc-target-input" data-metric="${m.key}" value="${target}" /></td>
        </tr>`;
    }).join("");
  }

  saveBtn.addEventListener("click", async () => {
    const user = getCurrentUser();
    if (!user) return;
    saveBtn.disabled = true;
    try {
      const entries: Record<string, ScorecardEntryInput> = {};
      for (const m of METRICS) entries[m.key] = draft[m.key];
      await upsertScorecardWeek(user.id, currentWeek, "", entries);
      const saved = await saveScorecardWeek(user.id, currentWeek);
      applyWeekToDraft(saved);
      renderRows();
      showToast("Scorecard saved");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save scorecard");
    } finally {
      saveBtn.disabled = false;
    }
  });

  settingsSaveBtn.addEventListener("click", async () => {
    settingsSaveBtn.disabled = true;
    try {
      const targets: Record<string, number> = {};
      targetRowsEl.querySelectorAll<HTMLInputElement>(".sc-target-input").forEach((el) => {
        targets[el.dataset.metric!] = Number(el.value);
      });
      settings = await updateScorecardSettings({
        greenThreshold: Number(greenInput.value),
        amberThreshold: Number(amberInput.value),
        notesVisibility: visibilityInput.value as ScorecardSettings["notes_visibility"],
        targets,
      });
      renderRows();
      renderTargetRows();
      showToast("Scorecard settings saved");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save scorecard settings");
    } finally {
      settingsSaveBtn.disabled = false;
    }
  });

  container.querySelector<HTMLButtonElement>("#sc-week-prev")!.addEventListener("click", () => {
    const d = new Date(`${currentWeek}T00:00:00`);
    d.setDate(d.getDate() - 7);
    currentWeek = toIsoDate(d);
    void loadWeek();
  });
  container.querySelector<HTMLButtonElement>("#sc-week-next")!.addEventListener("click", () => {
    const d = new Date(`${currentWeek}T00:00:00`);
    d.setDate(d.getDate() + 7);
    currentWeek = toIsoDate(d);
    void loadWeek();
  });
  container.querySelector<HTMLButtonElement>("#sc-week-today")!.addEventListener("click", () => {
    currentWeek = toIsoDate(mondayOf(new Date()));
    void loadWeek();
  });

  function showSubView(target: "entry" | "settings"): void {
    container.querySelectorAll<HTMLButtonElement>(".sub-view-tab").forEach((b) => b.classList.toggle("active", b.dataset.sub === target));
    entryView.style.display = target === "entry" ? "" : "none";
    settingsView.classList.toggle("hidden", target !== "settings");
  }
  container.querySelectorAll<HTMLButtonElement>(".sub-view-tab").forEach((btn) => {
    btn.addEventListener("click", () => showSubView(btn.dataset.sub as "entry" | "settings"));
  });

  function applyPermissions(): void {
    const canManage = hasPermission("view_scorecard_manager");
    settingsTab.classList.toggle("hidden", !canManage);
    if (!canManage) showSubView("entry");
  }

  subscribeAuth(() => {
    applyPermissions();
    void loadWeek();
    void loadSettings();
  });

  applyPermissions();
  void loadWeek();
  void loadSettings();
}
