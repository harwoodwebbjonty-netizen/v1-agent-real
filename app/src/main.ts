import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import "./style.css";

interface LookupResult {
  company: string;
  phone_number: string;
  source_url: string;
  status: "verified" | "unverified" | "not_found";
  notes: string;
}

const companiesInput = document.querySelector<HTMLTextAreaElement>("#companies")!;
const lookupBtn = document.querySelector<HTMLButtonElement>("#lookup-btn")!;
const exportBtn = document.querySelector<HTMLButtonElement>("#export-btn")!;
const resultsBody = document.querySelector<HTMLTableSectionElement>("#results-body")!;
const statusMessage = document.querySelector<HTMLSpanElement>("#status-message")!;

function renderRow(result: LookupResult) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td>${result.company}</td>
    <td>${result.phone_number}</td>
    <td>${result.source_url ? `<a href="${result.source_url}" target="_blank">${result.source_url}</a>` : ""}</td>
    <td>${result.status}</td>
    <td>${result.notes}</td>
  `;
  resultsBody.appendChild(row);
}

function renderError(company: string, message: string) {
  const row = document.createElement("tr");
  row.innerHTML = `<td>${company}</td><td colspan="4">Error: ${message}</td>`;
  resultsBody.appendChild(row);
}

async function runLookups(companies: string[]) {
  lookupBtn.disabled = true;
  for (const company of companies) {
    statusMessage.textContent = `Looking up ${company}...`;
    try {
      const result = await invoke<LookupResult>("lookup_company_phone", { company });
      renderRow(result);
    } catch (err) {
      renderError(company, String(err));
    }
  }
  statusMessage.textContent = "";
  lookupBtn.disabled = false;
}

lookupBtn.addEventListener("click", () => {
  const companies = companiesInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (companies.length > 0) {
    void runLookups(companies);
  }
});

exportBtn.addEventListener("click", async () => {
  const path = await save({
    defaultPath: "phone_lookups_export.csv",
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (path) {
    try {
      await invoke("export_log_csv", { destPath: path });
      statusMessage.textContent = `Exported to ${path}`;
    } catch (err) {
      statusMessage.textContent = `Export failed: ${err}`;
    }
  }
});

async function loadExistingLog() {
  try {
    const entries = await invoke<LookupResult[]>("get_log_entries");
    entries.forEach(renderRow);
  } catch (err) {
    console.error("Failed to load existing log:", err);
  }
}

void loadExistingLog();
