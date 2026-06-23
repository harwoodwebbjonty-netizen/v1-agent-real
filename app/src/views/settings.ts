import { save } from "@tauri-apps/plugin-dialog";
import {
  type BrandVoice,
  checkBackendHealth,
  connectEmailAccount,
  createTeamMember,
  deleteTeamMember,
  disconnectEmailOAuthAccount,
  exportLogCsv,
  getBackendBaseUrl,
  getBrandVoice,
  listEmailOAuthAccounts,
  migrateLocalLeadsToTeam,
  setBackendBaseUrl,
  updateBrandVoice,
  updateTeamMember,
} from "../api";
import { getCurrentUser, isAdmin, logout, subscribeAuth, updateLocalUser } from "../auth";
import { renderAvatarHtml } from "../avatar";
import { CONTACT_STATUS_ORDER } from "../constants";
import { getCompactRows, getDefaultContactStatus, setCompactRows, setDefaultContactStatus } from "../preferences";
import { refreshLeads } from "../state";
import { getTeamMembers, refreshTeamMembers, subscribeTeam } from "../team";
import { getStoredTheme, subscribeTheme, toggleTheme } from "../theme";
import { escapeHtml } from "../utils";

export function initSettings(): void {
  const container = document.querySelector<HTMLDivElement>("#view-settings")!;
  container.innerHTML = `
    <main class="container">
      <section class="card">
        <h2 class="card-title">Account</h2>
        <p class="card-subtitle" id="account-info"></p>
        <div class="card-actions">
          <button id="logout-btn" class="btn btn-secondary">Log out</button>
        </div>
      </section>

      <section class="card">
        <h2 class="card-title">Appearance</h2>
        <p class="card-subtitle">Theme applies across the whole app.</p>
        <div class="card-actions">
          <button id="settings-theme-toggle-btn" class="btn btn-secondary">
            Toggle Theme (<span id="settings-theme-label"></span>)
          </button>
        </div>
      </section>

      <section class="card">
        <h2 class="card-title">Backend Connection</h2>
        <p class="card-subtitle">Where this app's team workspace lives. Change this if the backend is hosted somewhere other than your machine.</p>
        <div class="card-actions">
          <input id="backend-url-input" type="text" class="search-input backend-url-input" />
          <button id="save-backend-url-btn" class="btn btn-secondary">Save</button>
          <button id="test-connection-btn" class="btn btn-secondary">Test Connection</button>
        </div>
        <span id="connection-status" class="status-message"></span>
      </section>

      <section class="card">
        <h2 class="card-title">Team</h2>
        <p class="card-subtitle">Everyone in this workspace shares the same leads.</p>
        <ul id="team-roster" class="history-list"></ul>
        <div id="add-member-form" class="hidden add-member-form">
          <div class="login-fields">
            <input id="new-member-name" type="text" class="search-input" placeholder="Name" />
            <select id="new-member-role" class="inline-edit">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button id="add-member-btn" class="btn btn-primary">Add team member</button>
        </div>
        <span id="team-status" class="status-message"></span>
      </section>

      <section class="card">
        <h2 class="card-title">Data Management</h2>
        <div class="card-actions">
          <button id="settings-export-btn" class="btn btn-secondary">Export CSV</button>
          <button id="migrate-btn" class="btn btn-secondary hidden">Import existing local leads</button>
        </div>
        <span id="data-status" class="status-message"></span>
      </section>

      <section class="card">
        <h2 class="card-title">Lead Defaults</h2>
        <label class="card-subtitle" for="default-contact-status-select">Default contact status for new leads</label>
        <select id="default-contact-status-select" class="inline-edit">
          ${CONTACT_STATUS_ORDER.map((s) => `<option value="${s}">${s}</option>`).join("")}
        </select>
      </section>

      <section class="card">
        <h2 class="card-title">Preferences</h2>
        <label class="checkbox-row">
          <input type="checkbox" id="compact-rows-checkbox" />
          Compact table rows
        </label>
      </section>

      <section class="card">
        <h2 class="card-title">Brand Voice</h2>
        <p class="card-subtitle">Used automatically by the AI Email Writer — you never have to repeat this in instructions.</p>
        <div class="login-fields">
          <input id="bv-company-name" type="text" class="search-input" placeholder="Company name" />
          <input id="bv-company-description" type="text" class="search-input" placeholder="Company description" />
          <input id="bv-industry" type="text" class="search-input" placeholder="Industry" />
          <input id="bv-target-audience" type="text" class="search-input" placeholder="Target audience" />
          <input id="bv-core-services" type="text" class="search-input" placeholder="Core services" />
          <input id="bv-usp" type="text" class="search-input" placeholder="Unique selling points" />
          <input id="bv-writing-style" type="text" class="search-input" placeholder="Preferred writing style" />
          <input id="bv-cta-style" type="text" class="search-input" placeholder="Preferred CTA style" />
          <input id="bv-email-length" type="text" class="search-input" placeholder="Preferred email length" />
          <input id="bv-website" type="text" class="search-input" placeholder="Website" />
          <input id="bv-booking-link" type="text" class="search-input" placeholder="Booking link" />
          <textarea id="bv-signature" rows="3" placeholder="Signature"></textarea>
        </div>
        <div class="card-actions">
          <button id="bv-save-btn" class="btn btn-primary">Save Brand Voice</button>
          <span id="bv-status" class="status-message"></span>
        </div>
      </section>

      <section class="card">
        <h2 class="card-title">Email Accounts</h2>
        <p class="card-subtitle">Connect a real account so the AI Email Writer can send for real. Consent happens in your browser, never inside this app.</p>
        <ul id="email-accounts-list" class="history-list"></ul>
        <div class="card-actions">
          <button id="connect-gmail-btn" class="btn btn-secondary btn-sm">Connect Gmail</button>
          <button id="connect-microsoft-btn" class="btn btn-secondary btn-sm">Connect Microsoft</button>
          <button id="check-email-connection-btn" class="btn btn-ghost btn-sm">Check connection</button>
        </div>
        <span id="email-accounts-status" class="status-message"></span>
      </section>
    </main>
  `;

  // --- Account ---
  function renderAccount(): void {
    const user = getCurrentUser();
    document.querySelector("#account-info")!.textContent = user
      ? `Signed in as ${user.name} — ${user.role}`
      : "Not signed in";
  }
  renderAccount();
  subscribeAuth(renderAccount);
  document.querySelector("#logout-btn")!.addEventListener("click", () => void logout());

  // --- Appearance ---
  const themeLabel = document.querySelector<HTMLSpanElement>("#settings-theme-label")!;
  function updateThemeLabel(): void {
    themeLabel.textContent = getStoredTheme() === "dark" ? "Dark" : "Light";
  }
  updateThemeLabel();
  subscribeTheme(updateThemeLabel);
  document.querySelector("#settings-theme-toggle-btn")!.addEventListener("click", () => {
    toggleTheme();
  });

  // --- Backend connection ---
  const backendUrlInput = document.querySelector<HTMLInputElement>("#backend-url-input")!;
  void getBackendBaseUrl().then((url) => {
    backendUrlInput.value = url;
  });

  const connectionStatus = document.querySelector<HTMLSpanElement>("#connection-status")!;
  document.querySelector("#save-backend-url-btn")!.addEventListener("click", async () => {
    await setBackendBaseUrl(backendUrlInput.value.trim());
    connectionStatus.textContent = "Saved. Test the connection to confirm it's reachable.";
  });
  document.querySelector("#test-connection-btn")!.addEventListener("click", async () => {
    connectionStatus.textContent = "Checking...";
    try {
      await checkBackendHealth();
      connectionStatus.textContent = "Connected";
    } catch (err) {
      connectionStatus.textContent = `Failed: ${err}`;
    }
  });

  // --- Team ---
  const teamStatus = document.querySelector<HTMLSpanElement>("#team-status")!;
  const addMemberForm = document.querySelector<HTMLDivElement>("#add-member-form")!;

  function renderTeam(): void {
    const members = getTeamMembers();
    const roster = document.querySelector("#team-roster")!;
    roster.innerHTML = members
      .map((m) => {
        if (!isAdmin()) {
          return `<li class="team-roster-row">${renderAvatarHtml(m, "avatar-sm")}<span>${escapeHtml(m.name)}</span> — ${escapeHtml(m.role)}</li>`;
        }
        return `
          <li class="team-roster-row">
            ${renderAvatarHtml(m, "avatar-sm")}
            <select class="inline-edit role-select" data-user-id="${escapeHtml(m.id)}">
              <option value="member" ${m.role === "member" ? "selected" : ""}>Member</option>
              <option value="admin" ${m.role === "admin" ? "selected" : ""}>Admin</option>
            </select>
            <span>${escapeHtml(m.name)}</span>
            <button class="btn btn-ghost btn-sm delete-member-btn" data-user-id="${escapeHtml(m.id)}" title="Remove">✕</button>
          </li>
        `;
      })
      .join("");

    roster.querySelectorAll<HTMLSelectElement>(".role-select").forEach((select) => {
      select.addEventListener("change", async () => {
        const userId = select.dataset.userId!;
        try {
          const updated = await updateTeamMember(userId, { role: select.value as "admin" | "member" });
          updateLocalUser(updated);
          await refreshTeamMembers();
        } catch (err) {
          teamStatus.textContent = `Failed to update role: ${err}`;
          select.value = getTeamMembers().find((m) => m.id === userId)?.role ?? select.value;
        }
      });
    });

    roster.querySelectorAll<HTMLButtonElement>(".delete-member-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.userId!;
        const member = members.find((m) => m.id === userId);
        if (!member || !window.confirm(`Remove ${member.name} from the team?`)) return;
        try {
          await deleteTeamMember(userId);
          if (getCurrentUser()?.id === userId) {
            await logout();
          }
          await refreshTeamMembers();
        } catch (err) {
          teamStatus.textContent = `Failed to remove team member: ${err}`;
        }
      });
    });

    addMemberForm.classList.toggle("hidden", !isAdmin());
  }
  renderTeam();
  subscribeTeam(renderTeam);
  subscribeAuth(renderTeam);

  document.querySelector("#add-member-btn")!.addEventListener("click", async () => {
    const nameInput = document.querySelector<HTMLInputElement>("#new-member-name")!;
    const name = nameInput.value.trim();
    const role = document.querySelector<HTMLSelectElement>("#new-member-role")!.value as "admin" | "member";
    if (!name) return;
    try {
      await createTeamMember(name, role);
      await refreshTeamMembers();
      nameInput.value = "";
      teamStatus.textContent = `Added ${name}.`;
    } catch (err) {
      teamStatus.textContent = `Failed to add team member: ${err}`;
    }
  });

  // --- Data management ---
  const dataStatus = document.querySelector<HTMLSpanElement>("#data-status")!;
  const migrateBtn = document.querySelector<HTMLButtonElement>("#migrate-btn")!;

  function updateMigrateVisibility(): void {
    migrateBtn.classList.toggle("hidden", !isAdmin());
  }
  updateMigrateVisibility();
  subscribeAuth(updateMigrateVisibility);

  migrateBtn.addEventListener("click", async () => {
    try {
      const imported = await migrateLocalLeadsToTeam();
      await refreshLeads();
      dataStatus.textContent = `Imported ${imported} lead(s) from your local log.`;
    } catch (err) {
      dataStatus.textContent = `Import failed: ${err}`;
    }
  });

  document.querySelector("#settings-export-btn")!.addEventListener("click", async () => {
    const path = await save({
      defaultPath: "phone_lookups_export.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (path) {
      try {
        await exportLogCsv(path);
        dataStatus.textContent = `Exported to ${path}`;
      } catch (err) {
        dataStatus.textContent = `Export failed: ${err}`;
      }
    }
  });

  // --- Lead defaults ---
  const defaultStatusSelect = document.querySelector<HTMLSelectElement>("#default-contact-status-select")!;
  defaultStatusSelect.value = getDefaultContactStatus();
  defaultStatusSelect.addEventListener("change", () => setDefaultContactStatus(defaultStatusSelect.value));

  // --- Preferences ---
  const compactRowsCheckbox = document.querySelector<HTMLInputElement>("#compact-rows-checkbox")!;
  compactRowsCheckbox.checked = getCompactRows();
  document.body.classList.toggle("compact-rows", getCompactRows());
  compactRowsCheckbox.addEventListener("change", () => {
    setCompactRows(compactRowsCheckbox.checked);
    document.body.classList.toggle("compact-rows", compactRowsCheckbox.checked);
  });

  // --- Brand voice ---
  const bvFields: Record<keyof BrandVoice, string> = {
    company_name: "#bv-company-name",
    company_description: "#bv-company-description",
    industry: "#bv-industry",
    target_audience: "#bv-target-audience",
    core_services: "#bv-core-services",
    unique_selling_points: "#bv-usp",
    preferred_writing_style: "#bv-writing-style",
    preferred_cta_style: "#bv-cta-style",
    preferred_email_length: "#bv-email-length",
    website: "#bv-website",
    booking_link: "#bv-booking-link",
    signature: "#bv-signature",
  };
  const bvStatus = document.querySelector<HTMLSpanElement>("#bv-status")!;

  void getBrandVoice().then((bv) => {
    for (const [key, selector] of Object.entries(bvFields)) {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
      if (el) el.value = bv[key as keyof BrandVoice];
    }
  });

  document.querySelector("#bv-save-btn")!.addEventListener("click", async () => {
    const values: Record<string, string> = {};
    for (const [key, selector] of Object.entries(bvFields)) {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
      values[key] = el?.value.trim() ?? "";
    }
    const brandVoice = values as unknown as BrandVoice;
    bvStatus.textContent = "Saving...";
    try {
      await updateBrandVoice(brandVoice);
      bvStatus.textContent = "Saved";
      setTimeout(() => {
        bvStatus.textContent = "";
      }, 1500);
    } catch (err) {
      bvStatus.textContent = `Failed to save: ${err}`;
    }
  });

  // --- Email accounts (OAuth sending) ---
  const emailAccountsList = document.querySelector<HTMLUListElement>("#email-accounts-list")!;
  const emailAccountsStatus = document.querySelector<HTMLSpanElement>("#email-accounts-status")!;

  async function renderEmailAccounts(): Promise<void> {
    try {
      const accounts = await listEmailOAuthAccounts();
      emailAccountsList.innerHTML =
        accounts.length === 0
          ? '<li class="empty-hint">No accounts connected yet.</li>'
          : accounts
              .map(
                (a) => `
              <li class="history-list-row">
                <span>${escapeHtml(a.provider)} — ${escapeHtml(a.email_address)}</span>
                <button class="btn btn-ghost btn-sm email-disconnect-btn" data-provider="${a.provider}">Disconnect</button>
              </li>`
              )
              .join("");
      emailAccountsList.querySelectorAll<HTMLButtonElement>(".email-disconnect-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await disconnectEmailOAuthAccount(btn.dataset.provider as "gmail" | "microsoft");
          await renderEmailAccounts();
        });
      });
    } catch (err) {
      emailAccountsStatus.textContent = `Failed to load: ${err}`;
    }
  }
  void renderEmailAccounts();

  document.querySelector("#connect-gmail-btn")!.addEventListener("click", async () => {
    try {
      await connectEmailAccount("gmail");
      emailAccountsStatus.textContent = "Continue in your browser, then click \"Check connection\".";
    } catch (err) {
      emailAccountsStatus.textContent = `Failed: ${err}`;
    }
  });

  document.querySelector("#connect-microsoft-btn")!.addEventListener("click", async () => {
    try {
      await connectEmailAccount("microsoft");
      emailAccountsStatus.textContent = "Continue in your browser, then click \"Check connection\".";
    } catch (err) {
      emailAccountsStatus.textContent = `Failed: ${err}`;
    }
  });

  document.querySelector("#check-email-connection-btn")!.addEventListener("click", async () => {
    emailAccountsStatus.textContent = "";
    await renderEmailAccounts();
  });
}
