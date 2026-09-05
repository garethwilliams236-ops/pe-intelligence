"""Turn a fetched page into candidate claims.

Two extractors, deliberately separable:

  heuristic  — structural. Reads the index page's own link pattern, so it needs
               no per-site configuration and costs nothing. This is the default,
               and on most sponsor sites it gets the portfolio and team lists.
  llm        — used only where the heuristic finds nothing, and only when
               ANTHROPIC_API_KEY is set. Costs money, so it is opt-in per run.

Neither writes to the typed tables. Everything lands in `claims` as a
candidate, to be promoted deliberately in a later work package.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field

from selectolax.parser import HTMLParser

from .discover import detail_links

VERSION = "1"

_JUNK_LABEL = re.compile(
    r"^(read|find out|learn|view|see|more|discover|explore|visit)\b"
    r"|^(more|read more|learn more|view all|see all|website|case study|details?)$",
    re.I,
)
_YEAR = re.compile(r"\b(19[89]\d|20[0-4]\d)\b")
_EXITED = re.compile(r"\b(exit(ed)?|realis(ed|ation)|realiz(ed|ation)|sold|divest)\b", re.I)
_CURRENT = re.compile(r"\b(current|active|live)\b", re.I)
_PERSON = re.compile(r"^[A-Z][\w'’\-]+(?: [A-Z][\w'’\-.]+){1,3}$")
_TITLE_HINT = re.compile(
    r"partner|principal|director|associate|analyst|manager|chair|"
    r"chief|head of|founder|counsel|controller|investor relations", re.I)

# Some houses anonymise their index ("Global natural stone company") or append a
# tagline ("AppCheck: helping businesses strengthen cyber resilience"). Neither
# is a company name, and storing them as one poisons entity resolution later.
_DESCRIPTION_TAIL = re.compile(
    r"\b(compan(y|ies)|provider|business(es)?|group of|manufacturer|operator|"
    r"specialist|supplier|distributor|platform|solutions?|services?)\s*$", re.I)
_DESCRIPTION_LEAD = re.compile(
    r"^(a|an|the|global|leading|international|european|uk|world'?s)\b", re.I)
_LABEL_NOISE = re.compile(
    r"\s*(exit date|date of exit|investment date|date of investment|status)\s*:?.*$", re.I)


def looks_like_description(label: str) -> bool:
    """True when the label reads as prose about a company, not its name."""
    words = label.split()
    if len(words) < 3:
        return False
    if _DESCRIPTION_TAIL.search(label) and _DESCRIPTION_LEAD.match(label):
        return True
    lowers = sum(1 for w in words[1:] if w[:1].islower())
    # "Leading provider of telecare" — a description opener followed by nothing
    # capitalised. A real name keeps its capitals ("The Access Group").
    if _DESCRIPTION_LEAD.match(label) and lowers == len(words) - 1:
        return True
    # Sentence-like: mostly lowercase words after the first.
    return len(words) >= 5 and lowers >= len(words) - 2


# "BCNBCN is a UK-focussed IT managed services provider" — the anchor ran the
# name into its own description with no separator, and doubled it doing so.
_RUNS_INTO_PROSE = re.compile(
    r"^(.{2,60}?)\s+(?:is|are|was|were|provides?|offers?|delivers?|supplies|"
    r"specialis\w+|specializ\w+|operates?|helps?)\s+", re.I)


def _undouble(token: str) -> str:
    """'BCNBCN' -> 'BCN'. Only for a single word, and only when each half is
    long enough that the repeat cannot be a coincidence like 'Isis'."""
    if " " in token or len(token) % 2 or len(token) < 6:
        return token
    half = len(token) // 2
    return token[:half] if token[:half].lower() == token[half:].lower() else token


def tidy_name(label: str | None) -> str | None:
    """Strip label noise and taglines; reject prose."""
    if not label:
        return None
    label = _LABEL_NOISE.sub("", label).strip(" -–—:·|")
    run_on = _RUNS_INTO_PROSE.match(label)
    if run_on:
        # Only trust this when what precedes the verb is short enough to be a
        # name rather than a clause.
        head = run_on.group(1).strip()
        if len(head.split()) <= 5:
            label = _undouble(head)
    # "AppCheck: helping businesses to ..." -> "AppCheck", but only when the
    # head is short and the tail is long enough to be a tagline.
    if ":" in label:
        head, _, tail = label.partition(":")
        head, tail = head.strip(), tail.strip()
        if head and len(head.split()) <= 4 and len(tail.split()) >= 3:
            label = head
    if not label or looks_like_description(label):
        return None
    return label


@dataclass
class Extracted:
    kind: str
    items: list[dict] = field(default_factory=list)
    method: str = "heuristic"


def _clean(label: str) -> str | None:
    label = re.sub(r"\s+", " ", (label or "")).strip(" –—-·|")
    if not label or len(label) > 90 or _JUNK_LABEL.match(label):
        return None
    if label.lower() in ("home", "about", "contact", "portfolio", "team", "news"):
        return None
    return label


def _detail_anchors(html: str, base_url: str, kind: str = "portfolio"):
    """Yield (node, url, anchor_text) for links that look like detail pages.

    Keeping the node is the point: re-finding it by URL later matches the wrong
    element on pages where several cards share a URL suffix.
    """
    tree = HTMLParser(html)
    wanted = {url: anchor for url, anchor in detail_links(html, base_url, kind)}
    if not wanted:
        return
    suffixes = {up_path(url): url for url in wanted}
    for node in tree.css("a[href]"):
        href = (node.attributes.get("href") or "").strip()
        if not href:
            continue
        url = suffixes.get(up_path(href))
        if url is None:
            continue
        yield node, url, (node.text(strip=True) or "")[:120]


def up_path(url: str) -> str:
    """Path portion, normalised, for matching an href against a resolved URL."""
    path = url.split("?", 1)[0].split("#", 1)[0]
    if "://" in path:
        path = "/" + path.split("://", 1)[1].split("/", 1)[-1] if "/" in path.split("://", 1)[1] else "/"
    return path.rstrip("/").lower()


def _card_text(node, max_chars: int = 400) -> str:
    """Text of the largest ancestor block that still contains only this link."""
    current = node
    for _ in range(5):
        parent = current.parent
        if parent is None:
            break
        if len(parent.css("a[href]")) > 1:
            break
        text = parent.text(separator="  ", strip=True)
        if len(text) > max_chars:
            break
        current = parent
    # If the anchor is alone in its card, the useful text is usually the
    # sibling block; widen once more only if that stays single-linked.
    parent = current.parent
    if parent is not None and len(parent.css("a[href]")) == 1:
        text = parent.text(separator="  ", strip=True)
        if len(text) <= max_chars:
            current = parent
    return current.text(separator="  ", strip=True)[:max_chars]


def _label_for(node, url: str, anchor: str, slug_fallback: bool = True) -> str | None:
    """Prefer the anchor text, then a heading, then optionally the URL slug.

    People never get the slug fallback: a link labelled "Read more" pointing at
    /team/join-us/ would otherwise be invented as a person called "Join Us".
    """
    label = _clean(anchor)
    if label:
        return label
    for heading in ("h1", "h2", "h3", "h4", "h5"):
        found = node.css_first(heading)
        if found:
            candidate = _clean(found.text(strip=True))
            if candidate:
                return candidate
    if not slug_fallback:
        return None
    slug = url.rstrip("/").rsplit("/", 1)[-1]
    slug = re.sub(r"[-_]+", " ", slug).strip()
    return slug.title() if slug and not slug.isdigit() else None


def portfolio(html: str, base_url: str) -> Extracted:
    out: list[dict] = []
    seen: set[str] = set()
    for node, url, anchor in _detail_anchors(html, base_url, "portfolio"):
        name = tidy_name(_label_for(node, url, anchor, slug_fallback=False))
        if not name:
            # Anonymised or prose label — fall back to the URL slug, which is
            # usually the real name even when the visible text is not.
            slug = url.rstrip("/").rsplit("/", 1)[-1]
            slug = re.sub(r"\.(html?|php|aspx)$", "", slug, flags=re.I)
            slug = re.sub(r"[-_]+", " ", slug).strip()
            name = slug.title() if slug and not slug.isdigit() else None
            name = tidy_name(name)
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        card = _card_text(node)
        years = _YEAR.findall(card)
        status = None
        if _EXITED.search(card):
            status = "realised"
        elif _CURRENT.search(card):
            status = "current"
        out.append({
            "name": name,
            "url": url,
            "entry_year": int(years[0]) if years else None,
            "exit_year": int(years[1]) if len(years) > 1 else None,
            "status": status,
            "context": card[:300] or None,
        })
    return Extracted(kind="portfolio_company", items=out)


def team(html: str, base_url: str) -> Extracted:
    out: list[dict] = []
    seen: set[str] = set()
    for node, url, anchor in _detail_anchors(html, base_url, "team"):
        name = _label_for(node, url, anchor, slug_fallback=False)
        if not name or not _PERSON.match(name) or name.lower() in seen:
            continue
        seen.add(name.lower())
        card = _card_text(node, max_chars=200)
        title = None
        for line in re.split(r"\s{2,}|\||·|–", card):
            line = line.strip()
            if line and line.lower() != name.lower() and _TITLE_HINT.search(line):
                title = line[:120]
                break
        out.append({"name": name, "title": title, "url": url})
    return Extracted(kind="team_member", items=out)


def run_heuristic(kind: str, html: str, base_url: str) -> Extracted:
    if kind == "portfolio_index":
        return portfolio(html, base_url)
    if kind == "team_index":
        return team(html, base_url)
    return Extracted(kind="other", items=[])


# ---------------------------------------------------------------------------
# Optional LLM fallback
# ---------------------------------------------------------------------------
LLM_MODEL = os.environ.get("EXTRACTOR_MODEL", "claude-sonnet-4-5")

_PROMPT = """You are reading one page from a private equity firm's website.

