import sqlite3

# Pure read-side aggregation across already-existing tables — no new table,
# no side effects. "Lead status changes" only ever shows the *current*
# status as one entry — there's no change-history log anywhere in this app
# today, and building one is out of scope here.


def build_timeline(
    lead: sqlite3.Row,
    phones: list[sqlite3.Row],
    emails: list[sqlite3.Row],
    drafts: list[sqlite3.Row],
    intelligence_versions: list[sqlite3.Row],
    calendar_events: list[sqlite3.Row],
) -> list[dict]:
    entries: list[dict] = []

    if lead["lead_notes"]:
        entries.append({"timestamp": lead["updated_at"], "type": "note", "summary": f"Notes: {lead['lead_notes'][:140]}"})

    for p in phones:
        entries.append({"timestamp": p["created_at"], "type": "phone", "summary": f"Added phone {p['phone_number']}"})

    for e in emails:
        entries.append({"timestamp": e["created_at"], "type": "email_contact", "summary": f"Added email {e['email']}"})

    for d in drafts:
        verb = "Sent" if d["status"] == "sent" else "Drafted"
        entries.append(
            {"timestamp": d["sent_at"] or d["created_at"], "type": "email_draft", "summary": f"{verb} email: {d['subject']}"}
        )

    for v in intelligence_versions:
        entries.append(
            {
                "timestamp": v["created_at"],
                "type": "intelligence",
                "summary": f"AI Intelligence generated ({v['lead_temperature']}, {v['lead_score']}/100)",
            }
        )

    entries.append({"timestamp": lead["updated_at"], "type": "status", "summary": f"Status: {lead['contact_status']}"})

    for ev in calendar_events:
        entries.append(
            {
                "timestamp": f"{ev['date']}T{ev['time'] or '00:00'}",
                "type": "calendar",
                "summary": f"Upcoming: {ev['title']} ({ev['type']})",
            }
        )

    entries.sort(key=lambda e: e["timestamp"], reverse=True)
    return entries


def recent_activity_summary(timeline: list[dict]) -> str:
    return timeline[0]["summary"] if timeline else ""
