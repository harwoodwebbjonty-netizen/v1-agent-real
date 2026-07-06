import {
  type ProspectingCriteria,
  type ProspectingRun,
  getProspectingRun,
  getProspectingStatus,
  listProspectingRuns,
  startProspectingRun,
} from "../api";
import { escapeHtml } from "../utils";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const SIC_CODES: { code: string; name: string; group: string }[] = [
  // Agriculture & Forestry
  { code: "01110", name: "Growing of cereals & oil seeds", group: "Agriculture & Forestry" },
  { code: "01130", name: "Growing of vegetables & salad crops", group: "Agriculture & Forestry" },
  { code: "01210", name: "Growing of grapes", group: "Agriculture & Forestry" },
  { code: "01410", name: "Raising of dairy cattle", group: "Agriculture & Forestry" },
  { code: "01500", name: "Mixed farming", group: "Agriculture & Forestry" },
  { code: "02100", name: "Silviculture & forestry", group: "Agriculture & Forestry" },
  { code: "03110", name: "Marine fishing", group: "Agriculture & Forestry" },
  { code: "03210", name: "Marine aquaculture", group: "Agriculture & Forestry" },
  // Food & Drink Manufacturing
  { code: "10110", name: "Processing & preserving of meat", group: "Food & Drink Manufacturing" },
  { code: "10200", name: "Processing & preserving of fish", group: "Food & Drink Manufacturing" },
  { code: "10510", name: "Dairy & cheese making", group: "Food & Drink Manufacturing" },
  { code: "10612", name: "Manufacture of breakfast cereals", group: "Food & Drink Manufacturing" },
  { code: "10720", name: "Manufacture of rusks, biscuits & preserved pastry", group: "Food & Drink Manufacturing" },
  { code: "10820", name: "Manufacture of cocoa, chocolate & confectionery", group: "Food & Drink Manufacturing" },
  { code: "11010", name: "Distilling & blending of spirits", group: "Food & Drink Manufacturing" },
  { code: "11020", name: "Manufacture of wine", group: "Food & Drink Manufacturing" },
  { code: "11050", name: "Manufacture of beer", group: "Food & Drink Manufacturing" },
  { code: "11060", name: "Manufacture of malt", group: "Food & Drink Manufacturing" },
  { code: "11070", name: "Manufacture of soft drinks", group: "Food & Drink Manufacturing" },
  // Industrial & Engineering Manufacturing
  { code: "24100", name: "Manufacture of basic iron & steel", group: "Industrial & Engineering" },
  { code: "24200", name: "Manufacture of tubes, pipes & hollow profiles", group: "Industrial & Engineering" },
  { code: "24340", name: "Drawing of wire", group: "Industrial & Engineering" },
  { code: "25110", name: "Manufacture of metal structures", group: "Industrial & Engineering" },
  { code: "25120", name: "Manufacture of doors & windows of metal", group: "Industrial & Engineering" },
  { code: "25210", name: "Manufacture of central heating radiators & boilers", group: "Industrial & Engineering" },
  { code: "25500", name: "Forging, pressing, stamping of metal", group: "Industrial & Engineering" },
  { code: "25610", name: "Treatment & coating of metals", group: "Industrial & Engineering" },
  { code: "25620", name: "Machining", group: "Industrial & Engineering" },
  { code: "25710", name: "Manufacture of cutlery", group: "Industrial & Engineering" },
  { code: "25730", name: "Manufacture of tools", group: "Industrial & Engineering" },
  { code: "25990", name: "Manufacture of other fabricated metal products", group: "Industrial & Engineering" },
  { code: "28110", name: "Manufacture of engines & turbines", group: "Industrial & Engineering" },
  { code: "28150", name: "Manufacture of bearings, gears & gearing", group: "Industrial & Engineering" },
  { code: "28220", name: "Manufacture of lifting & handling equipment", group: "Industrial & Engineering" },
  { code: "28290", name: "Manufacture of other general-purpose machinery", group: "Industrial & Engineering" },
  { code: "28410", name: "Manufacture of metal forming machinery", group: "Industrial & Engineering" },
  { code: "28490", name: "Manufacture of other machine tools", group: "Industrial & Engineering" },
  { code: "28920", name: "Manufacture of machinery for mining & quarrying", group: "Industrial & Engineering" },
  { code: "28930", name: "Manufacture of food, beverage & tobacco processing machinery", group: "Industrial & Engineering" },
  { code: "29100", name: "Manufacture of motor vehicles", group: "Industrial & Engineering" },
  { code: "29200", name: "Manufacture of bodies for motor vehicles", group: "Industrial & Engineering" },
  { code: "29320", name: "Manufacture of other parts & accessories for motor vehicles", group: "Industrial & Engineering" },
  { code: "30110", name: "Building of ships & floating structures", group: "Industrial & Engineering" },
  { code: "30200", name: "Manufacture of railway locomotives & rolling stock", group: "Industrial & Engineering" },
  { code: "33110", name: "Repair of fabricated metal products", group: "Industrial & Engineering" },
  { code: "33120", name: "Repair of machinery", group: "Industrial & Engineering" },
  { code: "33190", name: "Repair of other equipment", group: "Industrial & Engineering" },
  // Chemicals & Pharma
  { code: "20110", name: "Manufacture of industrial gases", group: "Chemicals & Pharma" },
  { code: "20130", name: "Manufacture of other inorganic basic chemicals", group: "Chemicals & Pharma" },
  { code: "20150", name: "Manufacture of fertilisers & nitrogen compounds", group: "Chemicals & Pharma" },
  { code: "20200", name: "Manufacture of pesticides", group: "Chemicals & Pharma" },
  { code: "20300", name: "Manufacture of paints, varnishes & coatings", group: "Chemicals & Pharma" },
  { code: "20410", name: "Manufacture of soap & detergents", group: "Chemicals & Pharma" },
  { code: "21100", name: "Manufacture of basic pharmaceutical products", group: "Chemicals & Pharma" },
  { code: "21200", name: "Manufacture of pharmaceutical preparations", group: "Chemicals & Pharma" },
  { code: "22110", name: "Manufacture of rubber tyres & tubes", group: "Chemicals & Pharma" },
  { code: "22190", name: "Manufacture of other rubber products", group: "Chemicals & Pharma" },
  // Technology & Electronics
  { code: "26110", name: "Manufacture of electronic components", group: "Technology & Electronics" },
  { code: "26200", name: "Manufacture of computers & peripheral equipment", group: "Technology & Electronics" },
  { code: "26300", name: "Manufacture of communication equipment", group: "Technology & Electronics" },
  { code: "26400", name: "Manufacture of consumer electronics", group: "Technology & Electronics" },
  { code: "26510", name: "Manufacture of instruments for measuring & testing", group: "Technology & Electronics" },
  { code: "26600", name: "Manufacture of medical & dental instruments", group: "Technology & Electronics" },
  { code: "27110", name: "Manufacture of electric motors, generators & transformers", group: "Technology & Electronics" },
  { code: "27400", name: "Manufacture of electric lighting equipment", group: "Technology & Electronics" },
  { code: "27510", name: "Manufacture of electric domestic appliances", group: "Technology & Electronics" },
  // Construction
  { code: "41100", name: "Development of building projects", group: "Construction" },
  { code: "41201", name: "Construction of commercial buildings", group: "Construction" },
  { code: "41202", name: "Construction of domestic buildings", group: "Construction" },
  { code: "42110", name: "Construction of roads & motorways", group: "Construction" },
  { code: "42120", name: "Construction of railways & underground railways", group: "Construction" },
  { code: "42210", name: "Construction of utility projects for fluids", group: "Construction" },
  { code: "42910", name: "Construction of water projects", group: "Construction" },
  { code: "43110", name: "Demolition", group: "Construction" },
  { code: "43120", name: "Site preparation", group: "Construction" },
  { code: "43210", name: "Electrical installation", group: "Construction" },
  { code: "43220", name: "Plumbing, heat & air-conditioning installation", group: "Construction" },
  { code: "43290", name: "Other construction installation", group: "Construction" },
  { code: "43310", name: "Plastering", group: "Construction" },
  { code: "43320", name: "Joinery installation", group: "Construction" },
  { code: "43330", name: "Floor & wall covering", group: "Construction" },
  { code: "43341", name: "Painting", group: "Construction" },
  { code: "43390", name: "Other building completion & finishing", group: "Construction" },
  { code: "43910", name: "Roofing activities", group: "Construction" },
  { code: "43999", name: "Other specialised construction activities", group: "Construction" },
  // Transport & Logistics
  { code: "49100", name: "Passenger rail transport, interurban", group: "Transport & Logistics" },
  { code: "49200", name: "Freight rail transport", group: "Transport & Logistics" },
  { code: "49310", name: "Urban & suburban passenger land transport", group: "Transport & Logistics" },
  { code: "49390", name: "Other passenger land transport", group: "Transport & Logistics" },
  { code: "49410", name: "Freight transport by road", group: "Transport & Logistics" },
  { code: "49420", name: "Removal services", group: "Transport & Logistics" },
  { code: "50200", name: "Sea & coastal freight water transport", group: "Transport & Logistics" },
  { code: "51210", name: "Freight air transport", group: "Transport & Logistics" },
  { code: "52100", name: "Warehousing & storage", group: "Transport & Logistics" },
  { code: "52210", name: "Service activities incidental to land transportation", group: "Transport & Logistics" },
  { code: "52240", name: "Cargo handling", group: "Transport & Logistics" },
  { code: "52290", name: "Other transportation support activities", group: "Transport & Logistics" },
  { code: "53100", name: "Postal activities under universal service obligation", group: "Transport & Logistics" },
  { code: "53200", name: "Other postal & courier activities", group: "Transport & Logistics" },
  // Wholesale Trade
  { code: "46130", name: "Agents selling timber, construction & sanitary equipment", group: "Wholesale Trade" },
  { code: "46140", name: "Agents selling machinery, industrial equipment & watercraft", group: "Wholesale Trade" },
  { code: "46170", name: "Agents involved in the sale of food, beverages & tobacco", group: "Wholesale Trade" },
  { code: "46310", name: "Wholesale of fruit & vegetables", group: "Wholesale Trade" },
  { code: "46320", name: "Wholesale of meat & meat products", group: "Wholesale Trade" },
  { code: "46380", name: "Wholesale of other food", group: "Wholesale Trade" },
  { code: "46410", name: "Wholesale of textiles", group: "Wholesale Trade" },
  { code: "46430", name: "Wholesale of electrical household appliances", group: "Wholesale Trade" },
  { code: "46460", name: "Wholesale of pharmaceutical goods", group: "Wholesale Trade" },
  { code: "46510", name: "Wholesale of computers & peripheral equipment", group: "Wholesale Trade" },
  { code: "46630", name: "Wholesale of mining, construction & civil engineering machinery", group: "Wholesale Trade" },
  { code: "46710", name: "Wholesale of solid, liquid & gaseous fuels", group: "Wholesale Trade" },
  { code: "46720", name: "Wholesale of metals & metal ores", group: "Wholesale Trade" },
  { code: "46730", name: "Wholesale of wood, construction materials & sanitary equipment", group: "Wholesale Trade" },
  { code: "46750", name: "Wholesale of chemical products", group: "Wholesale Trade" },
  { code: "46770", name: "Wholesale of waste & scrap", group: "Wholesale Trade" },
  // Real Estate
  { code: "68100", name: "Buying & selling of own real estate", group: "Real Estate" },
  { code: "68201", name: "Renting & operating of Housing Association real estate", group: "Real Estate" },
  { code: "68202", name: "Letting & operating of conference & exhibition centres", group: "Real Estate" },
  { code: "68209", name: "Other letting & operating of own or leased real estate", group: "Real Estate" },
  { code: "68310", name: "Real estate agencies", group: "Real Estate" },
  { code: "68320", name: "Management of real estate on a fee or contract basis", group: "Real Estate" },
  // Professional & Legal Services
  { code: "69101", name: "Barristers at law", group: "Professional Services" },
  { code: "69102", name: "Solicitors", group: "Professional Services" },
  { code: "69109", name: "Activities of patent & copyright agents", group: "Professional Services" },
  { code: "69201", name: "Accounting & auditing activities", group: "Professional Services" },
  { code: "69202", name: "Bookkeeping activities", group: "Professional Services" },
  { code: "69203", name: "Tax consultancy", group: "Professional Services" },
  { code: "70100", name: "Activities of head offices", group: "Professional Services" },
  { code: "70221", name: "Financial management", group: "Professional Services" },
  { code: "70229", name: "Management consultancy activities", group: "Professional Services" },
  { code: "71111", name: "Architectural activities", group: "Professional Services" },
  { code: "71121", name: "Engineering design activities", group: "Professional Services" },
  { code: "71200", name: "Technical testing & analysis", group: "Professional Services" },
  { code: "73110", name: "Advertising agencies", group: "Professional Services" },
  { code: "73200", name: "Market research & public opinion polling", group: "Professional Services" },
  { code: "74100", name: "Specialised design activities", group: "Professional Services" },
  { code: "74900", name: "Other professional, scientific & technical activities", group: "Professional Services" },
  // IT & Technology Services
  { code: "58210", name: "Publishing of computer games", group: "IT & Technology" },
  { code: "58290", name: "Other software publishing", group: "IT & Technology" },
  { code: "61100", name: "Wired telecommunications activities", group: "IT & Technology" },
  { code: "61200", name: "Wireless telecommunications activities", group: "IT & Technology" },
  { code: "61900", name: "Other telecommunications activities", group: "IT & Technology" },
  { code: "62011", name: "Ready-made interactive leisure & entertainment software development", group: "IT & Technology" },
  { code: "62012", name: "Business & domestic software development", group: "IT & Technology" },
  { code: "62020", name: "Information technology consultancy activities", group: "IT & Technology" },
  { code: "62030", name: "Computer facilities management activities", group: "IT & Technology" },
  { code: "62090", name: "Other information technology service activities", group: "IT & Technology" },
  { code: "63110", name: "Data processing, hosting & related activities", group: "IT & Technology" },
  { code: "63120", name: "Web portals", group: "IT & Technology" },
  // Health & Social Care
  { code: "86101", name: "Hospital activities", group: "Health & Social Care" },
  { code: "86210", name: "General medical practice activities", group: "Health & Social Care" },
  { code: "86220", name: "Specialist medical practice activities", group: "Health & Social Care" },
  { code: "86230", name: "Dental practice activities", group: "Health & Social Care" },
  { code: "86900", name: "Other human health activities", group: "Health & Social Care" },
  { code: "87100", name: "Residential nursing care activities", group: "Health & Social Care" },
  { code: "87200", name: "Residential care for learning difficulties, mental health & substance abuse", group: "Health & Social Care" },
  { code: "87300", name: "Residential care for the elderly & disabled", group: "Health & Social Care" },
  { code: "87900", name: "Other residential care activities", group: "Health & Social Care" },
  { code: "88100", name: "Social work activities without accommodation for the elderly & disabled", group: "Health & Social Care" },
  { code: "88910", name: "Child day-care activities", group: "Health & Social Care" },
  { code: "88990", name: "Other social work activities without accommodation", group: "Health & Social Care" },
  // Hospitality & Food Service
  { code: "55100", name: "Hotels & similar accommodation", group: "Hospitality & Food Service" },
  { code: "55200", name: "Holiday & other short-stay accommodation", group: "Hospitality & Food Service" },
  { code: "55900", name: "Other accommodation", group: "Hospitality & Food Service" },
  { code: "56101", name: "Licensed restaurants", group: "Hospitality & Food Service" },
  { code: "56102", name: "Unlicensed restaurants & cafes", group: "Hospitality & Food Service" },
  { code: "56103", name: "Take-away food shops & mobile food stands", group: "Hospitality & Food Service" },
  { code: "56210", name: "Event catering activities", group: "Hospitality & Food Service" },
  { code: "56290", name: "Other food service activities", group: "Hospitality & Food Service" },
  { code: "56301", name: "Licensed clubs", group: "Hospitality & Food Service" },
  { code: "56302", name: "Public houses & bars", group: "Hospitality & Food Service" },
  // Business Services
  { code: "77110", name: "Renting & leasing of cars & light motor vehicles", group: "Business Services" },
  { code: "77320", name: "Renting & leasing of construction & civil engineering machinery", group: "Business Services" },
  { code: "77330", name: "Renting & leasing of office machinery", group: "Business Services" },
  { code: "77390", name: "Renting & leasing of other machinery", group: "Business Services" },
  { code: "78100", name: "Activities of employment placement agencies", group: "Business Services" },
  { code: "78200", name: "Temporary employment agency activities", group: "Business Services" },
  { code: "78300", name: "Human resources provision & management", group: "Business Services" },
  { code: "80100", name: "Private security activities", group: "Business Services" },
  { code: "81100", name: "Combined facilities support activities", group: "Business Services" },
  { code: "81210", name: "General cleaning of buildings", group: "Business Services" },
  { code: "81300", name: "Landscape service activities", group: "Business Services" },
  { code: "82110", name: "Combined office administrative service activities", group: "Business Services" },
  { code: "82200", name: "Call centre activities", group: "Business Services" },
  { code: "82920", name: "Packaging activities", group: "Business Services" },
  { code: "82990", name: "Other business support service activities n.e.c.", group: "Business Services" },
  // Finance & Insurance
  { code: "64190", name: "Other monetary intermediation", group: "Finance & Insurance" },
  { code: "64910", name: "Financial leasing", group: "Finance & Insurance" },
  { code: "64921", name: "Credit granting by non-deposit taking finance houses", group: "Finance & Insurance" },
  { code: "64922", name: "Activities of mortgage finance companies", group: "Finance & Insurance" },
  { code: "64929", name: "Other credit granting", group: "Finance & Insurance" },
  { code: "64992", name: "Factoring", group: "Finance & Insurance" },
  { code: "64999", name: "Other financial service activities n.e.c.", group: "Finance & Insurance" },
  { code: "66110", name: "Administration of financial markets", group: "Finance & Insurance" },
  { code: "66190", name: "Other activities auxiliary to financial services", group: "Finance & Insurance" },
  { code: "66220", name: "Activities of insurance agents & brokers", group: "Finance & Insurance" },
  { code: "66300", name: "Fund management activities", group: "Finance & Insurance" },
];

