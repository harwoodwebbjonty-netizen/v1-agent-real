"""Role permission catalogue (RBAC).

The single source of truth for what a role can be granted. The Roles editor in
the app renders this catalogue; the backend enforces it. Admin is a built-in
super-role that always holds every permission.
"""

# Grouped for the UI; each item is a stable permission key + a human label.
PERMISSION_CATALOGUE = [
    {
        "group": "Sections",
        "items": [
            {"key": "view_today", "label": "Today / Action Centre"},
            {"key": "view_activity_feed", "label": "Activity Feed"},
            {"key": "view_leads", "label": "Leads"},
            {"key": "view_cold_call_lists", "label": "Cold Call Lists"},
            {"key": "view_outreach", "label": "Outreach (email / sequences)"},
            {"key": "view_calendar", "label": "Calendar"},
            {"key": "view_analytics", "label": "Analytics"},
            {"key": "view_prospecting", "label": "AI Prospecting"},
            {"key": "view_win_back", "label": "Win-back"},
            {"key": "view_settings", "label": "Settings"},
            {"key": "view_scorecard", "label": "Weekly Scorecard"},
            {"key": "view_scorecard_manager", "label": "Scorecard: Manager view"},
        ],
    },
    {
        "group": "Actions",
        "items": [
            {"key": "send_email", "label": "Send email"},
            {"key": "start_prospecting", "label": "Start AI prospecting"},
            {"key": "run_win_back", "label": "Run win-back campaigns"},
            {"key": "dedup_merge", "label": "Dedup / merge leads"},
            {"key": "run_enrichment", "label": "Run enrichment"},
            {"key": "export_data", "label": "Export (Mailchimp / CSV)"},
            {"key": "manage_team", "label": "Manage team members"},
            {"key": "manage_roles", "label": "Manage roles"},
            {"key": "change_credit_limits", "label": "Change credit limits"},
            {"key": "view_audit_log", "label": "View audit log"},
        ],
    },
]

ALL_PERMISSIONS = [item["key"] for grp in PERMISSION_CATALOGUE for item in grp["items"]]

# What today's non-admin "member" can do — used to seed the built-in Member role
# so existing members' access is unchanged on upgrade.
MEMBER_PERMISSIONS = [
    "view_today",
    "view_activity_feed",
    "view_leads",
    "view_cold_call_lists",
    "view_outreach",
    "view_calendar",
    "view_analytics",
    "send_email",
    "view_scorecard",
]

LEAD_SCOPES = ("all_shared", "own_assigned")
DEFAULT_LEAD_SCOPE = "all_shared"


def valid_permissions(perms) -> list[str]:
    """Filter an incoming permission list down to known keys (drops unknowns)."""
    allowed = set(ALL_PERMISSIONS)
    return [p for p in perms if p in allowed]
