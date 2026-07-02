const SIC_DESCRIPTIONS: Record<string, string> = {
  "01": "Agriculture & Forestry", "02": "Forestry & Logging", "03": "Fishing & Aquaculture",
  "05": "Mining", "06": "Oil & Gas Extraction", "07": "Metal Ore Mining",
  "08": "Quarrying", "09": "Mining Support",
  "10": "Food Manufacturing", "11": "Beverages", "12": "Tobacco",
  "13": "Textiles", "14": "Clothing", "15": "Leather",
  "16": "Wood & Timber", "17": "Paper", "18": "Printing",
  "19": "Petroleum Refining", "20": "Chemicals", "21": "Pharmaceuticals",
  "22": "Rubber & Plastics", "23": "Construction Materials", "24": "Metals",
  "25": "Fabricated Metals", "26": "Electronics", "27": "Electrical Equipment",
  "28": "Machinery", "29": "Motor Vehicles", "30": "Transport Equipment",
  "31": "Furniture", "32": "Other Manufacturing", "33": "Repair & Installation",
  "35": "Energy & Utilities", "36": "Water Supply", "37": "Sewage",
  "38": "Waste Management", "39": "Remediation",
  "41": "Construction of Buildings", "42": "Civil Engineering", "43": "Specialist Construction",
  "45": "Vehicle Trade", "46": "Wholesale Trade", "47": "Retail",
  "49": "Land Transport", "50": "Water Transport", "51": "Air Transport",
  "52": "Warehousing & Storage", "53": "Postal & Courier",
  "55": "Hotels & Accommodation", "56": "Food & Beverage Service",
  "58": "Publishing", "59": "Film & TV", "60": "Broadcasting",
  "61": "Telecommunications", "62": "IT & Software", "63": "Information Services",
  "64": "Financial Services", "65": "Insurance", "66": "Financial Auxiliaries",
  "68": "Real Estate",
  "69": "Legal & Accounting", "70": "Management Consulting",
  "71": "Architecture & Engineering", "72": "Research & Development",
  "73": "Advertising & Marketing", "74": "Other Professional Services", "75": "Veterinary",
  "77": "Equipment Rental", "78": "Employment Services", "79": "Travel Agencies",
  "80": "Security Services", "81": "Facilities Management", "82": "Office Admin",
  "84": "Public Administration", "85": "Education",
  "86": "Healthcare", "87": "Residential Care", "88": "Social Work",
  "90": "Arts & Entertainment", "91": "Libraries & Museums",
  "92": "Gambling", "93": "Sports & Recreation",
  "94": "Membership Organisations", "95": "Computer Repair",
  "96": "Personal Services", "97": "Household Services",
};

/** Converts a raw SIC code (e.g. "4929") to a readable name. Pass-through for anything already named. */
export function normalizeSicIndustry(value: string): string {
  if (!value) return value;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return trimmed; // already a name
  return SIC_DESCRIPTIONS[trimmed.slice(0, 2)] ?? trimmed;
}