const UK_COUNTIES: string[] = [
  // England — Regions
  "East Midlands", "East of England", "Greater London", "North East England",
  "North West England", "South East England", "South West England",
  "West Midlands Region", "Yorkshire and The Humber",
  // England — Counties
  "Bedfordshire", "Berkshire", "Bristol", "Buckinghamshire", "Cambridgeshire",
  "Cheshire", "Cornwall", "Cumbria", "Derbyshire", "Devon", "Dorset", "Durham",
  "East Riding of Yorkshire", "East Sussex", "Essex", "Gloucestershire",
  "Greater Manchester", "Hampshire", "Herefordshire", "Hertfordshire",
  "Isle of Wight", "Kent", "Lancashire", "Leicestershire", "Lincolnshire",
  "Merseyside", "Norfolk", "North Yorkshire", "Northamptonshire", "Northumberland",
  "Nottinghamshire", "Oxfordshire", "Rutland", "Shropshire", "Somerset",
  "South Yorkshire", "Staffordshire", "Suffolk", "Surrey", "Tyne and Wear",
  "Warwickshire", "West Midlands", "West Sussex", "West Yorkshire",
  "Wiltshire", "Worcestershire",
  // Wales
  "Cardiff", "Swansea", "Newport", "Rhondda Cynon Taf", "Vale of Glamorgan",
  "Bridgend", "Caerphilly", "Merthyr Tydfil", "Blaenau Gwent", "Torfaen",
  "Monmouthshire", "Powys", "Ceredigion", "Pembrokeshire", "Carmarthenshire",
  "Neath Port Talbot", "Conwy", "Denbighshire", "Flintshire", "Wrexham",
  "Gwynedd", "Isle of Anglesey",
  // Scotland
  "Aberdeen City", "Aberdeenshire", "Angus", "Argyll and Bute",
  "Clackmannanshire", "Dumfries and Galloway", "Dundee City", "East Ayrshire",
  "East Dunbartonshire", "East Lothian", "East Renfrewshire", "Edinburgh",
  "Falkirk", "Fife", "Glasgow City", "Highland", "Inverclyde", "Midlothian",
  "Moray", "North Ayrshire", "North Lanarkshire", "Orkney Islands",
  "Perth and Kinross", "Renfrewshire", "Scottish Borders", "Shetland Islands",
  "South Ayrshire", "South Lanarkshire", "Stirling", "West Dunbartonshire",
  "West Lothian",
  // Northern Ireland
  "Belfast", "Antrim", "Armagh", "Down", "Fermanagh", "Londonderry", "Tyrone",
];

