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
