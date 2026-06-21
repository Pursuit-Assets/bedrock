"""Evals for jobs activity classification + the opportunities funnel shape."""
import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def test_jobs_activity_flag_tags_team_mailboxes():
    from routes.jobs import _jobs_activity_flag, JOBS_TEAM_EMAILS
    flag = _jobs_activity_flag("a")
    # tied-to-opp + manual channels + each team mailbox (both from + logged_by)
    assert "a.jobs_opportunity_id IS NOT NULL" in flag
    assert "a.source = 'manual'" in flag
    assert "a.type IN ('call','text','linkedin')" in flag
    for e in JOBS_TEAM_EMAILS:
        assert f"a.email_from ILIKE '%{e}%'" in flag
        assert f"a.logged_by ILIKE '%{e}%'" in flag


def test_jobs_activity_flag_respects_alias():
    from routes.jobs import _jobs_activity_flag
    assert "x.jobs_opportunity_id" in _jobs_activity_flag("x")


OPP_FUNNEL = "account_name AS name"
HIST = "jobs_stage_history h"


def test_funnel_opportunities_starts_with_initial_outreach():
    conn = FakeConn(lists={
        OPP_FUNNEL: [
            {"stage": "initial_outreach", "name": "Acme", "deal_type": "ft", "owner": "a@p.org"},
            {"stage": "active_in_discussions", "name": "Beta", "deal_type": "ft", "owner": "a@p.org"},
        ],
        HIST: [],
    })
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/funnel/opportunities")
    assert r.status_code == 200, r.text
    stages = r.json()["data"]["stages"]
    assert stages[0]["key"] == "initial_outreach" and stages[0]["label"] == "Initial Outreach"
    assert stages[0]["count"] == 1
    # full ordered pipeline present
    assert [s["key"] for s in stages] == [
        "initial_outreach", "active_in_discussions", "active_opportunity_confirmed",
        "active_builder_interview", "closed_won"]


def test_funnel_unknown_type_404():
    c = make_jobs_client(FakeConn())
    r = c.get("/api/jobs/funnel/widgets")
    assert r.status_code == 404


# ── activity-trends ─────────────────────────────────────────────────────────────

from datetime import datetime, timezone  # noqa: E402

BASE = datetime(2026, 6, 15, tzinfo=timezone.utc)


def test_activity_trends_buckets_volume_and_activation():
    conn = FakeConn(
        lists={
            "GROUP BY 1, 2": [{"bucket": BASE, "channel": "email", "n": 10},
                              {"bucket": BASE, "channel": "meeting", "n": 4}],
            "first_account AS": [{"kind": "contact", "bucket": BASE, "n": 5},
                                 {"kind": "account", "bucket": BASE, "n": 3}],
        },
        vals={"date_trunc": BASE, "damon.kornhauser": 50},
    )
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/activity-trends?granularity=week")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert len(d["buckets"]) == 12                     # trailing 12, zero-filled
    last = d["buckets"][-1]
    assert last["period"] == "2026-06-15"
    assert last["email"] == 10 and last["meeting"] == 4
    assert last["new_contacts"] == 5 and last["new_accounts"] == 3
    # earlier buckets zero-filled
    assert d["buckets"][0]["email"] == 0 and d["buckets"][0]["new_contacts"] == 0
    assert d["totals"]["touchpoints"] == 14
    assert d["coverage_note"] is not None              # damon=50 < 200 → flagged


def test_activity_trends_no_coverage_note_when_damon_synced():
    conn = FakeConn(lists={"GROUP BY 1, 2": [], "first_account AS": []},
                    vals={"date_trunc": BASE, "damon.kornhauser": 500})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/activity-trends?granularity=week")
    assert r.status_code == 200, r.text
    assert r.json()["data"]["coverage_note"] is None   # damon=500 ≥ 200


def test_activity_trends_monthly_has_12_buckets():
    conn = FakeConn(lists={"GROUP BY 1, 2": [], "first_account AS": []},
                    vals={"date_trunc": BASE, "damon.kornhauser": 50})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/activity-trends?granularity=month")
    assert r.status_code == 200, r.text
    assert len(r.json()["data"]["buckets"]) == 12


def test_activity_trends_bad_granularity_422():
    c = make_jobs_client(FakeConn())
    r = c.get("/api/jobs/activity-trends?granularity=daily")
    assert r.status_code == 422
