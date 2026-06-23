# Workflow: Find Company Email Address

## Objective
Given a company name, find and verify one or more of that company's published email addresses. This is a separate workflow from phone-number lookup — run independently, never as a side effect of a phone lookup.

## Required Input
- Company name (string)

## Tools Used
- `web_search` — find the company's official website
- `web_fetch` — open and read pages from the official website

## Process
Work through these steps in order. Don't stop at the first dead end — only conclude "not found" after exhausting all of them.

1. **Search**: identify the company's official website. Confirm it's the right company before proceeding (check branding, industry, address — beware similarly named but unrelated businesses).
2. **Homepage**: check the homepage, including the footer.
3. **Contact page**: check `/contact`, `/contact-us`.
4. **About page**: check `/about`, `/about-us`.
5. **Footer**: re-check the footer of any page fetched — emails are often placed there even when missing from the contact page.
6. **Other verified company sources**: only if nothing found above, check other pages clearly belonging to the verified company (e.g. a press/media page).
7. **Verify**: before reporting any address, confirm the source page actually belongs to the target company — match name, branding, and domain. Don't report an address from an unconfirmed or unrelated source.
8. **Prefer general company addresses over personal ones**: prioritize in this order — `info@`, `hello@`, `contact@`, `sales@`, then any other address ending in the company's own domain. Only report a personal-looking address (e.g. `firstname.lastname@...`) if no general company address exists anywhere on the site.
9. Multiple addresses may be reported if more than one general address is found (e.g. both `info@` and `sales@`).

## Output
Return:
- The email address(es) found (a list — may be empty)
- A one-line confidence note (e.g. "found on official Contact page" vs. "only a personal address was available")

## Edge Cases
- **Ambiguous name** (multiple distinct companies share it): do not guess — report not found rather than risk attributing the wrong company's email.
- **Nothing found** after exhausting all steps: return an empty list with a confidence note explaining what was checked.
- **Found but unverifiable** against the company's confirmed identity: omit it rather than report an unconfirmed address.
