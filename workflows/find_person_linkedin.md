# Workflow: Find Person's LinkedIn Profile

## Objective
Given a person's name, their employer, and (optionally) the employer's website, find that specific person's genuine LinkedIn profile URL. This is a last-resort fallback — used only after a direct website scrape has already failed to find any LinkedIn link on the company's own site — so accuracy matters more than coverage.

## Required Input
- Person's full name (string)
- Company name (string)
- Company website, if known (string, may be blank)

## Tools Used
- `web_search` — find candidate LinkedIn profile pages
- `web_fetch` — confirm a candidate profile actually matches this person and company before returning it

## Process

1. Search for the person's name together with the company name (e.g. `"<name>" "<company>" linkedin`).
2. If multiple people share the name, use the company name, job title signals, and location to disambiguate. Never guess between two plausible candidates — if genuinely ambiguous, return no result rather than picking one.
3. Before returning a URL, confirm — from the search snippet or a fetch — that the profile's current or recent employer matches the company in question. A same-named person at a different company is not a match.
4. Only ever return a `linkedin.com/in/...` personal profile URL, never a company page (a separate process handles company pages).

## Output

State clearly:
- The person's LinkedIn profile URL if a confident match was found, or explicitly "not found" if not.
- A one-line confidence note explaining why (e.g. "matched via current job title and company name in search snippet" or "no confident match — multiple people share this name").

## Edge Cases
- **Common name, no disambiguating signal**: return not found rather than guessing.
- **Person has left the company recently**: still an acceptable match if the profile clearly shows recent tenure at this company — note this in the confidence note.
- **No search results at all**: return not found immediately; do not fabricate a plausible-looking URL.