const CHARGE_TYPES: string[] = [
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

// ---------------------------------------------------------------------------
// Module-level state (persists across partial re-renders)
// ---------------------------------------------------------------------------

interface FormState {
  name: string;
  nameManuallySet: boolean;
  sicCodes: string[];
  locations: string[];
  incorporatedFrom: string;
  incorporatedTo: string;
  maxResults: number;
  minChScore: number;
  runAiEnrichment: boolean;
  creditLimitGbp: number;
  chargeTypes: string[];
  activeChargesOnly: boolean;
  includeSatisfied: boolean;
  newChargesOnly: boolean;
  chargeRegisteredFrom: string;
  chargeRegisteredTo: string;
  minCharges: number;
  maxCharges: number;
}

const DEFAULT_STATE: FormState = {
  name: "",
  nameManuallySet: false,
  sicCodes: [],
  locations: [],
  incorporatedFrom: "",
  incorporatedTo: "",
  maxResults: 50,
  minChScore: 0,
  runAiEnrichment: false,
  creditLimitGbp: 0,
  chargeTypes: [],
  activeChargesOnly: false,
  includeSatisfied: true,
  newChargesOnly: false,
  chargeRegisteredFrom: "",
  chargeRegisteredTo: "",
  minCharges: 0,
  maxCharges: 0,
};

let state: FormState = { ...DEFAULT_STATE };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function autoSuggestName(): string {
  const parts: string[] = [];
  if (state.sicCodes.length > 0) {
    const groups = new Set(
      state.sicCodes.map((c) => SIC_CODES.find((s) => s.code === c)?.group).filter(Boolean)
    );
    if (groups.size === 1) parts.push([...groups][0] as string);
    else if (groups.size > 1) parts.push("Multi-sector");
  }
  if (state.locations.length > 0) {
    if (state.locations.length <= 2) parts.push(state.locations.join(" & "));
    else parts.push(`${state.locations.length} regions`);
  }
  if (state.incorporatedFrom || state.incorporatedTo) {
    const from = state.incorporatedFrom ? new Date(state.incorporatedFrom).getFullYear() : null;
    const to = state.incorporatedTo ? new Date(state.incorporatedTo).getFullYear() : null;
    if (from && to && from === to) parts.push(String(from));
    else if (from && to) parts.push(`${from}–${to}`);
    else if (from) parts.push(`From ${from}`);
    else if (to) parts.push(`To ${to}`);
  }
  if (state.newChargesOnly) parts.push("New Charges");
  else if (state.activeChargesOnly) parts.push("Active Charges");
  if (state.chargeTypes.length === 1) parts.push(state.chargeTypes[0]);
  return parts.length > 0 ? parts.join(" · ") : "";
}

function setDatePreset(preset: string) {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toStr = fmt(today);
  let fromDate = new Date(today);
  if (preset === "30d") fromDate.setDate(today.getDate() - 30);
  else if (preset === "90d") fromDate.setDate(today.getDate() - 90);
  else if (preset === "12m") fromDate.setFullYear(today.getFullYear() - 1);
  else if (preset === "3y") fromDate.setFullYear(today.getFullYear() - 3);
  else if (preset === "5y") fromDate.setFullYear(today.getFullYear() - 5);
  state.incorporatedFrom = fmt(fromDate);
  state.incorporatedTo = toStr;
}

function buildActiveFiltersHtml(): string {
  const chips: string[] = [];
  if (state.sicCodes.length > 0) {
    const label =
      state.sicCodes.length === 1
        ? (SIC_CODES.find((s) => s.code === state.sicCodes[0])?.name ?? state.sicCodes[0])
        : `${state.sicCodes.length} SIC codes`;
    chips.push(`<span class="p-filter-chip" data-clear="sicCodes">${escapeHtml(label)} <span class="p-filter-chip-x">✕</span></span>`);
  }
  if (state.locations.length > 0) {
    const label = state.locations.length === 1 ? state.locations[0] : `${state.locations.length} locations`;
    chips.push(`<span class="p-filter-chip" data-clear="locations">${escapeHtml(label)} <span class="p-filter-chip-x">✕</span></span>`);
  }
  if (state.incorporatedFrom || state.incorporatedTo) {
    const label = state.incorporatedFrom && state.incorporatedTo
      ? `${state.incorporatedFrom} → ${state.incorporatedTo}`
      : state.incorporatedFrom ? `From ${state.incorporatedFrom}` : `To ${state.incorporatedTo}`;
    chips.push(`<span class="p-filter-chip" data-clear="dates">${escapeHtml(label)} <span class="p-filter-chip-x">✕</span></span>`);
  }
  if (state.chargeTypes.length > 0) {
    const label = state.chargeTypes.length === 1 ? state.chargeTypes[0] : `${state.chargeTypes.length} charge types`;
    chips.push(`<span class="p-filter-chip" data-clear="chargeTypes">${escapeHtml(label)} <span class="p-filter-chip-x">✕</span></span>`);
  }
  if (state.activeChargesOnly) chips.push(`<span class="p-filter-chip" data-clear="activeChargesOnly">Active charges only <span class="p-filter-chip-x">✕</span></span>`);
  if (state.newChargesOnly) chips.push(`<span class="p-filter-chip" data-clear="newChargesOnly">New charges only <span class="p-filter-chip-x">✕</span></span>`);
  if (!state.includeSatisfied) chips.push(`<span class="p-filter-chip" data-clear="includeSatisfied">Exclude satisfied <span class="p-filter-chip-x">✕</span></span>`);
  if (state.minCharges > 0) chips.push(`<span class="p-filter-chip" data-clear="minCharges">Min ${state.minCharges} charges <span class="p-filter-chip-x">✕</span></span>`);
  if (state.maxCharges > 0) chips.push(`<span class="p-filter-chip" data-clear="maxCharges">Max ${state.maxCharges} charges <span class="p-filter-chip-x">✕</span></span>`);
  if (state.chargeRegisteredFrom || state.chargeRegisteredTo) {
    chips.push(`<span class="p-filter-chip" data-clear="chargeDates">Charge dates filtered <span class="p-filter-chip-x">✕</span></span>`);
  }
  if (chips.length === 0) return "";
  return `<div class="p-filters-strip">
    <span class="stat-label" style="flex-shrink:0">Active filters:</span>
    ${chips.join("")}
    <button type="button" class="btn btn-ghost btn-sm" id="clear-all-btn">Clear all</button>
  </div>`;
}

function buildMultiSelectHtml(
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

function buildRangeSliderHtml(id: string, min: number, max: number, value: number, label: string, hint: string, step = 1): string {
  return `<div class="prospecting-field">
    <label class="stat-label">${escapeHtml(label)}${hint ? `<span class="p-tip"><span class="p-tip-icon">?</span><span class="p-tip-content">${escapeHtml(hint)}</span></span>` : ""}</label>
    <div class="p-slider-wrap">
      <input type="range" class="p-slider" id="slider-${escapeHtml(id)}" min="${min}" max="${max}" value="${value}" step="${step}" />
      <input type="number" class="search-input p-slider-num" id="num-${escapeHtml(id)}" min="${min}" max="${max}" value="${value}" />
    </div>
  </div>`;
}

function buildRunSummary(run: ProspectingRun): string {
  try {
    const c = JSON.parse(run.criteria) as Partial<ProspectingCriteria>;
    const parts: string[] = [];
    const locs = c.locations?.length ? c.locations : c.location ? [c.location] : [];
    if (locs.length) parts.push(locs.join(", "));
    if (c.sic_codes?.length) parts.push(`${c.sic_codes.length} SIC code${c.sic_codes.length > 1 ? "s" : ""}`);
    if (c.charge_types?.length) parts.push(`${c.charge_types.length} charge type${c.charge_types.length > 1 ? "s" : ""}`);
    if (c.active_charges_only) parts.push("active charges");
    if (c.new_charges_only) parts.push("new charges only");
    if (c.incorporated_from || c.incorporated_to) parts.push("date filtered");
    return parts.length ? parts.join(" · ") : "No filters";
  } catch {
    return "";
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function initAiProspecting(): void {
  const container = document.querySelector<HTMLDivElement>("#view-ai-prospecting")!;

  async function render(): Promise<void> {
    let configured = false;
    let runs: ProspectingRun[] = [];
    try {
      const [status, runList] = await Promise.all([getProspectingStatus(), listProspectingRuns()]);
      configured = status.configured;
      runs = runList;
    } catch { /* backend offline */ }

    const sicOptions = SIC_CODES.map((s) => ({ value: s.code, label: `${s.code} — ${s.name}`, group: s.group }));
    const locationOptions = UK_COUNTIES.map((c) => ({ value: c, label: c }));
    const chargeOptions = CHARGE_TYPES.map((t) => ({ value: t, label: t }));

    const suggestedName = !state.nameManuallySet ? autoSuggestName() : state.name;

    container.innerHTML = `
      <main class="container">
        <section class="card-title-row">
          <span class="card-icon-badge" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6M8 11h6"/></svg>
          </span>
          <h2 class="card-title">AI Prospecting</h2>
        </section>
        <p class="card-subtitle">Automatically discover new UK businesses from Companies House, enrich their profile, and score them — so your BDEs call better-qualified leads.</p>

        ${!configured
          ? `<section class="card">
              <h3 class="card-title">⚙ Setup required</h3>
              <p style="margin:var(--space-2) 0 var(--space-3)">Add your free Companies House API key to start:</p>
              <ol style="font-size:var(--text-sm);line-height:2;padding-left:var(--space-5)">
                <li>Register at <strong>developer.company-information.service.gov.uk</strong></li>
                <li>Create an application and copy your API key</li>
                <li>Add <code>COMPANIES_HOUSE_API_KEY=your_key</code> to the backend <code>.env</code></li>
                <li>Restart: <code>systemctl restart phone-lookup-backend</code></li>
              </ol>
            </section>`
          : `<section class="card prospecting-run-panel">
              <h3 class="action-section-title">Run AI Prospecting</h3>
              <p class="card-subtitle">Set your filters and click Run. Discovered leads are added to Cold Call Lists under the run name.</p>

              ${buildActiveFiltersHtml()}

              <div class="prospecting-form">

                <!-- Run Name -->
                <div class="prospecting-field">
                  <label class="stat-label">Run name <span style="color:var(--danger)">*</span></label>
                  <input type="text" id="run-name-input" class="search-input" placeholder="Auto-suggested from filters…" value="${escapeHtml(suggestedName)}" style="max-width:480px" />
                </div>

                <!-- Industry / SIC -->
                <div class="prospecting-field">
                  <label class="stat-label">Industry / SIC codes</label>
                  ${buildMultiSelectHtml("sic", sicOptions, state.sicCodes, "Search by industry name or SIC code…")}
                </div>

                <!-- Location -->
                <div class="prospecting-field">
                  <label class="stat-label">County / Region</label>
                  ${buildMultiSelectHtml("location", locationOptions, state.locations, "Search counties & regions…")}
                </div>

                <!-- Incorporated dates -->
                <div class="prospecting-field">
                  <label class="stat-label">Incorporated between</label>
                  <div class="p-date-presets">
                    <button type="button" class="btn btn-ghost btn-sm date-preset-btn" data-preset="30d">Last 30 days</button>
                    <button type="button" class="btn btn-ghost btn-sm date-preset-btn" data-preset="90d">Last 90 days</button>
                    <button type="button" class="btn btn-ghost btn-sm date-preset-btn" data-preset="12m">Last 12 months</button>
                    <button type="button" class="btn btn-ghost btn-sm date-preset-btn" data-preset="3y">Last 3 years</button>
                    <button type="button" class="btn btn-ghost btn-sm date-preset-btn" data-preset="5y">Last 5 years</button>
                  </div>
                  <div class="prospecting-fields-row" style="gap:var(--space-3)">
                    <div class="prospecting-field" style="flex:1">
                      <label class="stat-label">From</label>
                      <input type="date" id="inc-from-input" class="search-input" value="${escapeHtml(state.incorporatedFrom)}" />
                    </div>
                    <div class="prospecting-field" style="flex:1">
                      <label class="stat-label">To</label>
                      <input type="date" id="inc-to-input" class="search-input" value="${escapeHtml(state.incorporatedTo)}" />
                    </div>
                  </div>
                </div>

                <!-- Sliders row -->
                <div class="prospecting-fields-row">
                  ${buildRangeSliderHtml("max-results", 1, 10000, state.maxResults, "Leads to add", "Target number of leads that pass your filters to add to the CRM. The system scans as many CH companies as needed (up to 10,000) until it finds this many matching your criteria.", 50)}
                  ${buildRangeSliderHtml("min-score", 0, 100, state.minChScore, "Min CH score (0 = all)", "Free pre-filter score from Companies House data — new charges, sector fit, company age. No AI cost. Set to 30+ to focus on companies with recent borrowing activity.")}
                </div>

                <!-- AI toggle + cost estimate -->
                <div class="prospecting-field">
                  <label class="checkbox-row">
                    <input type="checkbox" id="ai-enrichment-toggle" ${state.runAiEnrichment ? "checked" : ""} />
                    Run full AI Sales Intelligence on new leads
                    <span class="empty-hint" style="margin-left:6px">(~£0.15 per lead)</span>
                  </label>
                  ${state.runAiEnrichment ? `
                  <div class="p-cost-row" style="margin-top:var(--space-3);display:flex;align-items:center;gap:var(--space-4);flex-wrap:wrap">
                    <span class="stat-label">
                      Est. total cost:
                      <strong style="color:var(--accent)">£${(state.maxResults * 0.15).toFixed(2)}</strong>
                      <span class="empty-hint">(if all ${state.maxResults} leads are enriched)</span>
                    </span>
                    <label class="stat-label" style="display:flex;align-items:center;gap:var(--space-2);white-space:nowrap">
                      Credit limit (£)
                      <span class="p-tip"><span class="p-tip-icon">?</span><span class="p-tip-content">Stop AI enrichment once this amount is spent. 0 = no limit. Leads are still added without AI intelligence once the limit is hit.</span></span>
                      <input type="number" id="credit-limit-input" class="search-input" min="0" step="1" value="${state.creditLimitGbp || ""}" placeholder="No limit" style="width:90px" />
                    </label>
                  </div>` : ""}
                </div>

                <!-- Charge Filters -->
                <div class="p-section-label">
                  Charge filters
                  <span class="p-tip"><span class="p-tip-icon">?</span><span class="p-tip-content">Filter companies based on their registered charges at Companies House. Charges indicate active financing — useful for finding companies already working with lenders.</span></span>
                </div>

                <div class="prospecting-field">
                  <label class="stat-label">Charge types</label>
                  ${buildMultiSelectHtml("charge", chargeOptions, state.chargeTypes, "Filter by type of charge (e.g. Debenture, Fixed Charge)…")}
                </div>

                <div class="prospecting-fields-row">
                  <div class="prospecting-field">
                    <label class="checkbox-row">
                      <input type="checkbox" id="active-charges-toggle" ${state.activeChargesOnly ? "checked" : ""} />
                      Active charges only
                      <span class="p-tip"><span class="p-tip-icon">?</span><span class="p-tip-content">Only include companies with at least one outstanding (non-satisfied) charge.</span></span>
                    </label>
                  </div>
                  <div class="prospecting-field">
                    <label class="checkbox-row">
                      <input type="checkbox" id="new-charges-toggle" ${state.newChargesOnly ? "checked" : ""} />
                      New charges only (last 90 days)
                      <span class="p-tip"><span class="p-tip-icon">?</span><span class="p-tip-content">Only include companies that registered a new charge within the last 90 days — strong signal of recent financing activity.</span></span>
                    </label>
                  </div>
                  <div class="prospecting-field">
                    <label class="checkbox-row">
                      <input type="checkbox" id="include-satisfied-toggle" ${state.includeSatisfied ? "checked" : ""} />
                      Include satisfied charges
                      <span class="p-tip"><span class="p-tip-icon">?</span><span class="p-tip-content">When unchecked, only outstanding charges are counted towards charge filters.</span></span>
                    </label>
                  </div>
                </div>

                <div class="prospecting-field">
                  <label class="stat-label">Charge registered between</label>
                  <div class="prospecting-fields-row" style="gap:var(--space-3)">
                    <div class="prospecting-field" style="flex:1">
                      <label class="stat-label">From</label>
                      <input type="date" id="charge-from-input" class="search-input" value="${escapeHtml(state.chargeRegisteredFrom)}" />
                    </div>
                    <div class="prospecting-field" style="flex:1">
                      <label class="stat-label">To</label>
                      <input type="date" id="charge-to-input" class="search-input" value="${escapeHtml(state.chargeRegisteredTo)}" />
                    </div>
                  </div>
                </div>

                <div class="prospecting-fields-row">
                  ${buildRangeSliderHtml("min-charges", 0, 20, state.minCharges, "Min number of charges", "Only include companies with at least this many charges registered at Companies House. 0 = no minimum.")}
                  ${buildRangeSliderHtml("max-charges", 0, 50, state.maxCharges, "Max number of charges (0 = any)", "Only include companies with at most this many charges. 0 = no maximum.")}
                </div>

                <div class="card-actions" style="margin-top:var(--space-4)">
                  <button type="button" id="run-prospecting-btn" class="btn btn-primary">Run AI Prospecting</button>
                  <span id="run-status-msg" class="status-message"></span>
                </div>
              </div>
            </section>`
        }

        <section class="card">
          <h3 class="action-section-title">Recent runs</h3>
          ${runs.length === 0
            ? `<p class="empty-hint">No runs yet — fill in the filters above and click Run.</p>`
            : `<div class="action-section-body">
                ${runs.map((run) => `
                  <div class="action-row prospecting-run-row">
                    <span class="status-badge ${run.status === "complete" ? "verified" : run.status === "error" ? "not_found" : "unverified"}">${escapeHtml(run.status)}</span>
                    <div style="flex:1;min-width:0">
                      <div class="action-row-title" style="margin-bottom:2px">
                        ${run.name ? `<strong>${escapeHtml(run.name)}</strong> · ` : ""}
                        Scanned <strong>${run.found}</strong>${run.total_available > 0 ? ` <span class="empty-hint">of ${run.total_available.toLocaleString()} in CH</span>` : ""} · Added <strong>${run.created}</strong> · Skipped <strong>${run.skipped}</strong>
                        ${(() => {
                          try {
                            const c = JSON.parse(run.criteria) as Partial<ProspectingCriteria>;
                            if (c.run_ai_enrichment && run.created > 0) {
                              const cost = (run.created * 0.15).toFixed(2);
                              const limit = c.credit_limit_gbp ? ` / £${c.credit_limit_gbp.toFixed(2)} limit` : "";
                              return ` · <span style="color:var(--accent)">£${cost} spent${limit}</span>`;
                            }
                          } catch { /* ignore */ }
                          return "";
                        })()}
                      </div>
                      <div class="p-run-filters">${escapeHtml(buildRunSummary(run))}</div>
                    </div>
                    <span class="empty-hint" style="white-space:nowrap">${escapeHtml(formatDate(run.started_at))}</span>
                    ${run.error ? `<span class="empty-hint" style="color:${run.status === "error" ? "var(--danger)" : "var(--text-muted)"};max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(run.error)}">${escapeHtml(run.error)}</span>` : ""}
                    <button type="button" class="btn btn-ghost btn-sm run-again-btn" data-criteria="${escapeHtml(run.criteria)}">Run again</button>
                  </div>`).join("")}
              </div>`
          }
        </section>
      </main>
    `;

    if (!configured) return;
    bindEvents(container);
  }

  function bindEvents(container: HTMLDivElement): void {
    // Sync slider ↔ number input
    const syncSlider = (id: string, key: keyof FormState) => {
      const slider = container.querySelector<HTMLInputElement>(`#slider-${id}`);
      const num = container.querySelector<HTMLInputElement>(`#num-${id}`);
      if (!slider || !num) return;
      slider.addEventListener("input", () => {
        num.value = slider.value;
        (state as unknown as Record<string, unknown>)[key] = Number(slider.value);
        updateName(container);
      });
      num.addEventListener("input", () => {
        slider.value = num.value;
        (state as unknown as Record<string, unknown>)[key] = Number(num.value);
        updateName(container);
      });
    };
    syncSlider("max-results", "maxResults");
    syncSlider("min-score", "minChScore");
    syncSlider("min-charges", "minCharges");
    syncSlider("max-charges", "maxCharges");

    // Date inputs
    container.querySelector<HTMLInputElement>("#inc-from-input")?.addEventListener("change", (e) => {
      state.incorporatedFrom = (e.target as HTMLInputElement).value;
      updateName(container);
      refreshFiltersStrip(container);
    });
    container.querySelector<HTMLInputElement>("#inc-to-input")?.addEventListener("change", (e) => {
      state.incorporatedTo = (e.target as HTMLInputElement).value;
      updateName(container);
      refreshFiltersStrip(container);
    });
    container.querySelector<HTMLInputElement>("#charge-from-input")?.addEventListener("change", (e) => {
      state.chargeRegisteredFrom = (e.target as HTMLInputElement).value;
      refreshFiltersStrip(container);
    });
    container.querySelector<HTMLInputElement>("#charge-to-input")?.addEventListener("change", (e) => {
      state.chargeRegisteredTo = (e.target as HTMLInputElement).value;
      refreshFiltersStrip(container);
    });

    // Date presets
    container.querySelectorAll<HTMLButtonElement>(".date-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        setDatePreset(btn.dataset.preset ?? "");
        const fromEl = container.querySelector<HTMLInputElement>("#inc-from-input");
        const toEl = container.querySelector<HTMLInputElement>("#inc-to-input");
        if (fromEl) fromEl.value = state.incorporatedFrom;
        if (toEl) toEl.value = state.incorporatedTo;
        updateName(container);
        refreshFiltersStrip(container);
      });
    });

    // Checkboxes
    container.querySelector<HTMLInputElement>("#ai-enrichment-toggle")?.addEventListener("change", (e) => {
      state.runAiEnrichment = (e.target as HTMLInputElement).checked;
      void render(); // re-render to show/hide cost estimate + credit limit field
    });
    container.querySelector<HTMLInputElement>("#credit-limit-input")?.addEventListener("input", (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      state.creditLimitGbp = isNaN(val) ? 0 : val;
    });
    container.querySelector<HTMLInputElement>("#active-charges-toggle")?.addEventListener("change", (e) => {
      state.activeChargesOnly = (e.target as HTMLInputElement).checked;
      refreshFiltersStrip(container);
    });
    container.querySelector<HTMLInputElement>("#new-charges-toggle")?.addEventListener("change", (e) => {
      state.newChargesOnly = (e.target as HTMLInputElement).checked;
      updateName(container);
      refreshFiltersStrip(container);
    });
    container.querySelector<HTMLInputElement>("#include-satisfied-toggle")?.addEventListener("change", (e) => {
      state.includeSatisfied = (e.target as HTMLInputElement).checked;
      refreshFiltersStrip(container);
    });

    // Run name — track manual edits
    container.querySelector<HTMLInputElement>("#run-name-input")?.addEventListener("input", (e) => {
      state.name = (e.target as HTMLInputElement).value;
      state.nameManuallySet = true;
    });

    // Clear all filters
    container.querySelector<HTMLButtonElement>("#clear-all-btn")?.addEventListener("click", () => {
      const prev = { name: state.name, nameManuallySet: state.nameManuallySet };
      state = { ...DEFAULT_STATE, ...prev };
      void render();
    });

    // Filter chip removals
    container.querySelectorAll<HTMLSpanElement>("[data-clear]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const key = chip.dataset.clear!;
        if (key === "sicCodes") state.sicCodes = [];
        else if (key === "locations") state.locations = [];
        else if (key === "dates") { state.incorporatedFrom = ""; state.incorporatedTo = ""; }
        else if (key === "chargeTypes") state.chargeTypes = [];
        else if (key === "activeChargesOnly") state.activeChargesOnly = false;
        else if (key === "newChargesOnly") state.newChargesOnly = false;
        else if (key === "includeSatisfied") state.includeSatisfied = true;
        else if (key === "minCharges") state.minCharges = 0;
        else if (key === "maxCharges") state.maxCharges = 0;
        else if (key === "chargeDates") { state.chargeRegisteredFrom = ""; state.chargeRegisteredTo = ""; }
        updateName(container);
        void render();
      });
    });

    // Run Again
    container.querySelectorAll<HTMLButtonElement>(".run-again-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        try {
          const c = JSON.parse(btn.dataset.criteria ?? "{}") as Partial<ProspectingCriteria>;
          state = {
            name: c.name ?? "",
            nameManuallySet: !!(c.name),
            sicCodes: c.sic_codes ?? [],
            locations: c.locations ?? (c.location ? [c.location] : []),
            incorporatedFrom: c.incorporated_from ?? "",
            incorporatedTo: c.incorporated_to ?? "",
            maxResults: c.max_results ?? 50,
            minChScore: c.min_ch_score ?? 0,
            runAiEnrichment: c.run_ai_enrichment ?? false,
            creditLimitGbp: c.credit_limit_gbp ?? 0,
            chargeTypes: c.charge_types ?? [],
            activeChargesOnly: c.active_charges_only ?? false,
            includeSatisfied: c.include_satisfied ?? true,
            newChargesOnly: c.new_charges_only ?? false,
            chargeRegisteredFrom: c.charge_registered_from ?? "",
            chargeRegisteredTo: c.charge_registered_to ?? "",
            minCharges: c.min_charges ?? 0,
            maxCharges: c.max_charges ?? 0,
          };
          void render();
          container.querySelector("#run-name-input")?.scrollIntoView({ behavior: "smooth", block: "center" });
        } catch { /* ignore */ }
      });
    });

    // Multi-select: SIC
    bindMultiSelect(container, "sic", state.sicCodes, (vals) => {
      state.sicCodes = vals;
      updateName(container);
      refreshFiltersStrip(container);
    });
    // Multi-select: Location
    bindMultiSelect(container, "location", state.locations, (vals) => {
      state.locations = vals;
      updateName(container);
      refreshFiltersStrip(container);
    });
    // Multi-select: Charge types
    bindMultiSelect(container, "charge", state.chargeTypes, (vals) => {
      state.chargeTypes = vals;
      updateName(container);
      refreshFiltersStrip(container);
    });

    // Run button
    container.querySelector<HTMLButtonElement>("#run-prospecting-btn")?.addEventListener("click", async () => {
      const btn = container.querySelector<HTMLButtonElement>("#run-prospecting-btn")!;
      const statusMsg = container.querySelector<HTMLSpanElement>("#run-status-msg")!;

      const nameEl = container.querySelector<HTMLInputElement>("#run-name-input");
      const name = nameEl?.value.trim() ?? "";
      if (!name) {
        statusMsg.textContent = "Please enter a name for this run.";
        statusMsg.style.color = "var(--danger)";
        nameEl?.focus();
        return;
      }
      statusMsg.style.color = "";
      state.name = name;
      state.nameManuallySet = true;

      const criteria: ProspectingCriteria = {
        name: state.name,
        sic_codes: state.sicCodes,
        locations: state.locations,
        location: state.locations[0] ?? "",
        company_type: "ltd",
        incorporated_from: state.incorporatedFrom,
        incorporated_to: state.incorporatedTo,
        max_results: state.maxResults,
        min_ch_score: state.minChScore,
        run_ai_enrichment: state.runAiEnrichment,
        credit_limit_gbp: state.creditLimitGbp,
        charge_types: state.chargeTypes,
        active_charges_only: state.activeChargesOnly,
        include_satisfied: state.includeSatisfied,
        new_charges_only: state.newChargesOnly,
        charge_registered_from: state.chargeRegisteredFrom,
        charge_registered_to: state.chargeRegisteredTo,
        min_charges: state.minCharges,
        max_charges: state.maxCharges,
      };

      btn.disabled = true;
      statusMsg.textContent = "Starting…";
      try {
        const { run_id } = await startProspectingRun(criteria);
        statusMsg.textContent = "Running — checking Companies House…";
        pollRun(run_id, container);
      } catch (err) {
        statusMsg.textContent = `Error: ${err}`;
        btn.disabled = false;
      }
    });
  }

  function bindMultiSelect(
    container: HTMLDivElement,
    id: string,
    selected: string[],
    onChange: (vals: string[]) => void
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

    // Chip removal is handled by rebuildChips() which attaches fresh listeners each time

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
      // Re-render chips in trigger without closing the dropdown or full re-render
      const allOptions = Array.from(dropdown.querySelectorAll<HTMLDivElement>(".p-ms-option"))
        .map(o => ({ value: o.dataset.msVal ?? "", label: o.querySelector("span")?.textContent ?? o.dataset.msVal ?? "" }));
      const existingChips = trigger.querySelectorAll(".p-chip");
      existingChips.forEach(c => c.remove());
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
          void render();
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
        // Don't call render() — keep dropdown open
      });
    });

    dropdown.querySelectorAll<HTMLButtonElement>(".p-ms-group-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const grpName = btn.dataset.msGroup ?? "";
        // Find all options in this group
        const groupOpts = Array.from(dropdown.querySelectorAll<HTMLDivElement>(".p-ms-option")).filter((opt) => {
          // Group options follow the group header; find options until the next group header
          let el: Element | null = opt.previousElementSibling;
          while (el && !el.classList.contains("p-ms-group")) el = el.previousElementSibling;
          return el?.getAttribute("data-ms-group") === grpName;
        });
        const groupVals = groupOpts.map((o) => o.dataset.msVal ?? "");
        const allSelected = groupVals.every((v) => selected.includes(v));
        if (allSelected) {
          // Deselect all in group
          groupVals.forEach((v) => {
            const i = selected.indexOf(v);
            if (i !== -1) selected.splice(i, 1);
          });
          btn.textContent = "Select all";
        } else {
          // Select all in group
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

    // Close on outside click — only then trigger full re-render for filter chips etc.
    document.addEventListener("click", (e) => {
      if (!trigger.closest(`#ms-${id}`)?.contains(e.target as Node)) {
        if (dropdown.style.display !== "none") {
          closeDropdown();
          void render();
        }
      }
    }, { capture: false });
  }

  function updateName(container: HTMLDivElement): void {
    if (state.nameManuallySet) return;
    const nameEl = container.querySelector<HTMLInputElement>("#run-name-input");
    if (!nameEl) return;
    const suggested = autoSuggestName();
    nameEl.value = suggested;
    state.name = suggested;
  }

  function refreshFiltersStrip(container: HTMLDivElement): void {
    const strip = container.querySelector<HTMLDivElement>(".p-filters-strip");
    const html = buildActiveFiltersHtml();
    if (strip) {
      if (html) strip.outerHTML = html;
      else strip.remove();
    } else if (html) {
      const form = container.querySelector<HTMLDivElement>(".prospecting-form");
      if (form) form.insertAdjacentHTML("afterbegin", html);
    }
    // Rebind chip removal after strip update
    container.querySelectorAll<HTMLSpanElement>("[data-clear]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const key = chip.dataset.clear!;
        if (key === "sicCodes") state.sicCodes = [];
        else if (key === "locations") state.locations = [];
        else if (key === "dates") { state.incorporatedFrom = ""; state.incorporatedTo = ""; }
        else if (key === "chargeTypes") state.chargeTypes = [];
        else if (key === "activeChargesOnly") state.activeChargesOnly = false;
        else if (key === "newChargesOnly") state.newChargesOnly = false;
        else if (key === "includeSatisfied") state.includeSatisfied = true;
        else if (key === "minCharges") state.minCharges = 0;
        else if (key === "maxCharges") state.maxCharges = 0;
        else if (key === "chargeDates") { state.chargeRegisteredFrom = ""; state.chargeRegisteredTo = ""; }
        updateName(container);
        void render();
      });
    });
  }

  function _formatRunEta(run: ProspectingRun): string {
    const processed = run.created + run.skipped;
    if (processed < 5 || run.found === 0) return "";
    const startedAt = new Date(run.started_at).getTime();
    const elapsedSecs = (Date.now() - startedAt) / 1000;
    const rate = processed / elapsedSecs;
    const remaining = run.found - processed;
    if (rate <= 0 || remaining <= 0) return "";
    const etaSecs = remaining / rate;
    if (etaSecs < 90) return "< 2 min remaining";
    const mins = Math.round(etaSecs / 60);
    return `~${mins} min remaining`;
  }

  function _formatRunCost(run: ProspectingRun): string {
    try {
      const c = JSON.parse(run.criteria) as Partial<ProspectingCriteria>;
      if (!c.run_ai_enrichment) return "";
      const cost = (run.created * 0.15).toFixed(2);
      return `est. £${cost} credits`;
    } catch {
      return "";
    }
  }

  function pollRun(runId: string, container: HTMLDivElement): void {
    if (pollTimer) clearTimeout(pollTimer);
    async function check() {
      try {
        const run = await getProspectingRun(runId);
        const msg = container.querySelector<HTMLSpanElement>("#run-status-msg");
        if (msg) {
          const total = run.total_available > 0 ? ` of ${run.total_available.toLocaleString()} in CH` : "";
          const parts = [`Running — scanned ${run.found}${total} · added ${run.created} · skipped ${run.skipped}`];
          const eta = _formatRunEta(run);
          const cost = _formatRunCost(run);
          if (eta) parts.push(eta);
          if (cost) parts.push(cost);
          msg.textContent = parts.join(" · ");
        }
        if (run.status === "running") {
          pollTimer = setTimeout(check, 3000);
        } else {
          const btn = container.querySelector<HTMLButtonElement>("#run-prospecting-btn");
          if (btn) btn.disabled = false;
          await render();
        }
      } catch {
        pollTimer = setTimeout(check, 5000);
      }
    }
    pollTimer = setTimeout(check, 2000);
  }

  void render();
}