Return ONLY a JSON array. No prose, no code fence.

If this is a PORTFOLIO or INVESTMENTS page, return one object per portfolio
company: {{"name": str, "entry_year": int|null, "exit_year": int|null,
"status": "current"|"realised"|null, "sector": str|null}}

If this is a TEAM or PEOPLE page, return one object per person:
{{"name": str, "title": str|null}}

Rules:
- Only what the page states. Never infer a year, a sector or a status.
- Skip navigation, cookie banners, footers and the firm's own name.
- Empty array if the page is neither kind.

PAGE TEXT:
{text}
"""


def run_llm(kind: str, text: str) -> Extracted:
    """Returns an empty result if no API key is configured."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return Extracted(kind="none", items=[], method="llm-unavailable")
    try:
        import anthropic
    except ImportError:
        return Extracted(kind="none", items=[], method="llm-unavailable")

    client = anthropic.Anthropic()
    message = client.messages.create(
        model=LLM_MODEL,
        max_tokens=4000,
        messages=[{"role": "user", "content": _PROMPT.format(text=text[:60_000])}],
    )
    raw = "".join(block.text for block in message.content if block.type == "text").strip()
    raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.M).strip()
    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        return Extracted(kind="none", items=[], method="llm-badjson")
    if not isinstance(items, list):
        return Extracted(kind="none", items=[], method="llm-badjson")

    resolved = "portfolio_company" if kind == "portfolio_index" else "team_member"
    cleaned = [i for i in items if isinstance(i, dict) and _clean(str(i.get("name", "")))]
    return Extracted(kind=resolved, items=cleaned, method="llm")


