"""One-shot reconciliation: backfill Probability from Manager_Probability_Override__c.

Salesforce has a flow that copies Manager_Probability_Override__c -> Probability
on SF-UI edits. Bedrock did NOT mirror that for a while, so existing records
where users edited the override via Bedrock have drifted: override carries the
manager's intent, Probability still holds the SF stage default. The backend's
forecasting engine reads bare Probability, so projections silently diverge from
what the UI shows.

This script finds every open opp where override != Probability and (with
--apply) writes Probability = override so the two agree going forward. Closed
opps are skipped — their probabilities are 0 / 100 and historical, no point.

Run from financial_forecasting/:
    python scripts/reconcile_probability_overrides.py            # dry run
    python scripts/reconcile_probability_overrides.py --apply    # write to SF
"""

import argparse
import os
import sys

from dotenv import load_dotenv
from simple_salesforce import Salesforce, SalesforceLogin


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually patch Probability in Salesforce. Default is dry-run.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=2000,
        help="Max opps to scan (default 2000).",
    )
    args = parser.parse_args()

    load_dotenv()
    sid, host = SalesforceLogin(
        username=os.environ["SALESFORCE_USERNAME"],
        password=os.environ["SALESFORCE_PASSWORD"],
        domain=os.environ.get("SALESFORCE_DOMAIN", "login"),
    )
    sf = Salesforce(session_id=sid, instance=host)

    soql = f"""
        SELECT Id, Name, Account.Name, StageName, Probability,
               Manager_Probability_Override__c, Amount, Owner.Name
          FROM Opportunity
         WHERE Manager_Probability_Override__c != null
           AND IsClosed = false
         ORDER BY Amount DESC NULLS LAST
         LIMIT {args.limit}
    """
    rows = sf.query(soql)["records"]

    drift = []
    for r in rows:
        override = r.get("Manager_Probability_Override__c")
        prob = r.get("Probability")
        if override is None:
            continue
        # Compare as floats; SF returns numeric for both.
        if float(override) != float(prob or 0):
            drift.append(r)

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] scanned {len(rows)} open opps with override set")
    print(f"[{mode}] {len(drift)} have Probability != override")
    print()
    if not drift:
        return 0

    print(
        f"  {'amount':>12}  {'SF':>5}  {'mgr':>5}  {'stage':<18}  {'owner':<22}  name (account)"
    )
    print("  " + "-" * 110)
    for r in drift:
        amt = r.get("Amount") or 0
        sf_p = r.get("Probability") or 0
        mgr = r.get("Manager_Probability_Override__c") or 0
        stage = (r.get("StageName") or "")[:18]
        owner = ((r.get("Owner") or {}).get("Name") or "")[:22]
        name = (r.get("Name") or "")[:50]
        acct = ((r.get("Account") or {}).get("Name") or "")[:30]
        print(
            f"  ${amt:>10,.0f}  {sf_p:>4.0f}%  {mgr:>4.0f}%  {stage:<18}  {owner:<22}  {name} ({acct})"
        )

    if not args.apply:
        print()
        print(f"DRY-RUN — no records modified. Re-run with --apply to patch SF.")
        return 0

    print()
    print(f"Applying {len(drift)} updates...")
    ok = 0
    failed = []
    for r in drift:
        opp_id = r["Id"]
        target = r["Manager_Probability_Override__c"]
        try:
            sf.Opportunity.update(opp_id, {"Probability": target})
            ok += 1
            print(f"  OK   {opp_id}  Probability -> {target}")
        except Exception as e:  # noqa: BLE001
            failed.append((opp_id, str(e)))
            print(f"  FAIL {opp_id}  {e}")

    print()
    print(f"Done: {ok} updated, {len(failed)} failed.")
    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(main())
