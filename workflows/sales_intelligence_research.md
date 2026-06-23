# Workflow: AI Sales Intelligence Research

## Objective
Given a company name (and optionally its website), research the company and produce a persistent, sales-focused intelligence dossier: an executive summary, a sales-angle interpretation, pain points, buying signals, conversation starters, discovery questions, objection handling, a recommended pitch angle, a 60-second call brief, and a rubric-scored 0-100 lead score with a Hot/Warm/Cold classification. This is a separate workflow from phone-number lookup and email discovery — run independently, never as a side effect of either.

## Required Input
- Company name (string)
- Company website, if already known (string, may be blank)

## Tools Used
- `web_search` — find the company's official sources and any public LinkedIn presence
- `web_fetch` — open and read pages from the official website

## Process

Work through these source categories in order. Don't stop at the first dead end — only treat a category as "no data" after genuinely exhausting it.

1. **Company sources**: homepage, About page, Services/Products pages, Careers page, Blog/News pages.
2. **External signals**: LinkedIn company page and recent posts, hiring activity, public announcements (press releases, funding news, product launches).
3. **Contextual signals**: industry type, company size indicators (employee count signals, office locations), growth-stage signals (funding rounds, expansion, new hires in leadership).

**LinkedIn caveat**: `web_fetch` against linkedin.com is frequently blocked by LinkedIn itself. When that happens, rely on whatever `web_search` surfaces (snippets, cached text) instead of fabricating content, and say so plainly in the Data Quality block (see Output below) rather than presenting unverified information as fact.

**Tool-use de-duplication (cost control)**: maintain a mental visited-URL set as you go. Never re-fetch the same domain path twice. Prefer visiting more distinct pages (breadth) over repeatedly re-opening ones you've already read. Do not re-open a previously visited URL unless you are specifically extracting new, different section-specific data from it that you didn't capture the first time.

## Output

Produce all of the following:

1. **Executive Summary** — what the company does, who they serve, industry positioning, business model overview.
2. **Sales Summary** — what they're likely trying to achieve, what problems they face, what's blocking growth, why they'd buy a service like ours.
3. **Pain Points** — split into three groups: operational, sales/revenue, recruitment/scaling — each derived from concrete signals (site language, hiring patterns, LinkedIn activity, industry context), not generic guesses.
4. **Buying Signals** — hiring spikes, expansion activity, funding/growth indicators, new product/service launches, sales hiring, market expansion. Only list signals you actually found evidence for.
5. **Conversation Starters** — personalised hooks: recent company references, LinkedIn post references (if available), industry-relevant angles.
6. **Discovery Questions** — exactly 10 to 15 tailored questions for a sales call, covering qualification, pain discovery, budget/authority/need, and timing.
7. **Objection Handling** — predicted objections with responses, each tagged with a category: `price`, `timing`, `competitor`, `internal_solution`, or `other`. Cover at least price, timing, competitor, and internal-solution objections if at all plausible for this company.
8. **Recommended Pitch Angle** — the best way to position the service, what problem to lead with, what angle will likely resonate most.
9. **Call Brief** — a compact summary combining company overview, key pain points, recommended opener, top questions, likely objections, and best pitch angle. Must be readable in under 60 seconds — keep it tight, not a repeat of every section above.
10. **AI Lead Score (deterministic rubric — mandatory)**: score five categories, each 0-20, then sum them for the final 0-100 score. Do not pick a final score first and back-fill the categories — compute bottom-up.
    - **Company size & maturity** (0-20): startup ≈ low, established enterprise ≈ high.
    - **Hiring intensity** (0-20): active hiring ≈ higher, no hiring activity ≈ low.
    - **Growth signals** (0-20): funding, expansion, product launches.
    - **Buying intent signals** (0-20): outsourcing mentions, visible tool-stack gaps, inefficiencies that suggest a need.
    - **Accessibility / fit** (0-20): clear contact channels, SMB-vs-enterprise fit, geography fit.
    - `lead_score` MUST equal the exact sum of the five category scores.
    - Classification is mechanical, not a separate judgment call: 80-100 = **Hot**, 50-79 = **Warm**, 0-49 = **Cold**.
11. **Confidence note with a Data Quality block** — the confidence note MUST include this structure, filled in honestly:
    ```
    Data Quality:
    - Sources accessed: <list what you actually read>
    - Missing data: <list what you couldn't get, e.g. "LinkedIn not fetchable">
    - Reliability: High / Medium / Low
    ```

## Edge Cases
- **Ambiguous company name** (multiple distinct companies share it): state the ambiguity in the confidence note and proceed with the most likely match rather than blending data from multiple companies.
- **Very little public information available**: still produce all sections, but keep them honest and short, mark Reliability as Low, and let the score reflect genuine uncertainty (lower accessibility/buying-intent sub-scores rather than guessing high).
- **LinkedIn entirely inaccessible**: proceed using only the other sources; explicitly note LinkedIn as missing data rather than omitting it silently.
