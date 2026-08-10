# Win-back Campaign UI Process

## Purpose

This is the page-by-page CRM workflow for creating, reviewing, generating and sending a Win-back email campaign. It describes the user journey only; it does not define the AI email-writing prompt.

## Flow

Win-back Campaigns → New campaign → Choose source → Upload CSV → Review imported leads → Configure generation → Preview one email or Generate campaign → Campaign detail → Preview, Send, Export or Resume.

## 1. Campaign list

Show existing campaigns with:

- Campaign name
- Number of leads
- Number of emails generated
- Status
- Creation date

Provide a **New campaign** button and a **View** action for each campaign.

## 2. Choose source

The user starts a new campaign and selects a lead source.

Current source:

- Upload CSV

Future source:

- Import from CRM

## 3. Review imported leads

Parse the uploaded CSV, remove rows without an email address, and show the remaining records before any paid generation starts.

Show:

- Company
- Contact
- Email
- Phone
- Website
- LinkedIn

Provide a **Configure generation** button.

## 4. Configure generation

Keep the imported lead/CRM data unchanged. The following settings apply only to the campaign brief.

Inputs:

- Campaign name
- Campaign brief / email direction
- Current offers or deals
- Campaign links, such as a booking link or reapplication link
- Optional link display text
- Research depth: Quick, Standard or Deep

The email signature is taken automatically from **Settings → Brand Voice**.

Show a cautious estimate for AI research/email generation and any LinkedIn/Apify usage.

Actions:

- **Preview one email**
- **Generate Campaign**

## 5. Preview one email

The user selects one imported lead. Preview runs the same enrichment and email-generation path as the final campaign for that lead.

The preview:

- Shows the draft subject and body
- Does not create a campaign
- Does not save or send an email
- Uses the same research and AI usage as one final campaign lead

## 6. Generate campaign

After cost confirmation, create the campaign and generate drafts for every lead.

For each lead, the system:

1. Reuses fresh existing research, or runs enrichment if it is missing/stale.
2. Combines the enriched lead context with the campaign brief and links.
3. Generates a draft email.
4. Adds the Brand Voice signature.
5. Saves the draft to the campaign.

## 7. Campaign detail

Show:

- Generated count and total count
- Progress bar while generation is active
- Campaign brief and offer context
- A table of generated drafts

For each draft provide:

- Preview
- Send via the connected email account

For the whole campaign provide:

- Send all via Gmail
- Export to Mailchimp
- Resume remaining leads if generation stopped early

## Safety rules

- Do not generate or send until the user explicitly confirms.
- Do not send a campaign outside its selected/imported audience.
- Keep draft review available before sending.
- Preserve imported lead and CRM data; campaign configuration must not overwrite it.
- Stop at configured usage limits and allow safe resume.