# ---------------------------------------------------------------------------
# Detail pages
#
# The pilot established that index pages carry descriptions, not dates: of 365
# portfolio claims, zero had a year. Sponsors publish the investment date on the
# company's own page, usually as a labelled field. This reads those labels, and
# falls back to bare years only when it can mark the result as weaker evidence.
# ---------------------------------------------------------------------------
_ENTRY_LABEL = re.compile(
    r"(date of investment|investment date|invested(?: in)?|date invested|acquired|"
    r"entry date|first invested|original investment|backed|partnered)"
    r"[^0-9]{0,30}((?:19|20)\d{2})", re.I)
_EXIT_LABEL = re.compile(
    r"(date of exit|exit date|exited(?: in)?|realised in|realized in|"
    r"sold(?: to)?|divested|disposal)[^0-9]{0,25}((?:19|20)\d{2})", re.I)
_SECTOR_LABEL = re.compile(
    r"(?:sector|industry|vertical)[ \t]*[:\-–][ \t]*"
    r"([A-Za-z][\w &/,'-]{1,40}?)(?=\s{2,}|[\n.;|]|$)", re.I)
_STATUS_REALISED = re.compile(
    r"\b(realis(ed|ation)|realiz(ed|ation)|exited|former (investment|portfolio)|"
    r"past investment)\b", re.I)
_STATUS_CURRENT = re.compile(
    r"\b(current (investment|portfolio)|active investment|portfolio company)\b", re.I)


def detail(text: str, title: str | None = None) -> dict:
    """Pull dates, status and sector from one portfolio company's page."""
    blob = re.sub(r"\s+", " ", text or "")[:20000]
    result: dict = {
        "entry_year": None, "exit_year": None, "status": None,
        "sector": None, "evidence": None, "date_confidence": None,
    }

    entry = _ENTRY_LABEL.search(blob)
    if entry:
        result["entry_year"] = int(entry.group(2))
        result["evidence"] = blob[max(0, entry.start() - 40):entry.end() + 40].strip()
        result["date_confidence"] = "labelled"

    exit_match = _EXIT_LABEL.search(blob)
    if exit_match:
        result["exit_year"] = int(exit_match.group(2))
        result["status"] = "realised"
        if not result["evidence"]:
            result["evidence"] = blob[max(0, exit_match.start() - 40):exit_match.end() + 40].strip()
            result["date_confidence"] = "labelled"

    # Fallback: bare years, only when no label was found. Flagged as weaker so
    # promotion can treat it differently rather than trusting it equally.
    if result["entry_year"] is None:
        years = sorted({int(y) for y in _YEAR.findall(blob)})
        if len(years) == 1:
            result["entry_year"] = years[0]
            result["date_confidence"] = "bare_year"
        elif len(years) == 2:
            result["entry_year"], result["exit_year"] = years
            result["date_confidence"] = "bare_year"

    if result["status"] is None:
        if _STATUS_REALISED.search(blob):
            result["status"] = "realised"
        elif _STATUS_CURRENT.search(blob):
            result["status"] = "current"

    # against the raw text, not the collapsed blob — see _SECTOR_LABEL
    sector = _SECTOR_LABEL.search(text or "")
    if sector:
        result["sector"] = sector.group(1).strip(" -–,")

    if result["entry_year"] and result["exit_year"] and result["exit_year"] < result["entry_year"]:
        result["entry_year"], result["exit_year"] = result["exit_year"], result["entry_year"]

    return result
