"""Read mandate briefs out of client documents.

Executive summaries and teasers live in each client's Business plan folder, in
whatever format the deal used at the time — PDF, Word or PowerPoint, sometimes
all three for the same client, and typically dozens of dated versions.

What this pulls out is deliberately narrow: **figures that sit next to a label**,
with the sentence they came from kept as evidence. Revenue, EBITDA, the amount
being raised, an enterprise value. It does not try to classify sector from prose
— that is exactly the kind of guess that looks right in a sample and is wrong at
scale, and sector is better typed by hand or inferred from the register.

Nothing is written until you have looked at it. `read` shows what a document
yields; `extract` writes claims against the mandate at `ardent_client_docs`
confidence (0.85), below analyst entry and above inference, so a figure you type
later overrides anything found here.
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = "/mnt/c/Users/gwill/Ardent Advisors"
VERSION = "1"

# A figure only counts if a label sits near it. The window is generous because
# these are prose documents: "revenue grew 40% to £12.4m in FY23" puts eight
# words between the label and the number.
LABELS = {
    "revenue_gbp": r"\b(revenues?|turnover|net sales|gross sales|ARR|run.?rate)\b",
    "ebitda_gbp":  r"\bebitda\b",
    "raise_gbp":   r"\b(raising|seeking|investment sought|funding requirement|"
                   r"capital required|round size)\b",
    "ev_gbp":      r"\b(enterprise value|valuation|asking price|pre-?money)\b",
}
WINDOW = 140

MONEY = re.compile(
    r"(?P<cur>[£$€]|\bGBP\b|\bUSD\b|\bEUR\b)\s?(?P<num>\d[\d,]*(?:\.\d+)?)\s*"
    r"(?P<mult>bn|billion|m\b|million|k\b|thousand)?",
    re.I,
)
MULTIPLIER = {"k": 1e3, "thousand": 1e3, "m": 1e6, "million": 1e6,
              "bn": 1e9, "billion": 1e9}

BRIEF_NAMES = re.compile(r"exec.{0,3}sum|teaser|information memo|\bIM\b", re.I)
SKIP_PATHS = ("xold", "/archive", "/.archive", "~$")


def text_from(path: str, limit: int = 12) -> str:
    """First `limit` pages / slides — a brief states its numbers early."""
    low = path.lower()
    try:
        if low.endswith(".pdf"):
            import pdfplumber
            with pdfplumber.open(path) as pdf:
                return "\n".join((p.extract_text() or "") for p in pdf.pages[:limit])
        if low.endswith((".docx", ".dotx")):
            import docx
            d = docx.Document(path)
            parts = [p.text for p in d.paragraphs]
            for table in d.tables:
                for row in table.rows:
                    parts.append(" | ".join(c.text for c in row.cells))
            return "\n".join(parts)
        if low.endswith((".pptx", ".potx")):
            from pptx import Presentation
            prs = Presentation(path)
            parts = []
            for slide in list(prs.slides)[:limit]:
                for shape in slide.shapes:
                    if shape.has_text_frame:
                        parts.append(shape.text_frame.text)
                    if getattr(shape, "has_table", False):
                        for row in shape.table.rows:
                            parts.append(" | ".join(c.text for c in row.cells))
            return "\n".join(parts)
    except Exception as exc:
        return f"__ERROR__ {type(exc).__name__}: {exc}"
    return ""


def to_gbp(match: re.Match) -> tuple[float, str] | None:
    try:
        value = float(match.group("num").replace(",", ""))
    except ValueError:
        return None
    mult = (match.group("mult") or "").lower().rstrip(".")
    value *= MULTIPLIER.get(mult, 1)
    cur = (match.group("cur") or "").upper()
    currency = {"£": "GBP", "$": "USD", "€": "EUR"}.get(cur, cur or "GBP")
    # No conversion here. A brief's figures are stated in its own currency and
    # `fx_to_gbp()` needs a date; guessing a rate would be worse than recording
    # the currency and letting promotion decide.
    return value, currency


# A brief is a sales document: it states what the business earns and what it
# expects to earn, in the same breath. These words mark the second kind, and a
# forecast recorded as an actual is worse than no figure at all.
# Note the absence of a bare "E" for the FY27E convention: under IGNORECASE it
# matches any word ending in "e" — use, the, value — and silently discarded most
# windows in every document.
FORECAST = re.compile(
    r"\b(target\w*|forecast\w*|project(ed|ion)\w*|expect\w*|budget\w*|"
    r"planned|ambition|guidance|by 20[2-9]\d)\b|FY2\dE\b", re.I)


def findings(text: str) -> list[dict]:
    """Labelled figures, each with the sentence it came from.

    The figure chosen is the one *closest to the label*, measured in characters.
    Taking the first in the window instead read "Revenues of £29m and £5.4m
    EBITDA" as an EBITDA of £29m — the label often follows its number in a
    brief, so position in the window says nothing about which figure belongs to
    which label.

    Only the single best figure per label occurrence survives, and only the best
    per attribute per document is returned, because these documents repeat their
    headline numbers on several slides.
    """
    best: dict[str, dict] = {}
    for attribute, pattern in LABELS.items():
        for label in re.finditer(pattern, text, re.I):
            lo = max(0, label.start() - WINDOW)
            hi = min(len(text), label.end() + WINDOW)
            window = text[lo:hi]
            if FORECAST.search(window):
                continue
            centre = label.start() - lo

            # A figure that FOLLOWS its label wins over one that precedes it,
            # even if the preceding one is closer. "reaching c.£41m and EBITDA
            # of c.£23m" puts £41m five characters before the label and £23m
            # eleven after; £23m is the EBITDA. Documents state "EBITDA of £X"
            # and only invert it in compressed headlines ("£5.4m EBITDA"), which
            # the fallback still catches.
            nearest, rank = None, (9, WINDOW * 2)
            end = label.end() - lo
            for money in MONEY.finditer(window):
                parsed = to_gbp(money)
                if not parsed or parsed[0] < 100_000:
                    # Below £100k is a unit price or a fee — Arkk's "average
                    # annual fee of £12,000" was being read as its revenue.
                    continue
                if money.start() >= end:
                    candidate = (0, money.start() - end)      # follows the label
                else:
                    candidate = (1, centre - money.end())     # precedes it
                if candidate < rank:
                    nearest, rank = parsed, candidate

            if not nearest or rank[1] > WINDOW:
                continue
            value, currency = nearest
            hit = {"attribute": attribute, "value": value, "currency": currency,
                   "rank": rank, "evidence": re.sub(r"\s+", " ", window).strip()}
            if attribute not in best or rank < best[attribute]["rank"]:
                best[attribute] = hit
    return list(best.values())


def documents() -> dict[str, list[str]]:
    found = defaultdict(list)
    for path in glob.glob(os.path.join(ROOT, "*Clients - Documents/**/*"), recursive=True):
        low = path.lower()
        if not low.endswith((".pdf", ".docx", ".pptx")):
            continue
        if any(s in low for s in SKIP_PATHS) or not BRIEF_NAMES.search(os.path.basename(path)):
            continue
        client = path.split("Documents/")[1].split("/")[0]
        found[client].append(path)
    # Newest first — a brief is revised as the deal develops, and the last
    # version is the one the investors on the ICS actually saw.
    return {c: sorted(ps, key=os.path.getmtime, reverse=True) for c, ps in found.items()}


def cmd_survey(args) -> int:
    docs = documents()
    kinds = defaultdict(int)
    for paths in docs.values():
        for p in paths:
            kinds[p.rsplit(".", 1)[-1].lower()] += 1
    print(f"  {len(docs)} clients with a brief document, "
          f"{sum(len(v) for v in docs.values())} documents")
    print(f"  formats: {dict(sorted(kinds.items(), key=lambda kv: -kv[1]))}\n")
    for client, paths in sorted(docs.items())[: args.limit or None]:
        print(f"  {client[:26]:26s} {len(paths):3d}  {os.path.basename(paths[0])[:52]}")
    return 0


def cmd_read(args) -> int:
    docs = documents()
    targets = {k: v for k, v in docs.items()
               if not args.client or args.client.lower() in k.lower()}
    if not targets:
        print("no matching client"); return 1

    for client, paths in sorted(targets.items())[: args.limit or None]:
        for path in paths[:args.tries]:
            text = text_from(path)
            if text.startswith("__ERROR__"):
                print(f"  {client[:24]:24s} {text[:70]}")
                continue
            hits = findings(text)
            if not hits and not args.verbose:
                continue
            print(f"\n  {client}  —  {os.path.basename(path)[:60]}")
            print(f"    {len(text)} chars extracted")
            for h in hits[:6]:
                print(f"    {h['attribute']:12s} {h['currency']} {h['value']:,.0f}")
                print(f"      \"{h['evidence'][:150]}\"")
            if hits:
                break            # this document yielded something; stop here
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("survey", help="what brief documents exist")
    p.add_argument("--limit", type=int, default=25)
    p.set_defaults(func=cmd_survey)

    p = sub.add_parser("read", help="show what a document yields, write nothing")
    p.add_argument("--client")
    p.add_argument("--limit", type=int, default=6)
    p.add_argument("--tries", type=int, default=3)
    p.add_argument("--verbose", action="store_true")
    p.set_defaults(func=cmd_read)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
