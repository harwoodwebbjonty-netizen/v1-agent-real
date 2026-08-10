# Workflow: Generate & Post LinkedIn Content

## Objective
Given a topic or rough notes, draft a LinkedIn post, get sign-off, and publish it — without leaving this chat.

## One-time setup (before first use)
1. Create a LinkedIn Developer App at https://www.linkedin.com/developers/apps. It must be linked to a LinkedIn Page you administer — create a minimal placeholder Page first if you don't have one.
2. On the app's "Products" tab, request "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" (both self-serve, no partner approval needed).
3. On the app's "Auth" tab, add this exact redirect URL: `http://localhost:8765/callback`. Copy the Client ID and Client Secret.
4. Add to `.env`:
   ```
   LINKEDIN_CLIENT_ID=...
   LINKEDIN_CLIENT_SECRET=...
   ```
5. Run `python3 tools/linkedin_oauth_setup.py`. It opens a browser, you approve access once, and it saves `LINKEDIN_ACCESS_TOKEN` + `LINKEDIN_PERSON_URN` to `.env`.
   - The token expires after ~60 days (LinkedIn doesn't grant refresh tokens on the default app tier). Rerun this script whenever posting starts failing with a 401.

## Required Input
- A topic, rough notes, or a link the post should be about
- Optional: tone/angle, if there's a preference (default to concise, first-person, no corporate fluff)

## Tools Used
- `tools/post_to_linkedin.py` — publishes the final text via LinkedIn's official Posts API

## Process
1. Draft the post directly in this conversation — no separate generation call needed. Keep it LinkedIn-native: a strong first line (it's what shows before "see more"), short paragraphs, no walls of text, generally under ~1,300 characters unless the topic genuinely needs more (LinkedIn's hard limit is ~3,000).
2. Show the full draft to the user and wait for explicit approval ("post it", "yes", or requested edits) before publishing. This step is not skippable — a LinkedIn post is public and effectively irreversible once live.
3. Once approved, publish it:
   ```
   python3 tools/post_to_linkedin.py --text "<final text>"
   ```
4. Confirm back to the user with the returned post URN and note that it's live.

## Edge Cases
- **401 / token expired**: tell the user to rerun `tools/linkedin_oauth_setup.py`, then retry the post.
- **User wants changes after seeing the draft**: revise and re-show — never call the tool speculatively before approval.
- **Text exceeds LinkedIn's ~3,000 character limit**: trim it and flag that it was shortened.
- **API version rejected**: `tools/post_to_linkedin.py` has `API_VERSION` hardcoded near the top — bump it to a more recent `YYYYMM` if LinkedIn returns a version error.

## Notes
- Replying to comments is intentionally out of scope: LinkedIn has no public API for reading or replying to comments on a personal profile's posts (that access is gated to approved partners). Automating it would require browser automation against your logged-in session, which violates LinkedIn's ToS and risks account restriction.
