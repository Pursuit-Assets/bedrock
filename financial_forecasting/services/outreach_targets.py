"""Hand-edited targets for the Outreach Dashboard scorecard.

The scorecard's "Δ Target" column compares actual volume against a goal per
stage / activity type, per period length. These change rarely enough that a
human editing this dict is simpler than a DB table + CRUD UI — so v1 keeps them
here. If they ever need to be per-owner or editable in-app, promote to a
`bedrock.outreach_target` table; the endpoint reads through these helpers so the
call sites won't change.

Keys match the metric keys the scorecard endpoint emits:
  user pipeline     — flagged | initial_outreach | active | handed_off
  activity pipeline — direct_email_sent | linkedin_message_sent |
                      facilitated_intro_sent | response
Granularity keys match the API's granularity param: day | week | month.
"""

from typing import Optional

# Contacts ENTERING each funnel stage in the period (flow, not occupancy).
USER_PIPELINE_TARGETS: dict[str, dict[str, int]] = {
    "flagged":          {"day": 76, "week": 380, "month": 1645},  # Lead Sourced
    "initial_outreach": {"day": 72, "week": 360, "month": 1559},  # Outreached
    "active":           {"day": 5,  "week": 25,  "month": 108},   # Qualified Lead
    "handed_off":       {"day": 2,  "week": 10,  "month": 43},    # Committed
}

# Raw activity rows sent/received in the period.
ACTIVITY_PIPELINE_TARGETS: dict[str, dict[str, int]] = {
    "direct_email_sent":      {"day": 40, "week": 200, "month": 866},
    "linkedin_message_sent":  {"day": 18, "week": 90,  "month": 390},
    "facilitated_intro_sent": {"day": 8,  "week": 40,  "month": 173},
    "response":               {"day": 14, "week": 70,  "month": 303},
}


def user_pipeline_target(stage: str, granularity: str) -> Optional[int]:
    """Target for a user-pipeline stage at a granularity, or None if unset."""
    return USER_PIPELINE_TARGETS.get(stage, {}).get(granularity)


def activity_pipeline_target(metric: str, granularity: str) -> Optional[int]:
    """Target for an activity-pipeline metric at a granularity, or None if unset."""
    return ACTIVITY_PIPELINE_TARGETS.get(metric, {}).get(granularity)
