import { save } from "@tauri-apps/plugin-dialog";
import {
  type BrandVoice,
  type CreditLimits,
  type CreditUsage,
  checkBackendHealth,
  connectEmailAccount,
  type PermissionCatalogue,
  type Role,
  adminSetUserPassword,
  assignUserRole,
  createRole,
  createTeamMember,
  deleteRole,
  deleteTeamMember,
  getAuditLog,
  getRoleCatalogue,
  getRoles,
  setDefaultRole,
  updateRole,
  disconnectEmailOAuthAccount,
  exportLogCsv,
  getBackendBaseUrl,
  getBrandVoice,
  getCreditUsage,
  listEmailOAuthAccounts,
  migrateLocalLeadsToTeam,
  saveCreditLimits,
  setBackendBaseUrl,
  updateBrandVoice,
  updateTeamMember,
} from "../api";
import { getCurrentUser, hasPermission, isAdmin, logout, subscribeAuth, updateLocalUser } from "../auth";
import { renderAvatarHtml } from "../avatar";
import { CONTACT_STATUS_ORDER } from "../constants";
import { getCompactRows, getDefaultContactStatus, setCompactRows, setDefaultContactStatus } from "../preferences";
import { refreshLeads } from "../state";
import { getTeamMembers, refreshTeamMembers, subscribeTeam } from "../team";
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

      <section class="card hidden" id="roles-card">
        <h2 class="card-title">Roles &amp; permissions</h2>
        <p class="card-subtitle">Create roles (BDM, BDE, anything) and choose what each can see and do. Admins always have full access.</p>
        <ul id="roles-list" class="history-list"></ul>
        <button id="new-role-btn" class="btn btn-secondary btn-sm">+ New role</button>
        <div id="role-editor" class="role-editor hidden"></div>
        <span id="roles-status" class="status-message"></span>
      </section>

      <section class="card hidden" id="audit-card">
        <h2 class="card-title">Audit log</h2>
        <p class="card-subtitle">Recent changes across the workspace — who did what.</p>
        <button id="audit-refresh-btn" class="btn btn-secondary btn-sm">Refresh</button>
        <ul id="audit-list" class="history-list audit-list"></ul>
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
        <h2 class="card-title">Credit Limits</h2>
        <p class="card-subtitle">Monthly spending caps per AI feature. Leave at £0 for no limit. Resets on the 1st of each month. Companies House data enrichment is always <strong>free</strong>.</p>
        <div id="credit-usage-content">
          <table class="credit-limits-table" style="width:100%;border-collapse:collapse;margin:var(--space-3) 0">
            <thead>
              <tr style="text-align:left;font-size:var(--text-sm);color:var(--text-muted)">
                <th style="padding:var(--space-2) var(--space-3) var(--space-2) 0;font-weight:500">Feature</th>
                <th style="padding:var(--space-2) var(--space-3);font-weight:500">Est. cost</th>
                <th style="padding:var(--space-2) var(--space-3);font-weight:500">This month</th>
                <th style="padding:var(--space-2) 0;font-weight:500">Monthly limit (£, 0 = no limit)</th>
              </tr>
            </thead>
            <tbody id="credit-limits-rows">
              <tr><td colspan="4" class="empty-hint" style="padding:var(--space-2) 0">Loading…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="card-actions">
          <button id="save-credit-limits-btn" class="btn btn-primary">Save limits</button>
          <span id="credit-limits-status" class="status-message"></span>
        </div>
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
  // Roles for the per-member "assign role" dropdown (loaded in the Roles section
  // below; renderTeam reads this array).
  let roles: Role[] = [];

  function renderTeam(): void {
    const members = getTeamMembers();
    const roster = document.querySelector("#team-roster")!;
    roster.innerHTML = members
      .map((m) => {
        if (!isAdmin()) {
          return `<li class="team-roster-row">${renderAvatarHtml(m, "avatar-sm")}<span>${escapeHtml(m.name)}</span> — ${escapeHtml(m.role)}</li>`;
        }
        const groleSelect = m.role === "admin"
          ? `<span class="grole-fixed">Full access</span>`
          : `<select class="inline-edit grole-select" data-user-id="${escapeHtml(m.id)}" title="Assign a role">
               ${roles
                 .filter((r) => r.id !== "role-admin")
                 .map((r) => `<option value="${escapeHtml(r.id)}" ${m.role_id === r.id ? "selected" : ""}>${escapeHtml(r.name)}</option>`)
                 .join("")}
             </select>`;
        return `
          <li class="team-roster-row">
            ${renderAvatarHtml(m, "avatar-sm")}
            <select class="inline-edit role-select" data-user-id="${escapeHtml(m.id)}">
              <option value="member" ${m.role === "member" ? "selected" : ""}>Member</option>
              <option value="admin" ${m.role === "admin" ? "selected" : ""}>Admin</option>
            </select>
            <span>${escapeHtml(m.name)}</span>
            ${groleSelect}
            <button class="btn btn-ghost btn-sm set-pw-btn" data-user-id="${escapeHtml(m.id)}" title="Set or reset this member's password">Set password</button>
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

    roster.querySelectorAll<HTMLSelectElement>(".grole-select").forEach((select) => {
      select.addEventListener("change", async () => {
        try {
          await assignUserRole(select.dataset.userId!, select.value);
          teamStatus.textContent = "Role updated.";
        } catch (err) {
          teamStatus.textContent = `Failed to update role: ${err}`;
        }
      });
    });

    roster.querySelectorAll<HTMLButtonElement>(".set-pw-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.userId!;
        const member = members.find((m) => m.id === userId);
        if (!member) return;
        const password = window.prompt(
          `Set a new password for ${member.name} (minimum 8 characters). They'll use it to sign in; this also signs them out of other sessions.`
        );
        if (password === null) return;
        if (password.length < 8) { teamStatus.textContent = "Password must be at least 8 characters."; return; }
        try {
          await adminSetUserPassword(userId, password);
          teamStatus.textContent = `Password set for ${member.name}.`;
        } catch (err) {
          teamStatus.textContent = `Failed to set password: ${err}`;
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

  // --- Roles & permissions (manage_roles only) ---
  const rolesCard = container.querySelector<HTMLElement>("#roles-card")!;
  const rolesList = container.querySelector<HTMLUListElement>("#roles-list")!;
  const roleEditor = container.querySelector<HTMLDivElement>("#role-editor")!;
  const rolesStatus = container.querySelector<HTMLSpanElement>("#roles-status")!;
  let catalogue: PermissionCatalogue | null = null;

  function scopeLabel(scope: string): string {
    return scope === "own_assigned" ? "Own / assigned leads only" : "Shared pool + own + assigned";
  }

  function renderRolesList(): void {
    rolesList.innerHTML = roles
      .map((r) => `
        <li class="role-row" data-id="${escapeHtml(r.id)}">
          <span class="role-name">${escapeHtml(r.name)}</span>
          ${r.is_default ? '<span class="role-badge">default</span>' : ""}
          ${r.is_system ? '<span class="role-badge system">built-in</span>' : ""}
          <span class="role-scope">${escapeHtml(scopeLabel(r.lead_scope))}</span>
          <span class="role-row-actions">
            ${r.id !== "role-admin" ? '<button class="btn btn-ghost btn-sm role-edit">Edit</button>' : ""}
            ${!r.is_default ? '<button class="btn btn-ghost btn-sm role-default">Make default</button>' : ""}
            ${!r.is_system ? '<button class="btn btn-ghost btn-danger btn-sm role-delete">Delete</button>' : ""}
          </span>
        </li>`)
      .join("");

    rolesList.querySelectorAll<HTMLElement>(".role-row").forEach((row) => {
      const role = roles.find((r) => r.id === row.dataset.id);
      if (!role) return;
      row.querySelector(".role-edit")?.addEventListener("click", () => openRoleEditor(role));
      row.querySelector(".role-default")?.addEventListener("click", async () => {
        try { await setDefaultRole(role.id); await loadRoles(); } catch (err) { rolesStatus.textContent = `Failed: ${err}`; }
      });
      row.querySelector(".role-delete")?.addEventListener("click", async () => {
        if (!window.confirm(`Delete the "${role.name}" role? Members on it move to the default role.`)) return;
        try { await deleteRole(role.id); await loadRoles(); } catch (err) { rolesStatus.textContent = `Failed: ${err}`; }
      });
    });
  }

  function openRoleEditor(role: Role | null): void {
    if (!catalogue) return;
    const selected = new Set(role?.permissions ?? []);
    const scope = role?.lead_scope ?? "all_shared";
    roleEditor.classList.remove("hidden");
    roleEditor.innerHTML = `
      <input id="role-name" class="search-input" placeholder="Role name (e.g. BDM)" value="${escapeHtml(role?.name ?? "")}" />
      ${catalogue.catalogue
        .map((group) => `
          <div class="perm-group">
            <h4>${escapeHtml(group.group)}</h4>
            ${group.items
              .map((item) => `<label class="perm-item"><input type="checkbox" data-perm="${escapeHtml(item.key)}" ${selected.has(item.key) ? "checked" : ""} /> ${escapeHtml(item.label)}</label>`)
              .join("")}
          </div>`)
        .join("")}
      <div class="perm-group">
        <h4>Which leads they see</h4>
        <label class="perm-item"><input type="radio" name="rolescope" value="all_shared" ${scope === "all_shared" ? "checked" : ""} /> Shared pool + own + assigned</label>
        <label class="perm-item"><input type="radio" name="rolescope" value="own_assigned" ${scope === "own_assigned" ? "checked" : ""} /> Only their own / assigned leads</label>
      </div>
      <div class="role-editor-actions">
        <button id="role-save" class="btn btn-primary btn-sm">${role ? "Save changes" : "Create role"}</button>
        <button id="role-cancel" class="btn btn-ghost btn-sm">Cancel</button>
      </div>`;

    roleEditor.querySelector("#role-cancel")!.addEventListener("click", () => roleEditor.classList.add("hidden"));
    roleEditor.querySelector("#role-save")!.addEventListener("click", async () => {
      const name = (roleEditor.querySelector<HTMLInputElement>("#role-name")!).value.trim();
      if (!name) { rolesStatus.textContent = "Role name is required."; return; }
      const perms = Array.from(roleEditor.querySelectorAll<HTMLInputElement>("input[data-perm]:checked")).map((el) => el.dataset.perm!);
      const chosenScope = roleEditor.querySelector<HTMLInputElement>("input[name='rolescope']:checked")?.value ?? "all_shared";
      try {
        if (role) await updateRole(role.id, name, perms, chosenScope);
        else await createRole(name, perms, chosenScope);
        roleEditor.classList.add("hidden");
        await loadRoles();
        rolesStatus.textContent = "Saved.";
      } catch (err) {
        rolesStatus.textContent = `Failed to save role: ${err}`;
      }
    });
  }

  async function loadRoles(): Promise<void> {
    if (!hasPermission("manage_roles")) { rolesCard.classList.add("hidden"); return; }
    rolesCard.classList.remove("hidden");
    try {
      if (!catalogue) catalogue = await getRoleCatalogue();
      roles = await getRoles();
      renderRolesList();
      renderTeam(); // populate the per-member role dropdowns now that roles are loaded
    } catch (err) {
      rolesStatus.textContent = `Failed to load roles: ${err}`;
    }
  }
  container.querySelector("#new-role-btn")!.addEventListener("click", () => openRoleEditor(null));
  subscribeAuth(loadRoles);
  void loadRoles();

  // --- Audit log (admin only) ---
  const auditCard = container.querySelector<HTMLElement>("#audit-card")!;
  const auditList = container.querySelector<HTMLUListElement>("#audit-list")!;
  async function renderAudit(): Promise<void> {
    auditCard.classList.toggle("hidden", !isAdmin());
    if (!isAdmin()) return;
    try {
      const entries = await getAuditLog(200);
      auditList.innerHTML = entries.length === 0
        ? '<li class="empty-hint">No activity recorded yet.</li>'
        : entries
            .map((e) => {
              const when = new Date(e.created_at).toLocaleString();
              const what = [e.action, e.entity_type].filter(Boolean).join(" ");
              const detail = e.detail ? ` — ${escapeHtml(e.detail)}` : "";
              return `<li class="audit-row"><span class="audit-when">${escapeHtml(when)}</span> <strong>${escapeHtml(e.actor_name || "—")}</strong> ${escapeHtml(what)}${detail}</li>`;
            })
            .join("");
    } catch (err) {
      auditList.innerHTML = `<li class="empty-hint">Failed to load audit log: ${escapeHtml(String(err))}</li>`;
    }
  }
  container.querySelector<HTMLButtonElement>("#audit-refresh-btn")!.addEventListener("click", () => void renderAudit());
  subscribeAuth(renderAudit);
  void renderAudit();

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

  // --- Credit limits ---
  // defaultLimit mirrors the backend's DEFAULT_CREDIT_LIMIT_GBP — applied
  // per user per month whenever no explicit limit is set. Nothing is unlimited.
  const CREDIT_FEATURE_LABELS: Record<string, { label: string; cost: string; defaultLimit: number }> = {
    phone_lookup:    { label: "Phone Lookup",           cost: "~£0.03 / lookup",          defaultLimit: 20 },
    sales_intel:     { label: "Sales Intelligence",     cost: "~£0.15 / generation",      defaultLimit: 20 },
    win_back:        { label: "Win-back Emails",         cost: "~£0.03 / email",           defaultLimit: 20 },
    ai_prospecting:  { label: "AI Prospecting (enrich)", cost: "~£0.15 / lead enriched",   defaultLimit: 50 },
    email_writer:    { label: "AI Email Writer",         cost: "~£0.03 / generation",      defaultLimit: 20 },
    enrichment:      { label: "Lead Enrichment",         cost: "~£0.05 / lead",            defaultLimit: 20 },
    lead_chat:       { label: "Lead Chat",               cost: "~£0.02 / message",         defaultLimit: 10 },
    linkedin_scrape: { label: "LinkedIn Activity",        cost: "~£1.60 / 1,000 posts",      defaultLimit: 15 },
    linkedin_discovery: { label: "LinkedIn Discovery",    cost: "~£0.03 / lookup",           defaultLimit: 10 },
  };

  const creditLimitsRows = document.querySelector<HTMLTableSectionElement>("#credit-limits-rows")!;
  const creditLimitsStatus = document.querySelector<HTMLSpanElement>("#credit-limits-status")!;
  let _currentLimits: CreditLimits = {
    limit_phone_lookup: 0, limit_sales_intel: 0, limit_win_back: 0,
    limit_ai_prospecting: 0, limit_email_writer: 0, limit_enrichment: 0, limit_lead_chat: 0,
    limit_linkedin_scrape: 0, limit_linkedin_discovery: 0,
  };

  async function renderCreditLimits(): Promise<void> {
    try {
      const usage: CreditUsage = await getCreditUsage();
      _currentLimits = usage.limits;
      creditLimitsRows.innerHTML = Object.entries(CREDIT_FEATURE_LABELS)
        .map(([key, { label, cost, defaultLimit }]) => {
          const limitKey = `limit_${key}` as keyof CreditLimits;
          const spendVal = usage.spend[key] ?? 0;
          const spend = spendVal.toFixed(2);
          const setLimit = usage.limits[limitKey] ?? 0;
          const effectiveLimit = setLimit > 0 ? setLimit : defaultLimit;
          const pct = Math.min(100, (spendVal / effectiveLimit) * 100);
          const overBudget = spendVal >= effectiveLimit;
          return `<tr style="border-top:1px solid var(--border)">
            <td style="padding:var(--space-2) var(--space-3) var(--space-2) 0">${label}</td>
            <td style="padding:var(--space-2) var(--space-3);color:var(--text-muted);font-size:var(--text-sm)">${cost}</td>
            <td style="padding:var(--space-2) var(--space-3)">
              <span style="color:${overBudget ? "var(--danger)" : "var(--accent)"}">£${spend}</span>
              <span style="color:var(--text-muted);font-size:var(--text-xs)"> / £${effectiveLimit}</span>
              <div style="margin-top:3px;height:4px;width:80px;background:var(--border);border-radius:2px"><div style="height:100%;width:${pct}%;background:${overBudget ? "var(--danger)" : "var(--accent)"};border-radius:2px"></div></div>
            </td>
            <td style="padding:var(--space-2) 0">
              <input type="number" class="search-input credit-limit-input" data-feature="${key}" min="0" step="1" value="${setLimit || ""}" placeholder="Default £${defaultLimit}" style="width:110px" />
            </td>
          </tr>`;
        })
        .join("");
    } catch {
      creditLimitsRows.innerHTML = `<tr><td colspan="4" class="empty-hint">Could not load — backend offline.</td></tr>`;
    }
  }

  void renderCreditLimits();

  document.querySelector("#save-credit-limits-btn")!.addEventListener("click", async () => {
    const inputs = document.querySelectorAll<HTMLInputElement>(".credit-limit-input");
    const newLimits: CreditLimits = { ..._currentLimits };
    inputs.forEach((input) => {
      const feat = input.dataset.feature as string;
      const val = parseFloat(input.value) || 0;
      (newLimits as unknown as Record<string, number>)[`limit_${feat}`] = val;
    });
    creditLimitsStatus.textContent = "Saving…";
    try {
      await saveCreditLimits(newLimits);
      _currentLimits = newLimits;
      creditLimitsStatus.textContent = "Saved";
      setTimeout(() => { creditLimitsStatus.textContent = ""; }, 1500);
    } catch (err) {
      creditLimitsStatus.textContent = `Failed: ${err}`;
    }
  });
}
