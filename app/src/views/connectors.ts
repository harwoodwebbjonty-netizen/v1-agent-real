import {
  connectCalendarAccount,
  connectEmailAccount,
  disconnectCalendarOAuthAccount,
  disconnectEmailOAuthAccount,
  listCalendarOAuthAccounts,
  listEmailOAuthAccounts,
  type EmailProvider,
} from "../api";
import { escapeHtml } from "../utils";

// Self-service, every-user "Connectors" page — deliberately outside admin-only
// Settings (see tabBar.ts's NAV_PERMISSIONS: "connectors" has no permission
// entry, so every signed-in user sees it regardless of role). The backend's
// email-oauth endpoints were already fully per-user (keyed off current_user.id,
// no admin gate) — this just gives that existing capability a home everyone
// can actually reach, instead of it being reachable only from inside Settings.

export function initConnectors(): void {
  const container = document.querySelector<HTMLDivElement>("#view-connectors")!;
  container.innerHTML = `
    <main class="container">
      <header class="page-head">
        <div>
          <h1 class="page-title">Connectors</h1>
          <div class="page-meta"><span>Connect your own email and calling apps — each connection is personal to your account.</span></div>
        </div>
      </header>

      <section class="card">
        <h2 class="card-title">Email</h2>
        <p class="card-subtitle">Connect your own Gmail or Microsoft account so the AI Email Writer and win-back campaigns send as you. Consent happens in your browser, never inside this app — same as connecting Google to Mailchimp or any other tool.</p>
        <ul id="conn-email-accounts-list" class="history-list"></ul>
        <div class="card-actions">
          <button id="conn-connect-gmail-btn" class="btn btn-secondary btn-sm">Connect Gmail</button>
          <button id="conn-connect-microsoft-btn" class="btn btn-secondary btn-sm">Connect Microsoft</button>
          <button id="conn-check-email-btn" class="btn btn-ghost btn-sm">Check connection</button>
        </div>
        <span id="conn-email-status" class="status-message"></span>
      </section>

      <section class="card">
        <h2 class="card-title">Calendar</h2>
        <p class="card-subtitle">Connect your own Google or Outlook calendar so calls and follow-ups you schedule in this CRM also show up where you actually check your day. One-way for now: creating an event here pushes it out to your connected calendar; edits made on the calendar side don't sync back yet.</p>
        <ul id="conn-calendar-accounts-list" class="history-list"></ul>
        <div class="card-actions">
          <button id="conn-connect-gcal-btn" class="btn btn-secondary btn-sm">Connect Google Calendar</button>
          <button id="conn-connect-outlook-cal-btn" class="btn btn-secondary btn-sm">Connect Outlook Calendar</button>
          <button id="conn-check-calendar-btn" class="btn btn-ghost btn-sm">Check connection</button>
        </div>
        <span id="conn-calendar-status" class="status-message"></span>
      </section>

      <section class="card">
        <h2 class="card-title">Calling</h2>
        <p class="card-subtitle">Every phone number in the CRM is a <code>tel:</code> link — clicking one hands the call straight to whatever your computer has set as its default calling app (Communicator, FaceTime, Skype, etc.). There's nothing to connect here; it already works.</p>
        <p class="card-subtitle">If calls aren't opening in the app you expect, check that app's own settings for a "Set as default" / "Make default for calls" option, or your operating system's default-apps settings for <code>tel:</code> links — that's an OS-level choice, not something this CRM controls.</p>
      </section>
    </main>
  `;

  const list = container.querySelector<HTMLUListElement>("#conn-email-accounts-list")!;
  const status = container.querySelector<HTMLSpanElement>("#conn-email-status")!;

  async function renderAccounts(): Promise<void> {
    try {
      const accounts = await listEmailOAuthAccounts();
      list.innerHTML =
        accounts.length === 0
          ? '<li class="empty-hint">No accounts connected yet.</li>'
          : accounts
              .map(
                (a) => `
              <li class="history-list-row">
                <span>${escapeHtml(a.provider)} — ${escapeHtml(a.email_address)}</span>
                <button class="btn btn-ghost btn-sm conn-disconnect-btn" data-provider="${a.provider}">Disconnect</button>
              </li>`
              )
              .join("");
      list.querySelectorAll<HTMLButtonElement>(".conn-disconnect-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await disconnectEmailOAuthAccount(btn.dataset.provider as EmailProvider);
          await renderAccounts();
        });
      });
    } catch (err) {
      status.textContent = `Failed to load: ${err}`;
    }
  }
  void renderAccounts();

  container.querySelector("#conn-connect-gmail-btn")!.addEventListener("click", async () => {
    try {
      await connectEmailAccount("gmail");
      status.textContent = 'Continue in your browser, then click "Check connection".';
    } catch (err) {
      status.textContent = `Failed: ${err}`;
    }
  });

  container.querySelector("#conn-connect-microsoft-btn")!.addEventListener("click", async () => {
    try {
      await connectEmailAccount("microsoft");
      status.textContent = 'Continue in your browser, then click "Check connection".';
    } catch (err) {
      status.textContent = `Failed: ${err}`;
    }
  });

  container.querySelector("#conn-check-email-btn")!.addEventListener("click", async () => {
    status.textContent = "";
    await renderAccounts();
  });

  const calendarList = container.querySelector<HTMLUListElement>("#conn-calendar-accounts-list")!;
  const calendarStatus = container.querySelector<HTMLSpanElement>("#conn-calendar-status")!;

  async function renderCalendarAccounts(): Promise<void> {
    try {
      const accounts = await listCalendarOAuthAccounts();
      calendarList.innerHTML =
        accounts.length === 0
          ? '<li class="empty-hint">No calendars connected yet.</li>'
          : accounts
              .map(
                (a) => `
              <li class="history-list-row">
                <span>${escapeHtml(a.provider)} — ${escapeHtml(a.email_address)}</span>
                <button class="btn btn-ghost btn-sm conn-cal-disconnect-btn" data-provider="${a.provider}">Disconnect</button>
              </li>`
              )
              .join("");
      calendarList.querySelectorAll<HTMLButtonElement>(".conn-cal-disconnect-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await disconnectCalendarOAuthAccount(btn.dataset.provider as EmailProvider);
          await renderCalendarAccounts();
        });
      });
    } catch (err) {
      calendarStatus.textContent = `Failed to load: ${err}`;
    }
  }
  void renderCalendarAccounts();

  container.querySelector("#conn-connect-gcal-btn")!.addEventListener("click", async () => {
    try {
      await connectCalendarAccount("gmail");
      calendarStatus.textContent = 'Continue in your browser, then click "Check connection".';
    } catch (err) {
      calendarStatus.textContent = `Failed: ${err}`;
    }
  });

  container.querySelector("#conn-connect-outlook-cal-btn")!.addEventListener("click", async () => {
    try {
      await connectCalendarAccount("microsoft");
      calendarStatus.textContent = 'Continue in your browser, then click "Check connection".';
    } catch (err) {
      calendarStatus.textContent = `Failed: ${err}`;
    }
  });

  container.querySelector("#conn-check-calendar-btn")!.addEventListener("click", async () => {
    calendarStatus.textContent = "";
    await renderCalendarAccounts();
  });
}
