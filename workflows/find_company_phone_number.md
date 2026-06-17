# Workflow: Find Company Phone Number

## Objective
Given a company name, find and verify that company's primary business phone number.

## Required Input
- Company name (string)
- Optional: city/location or industry, if needed to disambiguate from similarly named companies

## Tools Used
- `WebSearch` (native) — find the company's official website and social/business profiles
- `WebFetch` (native) — open and read pages from the official website and social profiles
- `tools/log_phone_lookup.py` — append the result to `data/phone_lookups.csv`

## Process
Work through these steps in order. Don't stop at the first dead end — only conclude "not found" after exhausting all of them.

1. **Search**: `WebSearch` for the company name to identify its official website. Confirm it's the right company before proceeding (check branding, industry, address — beware similarly named but unrelated businesses).
2. **Homepage**: `WebFetch` the official homepage. Check the footer first — that's the most common place for a main phone number.
3. **Subpages**: If not found on the homepage, `WebFetch` likely subpages: `/contact`, `/contact-us`, `/about`, `/locations`, `/support`.
4. **Social/business profiles**: If still not found, check the company's LinkedIn page, Facebook page, and Google Business Profile / Google Maps listing for a published phone number.
5. **Verify**: Before reporting any number, confirm the source page actually belongs to the target company — match name, address, branding, and domain. Don't report a number from an unconfirmed or unrelated source.
6. **Pick the right number**: If multiple numbers appear (sales, support, HQ, regional offices), prefer the one labeled "main," "general," or "headquarters," or the one shown most prominently in the footer/contact page. Mention alternates only if relevant to the user's question.

## Output
1. Reply to the user in chat with:
   - The phone number
   - The source URL it was found on
   - A one-line confidence note (e.g. "found on official Contact page" vs. "found via Google Business Profile, not independently confirmed on company site")
2. Log the result by running:
   ```
   python tools/log_phone_lookup.py --company "<name>" --phone "<number or 'not_found'>" --source "<url or 'n/a'>" --status <verified|unverified|not_found> --notes "<optional>"
   ```

## Edge Cases
- **Ambiguous name** (multiple distinct companies share it): ask the user for a disambiguating detail (city, industry) rather than guessing.
- **Nothing found** after exhausting steps 1–4: report clearly that no number could be verified, briefly note what was checked, and log with `--status not_found`.
- **Found but unverifiable** against the company's confirmed identity: report the number but flag it as unconfirmed, and log with `--status unverified`.
