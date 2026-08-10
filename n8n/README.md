# Lead Auto-Qualify & Reply (n8n)

A 24/7 n8n workflow: watches a Gmail label for inbound lead emails, asks Claude
to qualify each one against your criteria, and (draft-first) writes a reply into
the same thread for you to approve. Flip one node to go fully automatic later.

**File to import:** `lead-autoresponder.json`

```
Gmail Trigger ──▶ Prepare & Build Prompt ──▶ Qualify with Claude ──▶ Parse Claude Reply ──▶ Qualified?
                  (your criteria + prompt)     (Anthropic API)                                 ├─ yes ─▶ Create Draft Reply
                                                                                               └─ no  ─▶ Skip
```

Only the **Qualify with Claude** step is AI. Everything else (fetch, dedup,
threading, branching) is deterministic n8n plumbing — the WAT split.

---

## 1. Import

n8n → **Workflows** → **Import from File** → pick `lead-autoresponder.json`.
(Or open the workflow, top-right **⋯** → *Import from File*.) It imports
**inactive** on purpose.

## 2. Create the two credentials

The imported nodes show their credential slots as empty — fill both:

- **Gmail** (used by *Gmail Trigger* and *Create Draft Reply*)
  Create a **Gmail OAuth2** credential and connect your Google account.
- **Anthropic API key** (used by *Qualify with Claude*)
  Create a **Header Auth** credential:
  - **Name:** `x-api-key`
  - **Value:** your Anthropic API key (`sk-ant-...`)
  (Anthropic authenticates via the `x-api-key` header, not Bearer — that's why
  it's Header Auth, not a Bearer token.)

## 3. Set up the "Leads" label so it only fires on real leads

The trigger watches `label:Leads` so Claude never runs on your whole inbox.
In Gmail: create a label **Leads**, then **Settings → Filters → Create filter**
that matches your inbound-lead emails (e.g. `to:sales@…`, or from your contact
form) and **applies the label "Leads"**. Adjust the query in the *Gmail Trigger*
node if you name the label differently.

## 4. Put in YOUR criteria + reply prompt

Open the **Prepare & Build Prompt** node. Everything you edit is at the top in
`SYSTEM_PROMPT` — replace the `<YOUR COMPANY>`, `<DESCRIBE YOUR OFFER>`,
`<YOUR CALL TO ACTION>`, `<YOUR NAME>` placeholders and tune the qualify /
disqualify rules. Nothing else in the workflow needs editing.

## 5. Test before going live

Send yourself a test email, apply the **Leads** label, then hit **Execute
Workflow** once. Confirm a sensible draft lands in the thread. Check the
*Parse Claude Reply* output shows `qualified` + `reason` as expected.

## 6. Activate (draft-first)

Toggle the workflow **Active**. It now polls every minute and drops approve-ready
drafts into Gmail. Approve the first ~20 to build trust.

## 7. Going fully automatic (later)

When you trust it, change **Create Draft Reply** from creating a draft to sending:
set the Gmail node's **Resource → Message**, **Operation → Reply**, keep
`Message = {{ $json.reply }}`, and pass `threadId` + `messageId` so it threads.
Keep a copy of the draft version until you're sure.

---

## Gotchas (hard-won)

- **7-day token death (regular @gmail accounts):** if your Google Cloud OAuth
  app is left in **Testing** mode, the refresh token expires every 7 days and
  the trigger silently stops. Publish the OAuth app to **Production** in the
  Google Cloud console. (Google Workspace domains are exempt.)
- **Dedup is automatic** via the Gmail Trigger's poll cursor — it only emits
  messages it hasn't seen. Don't add a second trigger or you'll double-reply.
- **Auto-replies/spam:** the disqualify rules in `SYSTEM_PROMPT` are your guard
  against replying to out-of-office / newsletters. Keep them strict.
- **Model:** the HTTP node uses `claude-sonnet-5`. Change it in the
  *Qualify with Claude* node's JSON body if you want a different model.
- **Cost control:** the body is capped at 6000 chars in *Prepare & Build Prompt*
  to keep token use predictable on long threads.
