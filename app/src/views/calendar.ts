import {
  type CalendarEvent,
  addEvent,
  deleteEvent,
  listEventsForDate,
  refreshCalendarEvents,
  subscribeCalendarEvents,
  updateEvent,
} from "../calendarEvents";
import { getCurrentUser, subscribeAuth } from "../auth";
import { getLeads } from "../state";
import { escapeHtml } from "../utils";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toIsoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - copy.getDay());
  return copy;
}

function typeLabel(t: CalendarEvent["type"]): string {
  return t === "call" ? "Call" : t === "followup" ? "Follow-up" : "Task";
}

function formatTimeLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function timeOptionsHtml(): string {
  const options = ['<option value="">All day</option>'];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      options.push(`<option value="${value}">${formatTimeLabel(value)}</option>`);
    }
  }
  return options.join("");
}

function sortedDayEvents(dateIso: string): CalendarEvent[] {
  return [...listEventsForDate(dateIso)].sort((a, b) => {
    if (a.time === b.time) return 0;
    if (a.time === "") return -1;
    if (b.time === "") return 1;
    return a.time.localeCompare(b.time);
  });
}

export function initCalendar(): void {
  const container = document.querySelector<HTMLDivElement>("#view-calendar")!;
  container.innerHTML = `
    <main class="container">
      <header class="page-head">
        <div>
          <h1 class="page-title">Calendar</h1>
          <div class="page-meta"><span>Scheduled calls, follow-ups, and tasks — private to your account.</span></div>
        </div>
      </header>
      <section class="card">
        <div class="card-header-row">
          <div></div>
          <div class="card-header-actions">
            <button id="cal-prev-btn" class="btn btn-ghost" type="button">←</button>
            <span id="cal-period-label" class="card-subtitle"></span>
            <button id="cal-next-btn" class="btn btn-ghost" type="button">→</button>
            <button id="cal-view-toggle-btn" class="btn btn-secondary btn-sm" type="button">Week view</button>
          </div>
        </div>
        <div id="cal-grid" class="calendar-grid"></div>
      </section>

      <section class="card">
        <div class="card-header-row">
          <h2 class="card-title" id="cal-day-panel-title"></h2>
          <button id="cal-add-event-btn" class="btn btn-primary btn-sm" type="button">+ Add Event</button>
        </div>

        <div id="cal-event-form" class="new-list-form hidden">
          <input id="cal-event-title-input" type="text" class="search-input" placeholder="Title" />
          <input id="cal-event-date-input" type="date" class="search-input" />
          <select id="cal-event-time-select" class="inline-edit">${timeOptionsHtml()}</select>
          <select id="cal-event-type-select" class="inline-edit">
            <option value="call">Call</option>
            <option value="followup">Follow-up</option>
            <option value="task">Task</option>
          </select>
          <select id="cal-event-lead-select" class="inline-edit"></select>
          <button id="cal-event-save-btn" class="btn btn-primary btn-sm" type="button">Save</button>
          <button id="cal-event-cancel-btn" class="btn btn-ghost btn-sm" type="button">Cancel</button>
          <span id="cal-event-status" class="status-message"></span>
        </div>

        <ul id="cal-day-events-list" class="history-list"></ul>
        <p id="cal-day-events-empty" class="empty-hint hidden">No events on this day.</p>
      </section>
    </main>
  `;

  let currentMonth = new Date().getMonth();
  let currentYear = new Date().getFullYear();
  let viewMode: "month" | "week" = "month";
  let weekStart = startOfWeek(new Date());
  let selectedDate = toIsoDate(new Date());
  let editingEventId: string | null = null;

  const gridEl = document.querySelector<HTMLDivElement>("#cal-grid")!;
  const periodLabel = document.querySelector<HTMLSpanElement>("#cal-period-label")!;
  const viewToggleBtn = document.querySelector<HTMLButtonElement>("#cal-view-toggle-btn")!;
  const dayPanelTitle = document.querySelector<HTMLHeadingElement>("#cal-day-panel-title")!;
  const dayEventsList = document.querySelector<HTMLUListElement>("#cal-day-events-list")!;
  const dayEventsEmpty = document.querySelector<HTMLParagraphElement>("#cal-day-events-empty")!;
  const formEl = document.querySelector<HTMLDivElement>("#cal-event-form")!;
  const titleInput = document.querySelector<HTMLInputElement>("#cal-event-title-input")!;
  const dateInput = document.querySelector<HTMLInputElement>("#cal-event-date-input")!;
  const timeSelect = document.querySelector<HTMLSelectElement>("#cal-event-time-select")!;
  const typeSelect = document.querySelector<HTMLSelectElement>("#cal-event-type-select")!;
  const leadSelect = document.querySelector<HTMLSelectElement>("#cal-event-lead-select")!;

  function leadCompany(leadId: string): string {
    return getLeads().find((l) => l.id === leadId)?.company ?? "Unknown lead";
  }

  function updatePeriodLabel(): void {
    if (viewMode === "month") {
      periodLabel.textContent = new Date(currentYear, currentMonth, 1).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
    } else {
      const end = new Date(weekStart);
      end.setDate(weekStart.getDate() + 6);
      periodLabel.textContent = `${weekStart.toLocaleDateString()} – ${end.toLocaleDateString()}`;
    }
  }

  function renderMonthGrid(): void {
    const todayIso = toIsoDate(new Date());
    const first = new Date(currentYear, currentMonth, 1);
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const leading = first.getDay();

    const cells: string[] = [];
    for (let i = 0; i < leading; i++) cells.push('<div class="cal-day cal-day-empty"></div>');
    for (let day = 1; day <= daysInMonth; day++) {
      const dateIso = toIsoDate(new Date(currentYear, currentMonth, day));
      const count = listEventsForDate(dateIso).length;
      cells.push(`
        <div class="cal-day ${dateIso === todayIso ? "cal-day-today" : ""} ${dateIso === selectedDate ? "cal-day-selected" : ""}" data-date="${dateIso}">
          <span class="cal-day-number">${day}</span>
          ${count > 0 ? `<span class="cal-day-badge">${count}</span>` : ""}
        </div>
      `);
    }

    gridEl.className = "calendar-grid calendar-grid-month";
    gridEl.innerHTML = `
      <div class="calendar-weekdays">${WEEKDAY_NAMES.map((d) => `<div class="calendar-weekday">${d}</div>`).join("")}</div>
      <div class="calendar-days">${cells.join("")}</div>
    `;
    wireDayClicks();
  }

  function renderWeekGrid(): void {
    const todayIso = toIsoDate(new Date());
    const cells: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      const dateIso = toIsoDate(d);
      const count = listEventsForDate(dateIso).length;
      cells.push(`
        <div class="cal-day cal-day-week ${dateIso === todayIso ? "cal-day-today" : ""} ${dateIso === selectedDate ? "cal-day-selected" : ""}" data-date="${dateIso}">
          <span class="calendar-weekday">${WEEKDAY_NAMES[d.getDay()]}</span>
          <span class="cal-day-number">${d.getDate()}</span>
          ${count > 0 ? `<span class="cal-day-badge">${count}</span>` : ""}
        </div>
      `);
    }
    gridEl.className = "calendar-grid calendar-grid-week";
    gridEl.innerHTML = `<div class="calendar-days calendar-days-week">${cells.join("")}</div>`;
    wireDayClicks();
  }

  function wireDayClicks(): void {
    gridEl.querySelectorAll<HTMLDivElement>(".cal-day:not(.cal-day-empty)").forEach((cell) => {
      cell.addEventListener("click", () => {
        selectedDate = cell.dataset.date!;
        editingEventId = null;
        closeForm();
        renderAll();
      });
    });
  }

  function renderDayPanel(): void {
    dayPanelTitle.textContent = new Date(`${selectedDate}T00:00:00`).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    const dayEvents = sortedDayEvents(selectedDate);
    if (dayEvents.length === 0) {
      dayEventsList.innerHTML = "";
      dayEventsEmpty.classList.remove("hidden");
      return;
    }
    dayEventsEmpty.classList.add("hidden");
    dayEventsList.innerHTML = dayEvents
      .map(
        (e) => `
        <li class="history-list-row">
          <span>
            <span class="cal-event-time">${e.time ? escapeHtml(formatTimeLabel(e.time)) : "All day"}</span>
            <span class="status-badge cal-type-${e.type}">${typeLabel(e.type)}</span>
            ${escapeHtml(e.title)}${e.lead_id ? ` — ${escapeHtml(leadCompany(e.lead_id))}` : ""}
          </span>
          <span>
            <button class="btn btn-ghost btn-sm cal-edit-btn" type="button" data-event-id="${e.id}">Edit</button>
            <button class="btn btn-ghost btn-sm cal-delete-btn" type="button" data-event-id="${e.id}">Delete</button>
          </span>
        </li>`
      )
      .join("");

    dayEventsList.querySelectorAll<HTMLButtonElement>(".cal-edit-btn").forEach((btn) => {
      btn.addEventListener("click", () => openForm(btn.dataset.eventId!));
    });
    dayEventsList.querySelectorAll<HTMLButtonElement>(".cal-delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => void handleDelete(btn.dataset.eventId!));
    });
  }

  function populateLeadOptions(): void {
    const leads = getLeads();
    leadSelect.innerHTML = `
      <option value="">No linked lead</option>
      ${leads.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.company)}</option>`).join("")}
    `;
  }

  function openForm(eventId: string | null): void {
    editingEventId = eventId;
    populateLeadOptions();
    formEl.classList.remove("hidden");

    if (eventId) {
      const event = getEventById(eventId);
      if (event) {
        titleInput.value = event.title;
        dateInput.value = event.date;
        timeSelect.value = event.time;
        typeSelect.value = event.type;
        leadSelect.value = event.lead_id ?? "";
      }
    } else {
      titleInput.value = "";
      dateInput.value = selectedDate;
      timeSelect.value = "";
      typeSelect.value = "call";
      leadSelect.value = "";
    }
    titleInput.focus();
  }

  function getEventById(id: string): CalendarEvent | undefined {
    return listEventsForDate(selectedDate).find((e) => e.id === id);
  }

  function closeForm(): void {
    editingEventId = null;
    formEl.classList.add("hidden");
  }

  async function saveForm(): Promise<void> {
    const title = titleInput.value.trim();
    const date = dateInput.value;
    if (!title || !date) return;
    const time = timeSelect.value;
    const type = typeSelect.value as CalendarEvent["type"];
    const leadId = leadSelect.value || undefined;

    const saveBtn = document.querySelector<HTMLButtonElement>("#cal-event-save-btn")!;
    const status = document.querySelector<HTMLSpanElement>("#cal-event-status")!;
    saveBtn.disabled = true;
    status.textContent = "Saving...";

    try {
      if (editingEventId) {
        await updateEvent(editingEventId, { title, date, time, type, leadId });
      } else {
        await addEvent({ title, date, time, type, leadId });
      }
      selectedDate = date;
      closeForm();
      status.textContent = "";
    } catch (err) {
      status.textContent = `Failed to save: ${err}`;
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function handleDelete(eventId: string): Promise<void> {
    try {
      await deleteEvent(eventId);
    } catch (err) {
      const status = document.querySelector<HTMLSpanElement>("#cal-event-status");
      if (status) status.textContent = `Failed to delete: ${err}`;
    }
  }

  function renderAll(): void {
    updatePeriodLabel();
    if (viewMode === "month") renderMonthGrid();
    else renderWeekGrid();
    renderDayPanel();
  }

  document.querySelector("#cal-prev-btn")!.addEventListener("click", () => {
    if (viewMode === "month") {
      currentMonth -= 1;
      if (currentMonth < 0) {
        currentMonth = 11;
        currentYear -= 1;
      }
    } else {
      weekStart.setDate(weekStart.getDate() - 7);
    }
    renderAll();
  });

  document.querySelector("#cal-next-btn")!.addEventListener("click", () => {
    if (viewMode === "month") {
      currentMonth += 1;
      if (currentMonth > 11) {
        currentMonth = 0;
        currentYear += 1;
      }
    } else {
      weekStart.setDate(weekStart.getDate() + 7);
    }
    renderAll();
  });

  viewToggleBtn.addEventListener("click", () => {
    viewMode = viewMode === "month" ? "week" : "month";
    viewToggleBtn.textContent = viewMode === "month" ? "Week view" : "Month view";
    if (viewMode === "week") {
      weekStart = startOfWeek(new Date(`${selectedDate}T00:00:00`));
    }
    renderAll();
  });

  document.querySelector("#cal-add-event-btn")!.addEventListener("click", () => openForm(null));
  document.querySelector("#cal-event-save-btn")!.addEventListener("click", () => void saveForm());
  document.querySelector("#cal-event-cancel-btn")!.addEventListener("click", closeForm);

  subscribeCalendarEvents(renderAll);
  renderAll();

  // Calendar events require a logged-in session — fetch once auth resolves,
  // same pattern as Dashboard's leads and Cold Call Lists' lists.
  subscribeAuth(() => {
    if (!getCurrentUser()) return;
    void refreshCalendarEvents();
  });
}
