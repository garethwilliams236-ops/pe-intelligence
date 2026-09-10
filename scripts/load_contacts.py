"""Put the contact emails back, from both places the workbook states them.

Two sources, and they mean different things:

  InvestorBase Data     "Contact 1..4" with title and email — the people WP2
                        already loaded as person_roles. Their addresses were
                        parsed and thrown away for want of a column.

  Investor Control Sheet  a single named contact per fund, with an address.
                        This is who Ardent actually approaches, which is often
                        not the most senior name on the other sheet, so it is
                        flagged is_key_contact rather than merged in as one
                        partner among several.

Matching is by name within the firm, never by name alone: "David Smith" is not
one person across 1,285 funds. A contact named on the control sheet who has no
person_roles row yet is created, because the sheet is Ardent's own record and
its absence upstream is a gap in the crawl, not evidence the person is fictional.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import openpyxl                       # noqa: E402
from crawler import db                # noqa: E402

WORKBOOK = ("/mnt/c/Users/gwill/Ardent Advisors/Operations and Marketing - Documents/"
            "Investors/Salesforce Master Investor List/"
            "Master Investor List GW Version - 26 2 09.xlsx")

# Anything that is not one address. The master list uses all of these to mean
# "we do not have one", and inserting them would make has_email lie.
BLANKS = {"", "-", "n/a", "na", "none", "tbc", "unknown", "no email", "#n/a"}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def clean(value) -> str:
    return re.sub(r"\s+", " ", str(value)).strip() if value not in (None, "") else ""


def address(value) -> str | None:
    """One address, or nothing. Cells carry 'a@b.com; c@d.com' and 'mailto:a@b'."""
    text = clean(value)
    if text.lower() in BLANKS:
        return None
    found = EMAIL.findall(text)
    return found[0].lower() if found else None


def base_data_contacts(wb) -> list[tuple[str, str, str | None, str | None]]:
    """(investor name, person name, title, email) from the InvestorBase tab."""
    rows = list(wb["InvestorBase Data"].iter_rows(min_row=3, values_only=True))
    header = [clean(h).lower() for h in rows[0]]
    index = {h: i for i, h in enumerate(header) if h}
    out = []
    for row in rows[1:]:
        name = clean(row[0]) if row else ""
        if not name:
            continue
        for n in (1, 2, 3, 4):
            who = index.get(f"contact {n}")
            if who is None or who >= len(row):
                continue
            person = clean(row[who])
            if not person:
                continue
            title_i, mail_i = index.get(f"contact {n} title"), index.get(f"contact {n} email")
            out.append((
                name, person,
                clean(row[title_i]) if title_i is not None and title_i < len(row) else None,
                address(row[mail_i]) if mail_i is not None and mail_i < len(row) else None,
            ))
    return out


def control_sheet_contacts(wb) -> list[tuple[str, str, str | None]]:
    """(investor name, contact name, email) — the designated contact."""
    ws = wb["Investor Control Sheet"]
    out = []
    for row in ws.iter_rows(min_row=13, max_col=27, values_only=True):
        name = clean(row[1]) if len(row) > 1 else ""
        person = clean(row[6]) if len(row) > 6 else ""
        if not name or not person:
            continue
        out.append((name, person, address(row[7]) if len(row) > 7 else None))
    return out


def resolve_company(conn, name: str) -> str | None:
    """Exact normalised name, else a single leading-token candidate. Same rule
    as load_control_sheet.py, and deliberately not a similarity search: a wrong
    firm here attaches a real person's address to someone else's fund."""
    exact = db.all_rows(
        conn,
        """
        select i.company_id
        from public.investors i join public.companies c on c.id = i.company_id
        where public.normalise_name(c.legal_name) = public.normalise_name(%s)
        """,
        (name,),
    )
    if len(exact) == 1:
        return exact[0]["company_id"]
    if exact:
        return None
    want = db.scalar(conn, "select public.normalise_name(%s)", (name,)) or ""
    tokens = want.split()
    if not tokens:
        return None
    rows = db.all_rows(
        conn,
        """
        select i.company_id, public.normalise_name(c.legal_name) as norm
        from public.investors i join public.companies c on c.id = i.company_id
        where split_part(public.normalise_name(c.legal_name), ' ', 1) = %s
        """,
        (tokens[0],),
    )
    leads = [r for r in rows if r["norm"].split()[:len(tokens)] == tokens]
    return leads[0]["company_id"] if len(leads) == 1 else None


def find_role(conn, company_id: str, person: str):
    return db.one(
        conn,
        """
        select r.id, r.email, r.is_key_contact
        from public.person_roles r join public.people p on p.id = r.person_id
        where r.company_id = %s and p.name_key = public.normalise_name(%s)
        limit 1
        """,
        (company_id, person),
    )


def key_contact_taken(conn, company_id: str) -> bool:
    """The unique index allows one key contact per firm. A workbook with two
    rows for the same house — Bridgepoint appears three times — would otherwise
    fail the whole load on the second. First one named wins, rest become
    ordinary team members."""
    return bool(db.one(
        conn,
        "select 1 as x from public.person_roles "
        "where company_id = %s and is_key_contact limit 1",
        (company_id,),
    ))


def ensure_person(conn, person: str) -> str:
    got = db.one(conn, "select id from public.people where name_key = public.normalise_name(%s)",
                 (person,))
    if got:
        return got["id"]
    return db.scalar(
        conn,
        "insert into public.people (full_name, confidence) values (%s, 0.900) returning id",
        (person,),
    )


def run(conn, dry_run: bool) -> int:
    wb = openpyxl.load_workbook(WORKBOOK, read_only=True, data_only=True)
    stats = Counter()
    companies: dict[str, str | None] = {}

    def company(name: str):
        if name not in companies:
            companies[name] = resolve_company(conn, name)
        return companies[name]

    # 1. Addresses for people already loaded from InvestorBase Data.
    for firm, person, _title, email in base_data_contacts(wb):
        stats["base_rows"] += 1
        if not email:
            continue
        cid = company(firm)
        if not cid:
            stats["base_no_firm"] += 1
            continue
        role = find_role(conn, cid, person)
        if not role:
            stats["base_no_role"] += 1
            continue
        if role["email"]:
            stats["base_already"] += 1
            continue
        stats["base_email"] += 1
        if not dry_run:
            db.execute(conn, "update public.person_roles set email = %s where id = %s",
                       (email, role["id"]))

    # 2. The designated contact from the control sheet.
    for firm, person, email in control_sheet_contacts(wb):
        stats["ics_rows"] += 1
        cid = company(firm)
        if not cid:
            stats["ics_no_firm"] += 1
            continue
        role = find_role(conn, cid, person)
        taken = (role and role["is_key_contact"]) or key_contact_taken(conn, cid)
        if not role:
            stats["ics_new_person"] += 1
            if not dry_run:
                pid = ensure_person(conn, person)
                db.execute(
                    conn,
                    """
                    insert into public.person_roles
                        (person_id, company_id, seniority, email, is_key_contact)
                    values (%s, %s, 'other', %s, %s)
                    on conflict do nothing
                    """,
                    (pid, cid, email, not taken),
                )
        else:
            if not taken:
                stats["ics_flagged"] += 1
            if email and not role["email"]:
                stats["ics_email"] += 1
            if not dry_run:
                db.execute(
                    conn,
                    """
                    update public.person_roles
                       set is_key_contact = is_key_contact or %s,
                           email = coalesce(email, %s)
                     where id = %s
                    """,
                    (not taken, email, role["id"]),
                )
        if not dry_run:
            conn.commit()

    for key in sorted(stats):
        print(f"  {key:18s} {stats[key]}")
    if dry_run:
        print("\n  dry run — nothing written. Add --apply.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    with db.connect() as conn:
        return run(conn, not args.apply)


if __name__ == "__main__":
    sys.exit(main())
