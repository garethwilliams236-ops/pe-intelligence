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
        name = _label_for(node, url, anchor)
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
