"""Find the pages on a sponsor site that are worth extracting from.

Sponsor sites vary enormously, so this scores candidate links rather than
matching a fixed set of paths, and returns the best few per page kind.
"""

from __future__ import annotations

import re
import urllib.parse as up
from dataclasses import dataclass

from selectolax.parser import HTMLParser

from .fetch import normalise_url

# Ordered by how much the ranking engine cares about the page.
PAGE_KINDS: dict[str, list[tuple[str, int]]] = {
    "portfolio_index": [
        (r"/(current-)?portfolio(/|$)", 10),
        (r"/our-(portfolio|companies|investments)", 10),
        (r"/(investments|companies|holdings)(/|$)", 7),
        (r"/case-stud(y|ies)", 5),
        (r"/(realised|realized|exits?|past-investments)", 8),
    ],
    "team_index": [
        (r"/(our-)?(team|people)(/|$)", 10),
        (r"/(who-we-are|about/(team|people))", 7),
        (r"/professionals", 6),
    ],
    "news_index": [
        (r"/(news|insights|press|media|latest)(/|$)", 6),
        (r"/(deals|transactions|announcements)(/|$)", 9),
    ],
}

LINK_TEXT_HINTS: dict[str, re.Pattern] = {
    "portfolio_index": re.compile(r"portfolio|our companies|investments|holdings|case stud", re.I),
    "team_index": re.compile(r"\bteam\b|our people|who we are|professionals", re.I),
    "news_index": re.compile(r"\bnews\b|insights|press|deals|transactions", re.I),
}

# Paths that are never worth a fetch.
JUNK = re.compile(
    r"/(privacy|cookie|legal|terms|disclaimer|accessibility|sitemap|search|"
    r"careers?|jobs|contact|login|wp-admin|wp-content|feed|tag|category|author)(/|$)"
    r"|\.(pdf|jpg|jpeg|png|gif|svg|zip|docx?|xlsx?|pptx?|mp4|webp|ico)$",
    re.I,
)


@dataclass
class Candidate:
    url: str
    kind: str
    score: int
    anchor: str

    def __hash__(self) -> int:
        return hash((self.url, self.kind))


def _same_site(a: str, b: str) -> bool:
    host_a = up.urlsplit(a).netloc.lower().removeprefix("www.")
    host_b = up.urlsplit(b).netloc.lower().removeprefix("www.")
    return host_a == host_b


def links(html: str, base_url: str) -> list[tuple[str, str]]:
    """Every same-site, non-junk link on the page as (url, anchor text)."""
    tree = HTMLParser(html)
    seen: dict[str, str] = {}
    for node in tree.css("a[href]"):
        href = (node.attributes.get("href") or "").strip()
        if not href or href.startswith(("mailto:", "tel:", "#", "javascript:")):
            continue
        url = normalise_url(up.urljoin(base_url, href))
        if not _same_site(url, base_url) or JUNK.search(up.urlsplit(url).path):
            continue
        anchor = (node.text(strip=True) or "")[:120]
        if url not in seen or (anchor and not seen[url]):
            seen[url] = anchor
    return list(seen.items())


def classify(url: str, anchor: str) -> list[Candidate]:
    """Score a link against every page kind it might be."""
    path = up.urlsplit(url).path.lower()
    out: list[Candidate] = []
    for kind, patterns in PAGE_KINDS.items():
        score = 0
        for pattern, weight in patterns:
            if re.search(pattern, path):
                score = max(score, weight)
        hint = LINK_TEXT_HINTS[kind]
        if anchor and hint.search(anchor):
            score += 3
        # Deep paths are usually a single company or person, not an index.
        depth = len([p for p in path.split("/") if p])
        if score and depth > 2:
            score -= 2
        if score > 0:
            out.append(Candidate(url=url, kind=kind, score=score, anchor=anchor))
    return out


def index_pages(html: str, base_url: str, per_kind: int = 2) -> list[Candidate]:
    """The best index pages on this site, at most `per_kind` of each kind."""
    scored: list[Candidate] = []
    for url, anchor in links(html, base_url):
        scored.extend(classify(url, anchor))
    best: dict[str, list[Candidate]] = {}
    for candidate in sorted(scored, key=lambda c: (-c.score, len(c.url))):
        bucket = best.setdefault(candidate.kind, [])
        if candidate.url not in {c.url for c in bucket} and len(bucket) < per_kind:
            bucket.append(candidate)
    return [c for bucket in best.values() for c in bucket]


# Sections a detail page can live under. Real sites rarely put detail pages
# under the index path: Duke Street indexes at /our-portfolio.html and details
# at /our-portfolio/<slug>.html; Synova indexes at /companies and details at
# /case-studies/<slug>; Equistone indexes at /investments and details at
# /investmentdetail/<slug>/<id>. So match the section by vocabulary, not by
# the index's own path.
SECTION_VOCAB: dict[str, re.Pattern] = {
    "portfolio": re.compile(
        r"portfolio|investment|compan(y|ies)|case-?stud|holding|deal|transaction|"
        r"business(es)?|brand", re.I),
    "team": re.compile(r"team|people|professional|staff|partner|colleague", re.I),
}

_SECTION_NOISE = re.compile(
    r"^(index|home|page|wp|content|assets|static|_next|search|tag|category)$", re.I)


def detail_links(html: str, base_url: str, kind: str = "portfolio") -> list[tuple[str, str]]:
    """Links from an index page that look like individual entries.

    Groups same-site links by their first path segment, keeps the groups whose
    segment reads like the right kind of section, and returns the largest one.
    Falls back to children-of-the-index-path when no section matches.
    """
    vocab = SECTION_VOCAB.get(kind)
    index_path = up.urlsplit(base_url).path.rstrip("/")

    groups: dict[str, list[tuple[str, str]]] = {}
    for url, anchor in links(html, base_url):
        path = up.urlsplit(url).path.rstrip("/")
        if path == index_path:
            continue
        parts = [p for p in path.split("/") if p]
        if len(parts) < 2:          # a detail page is never a top-level path
            continue
        section = parts[0]
        if _SECTION_NOISE.match(section):
            continue
        if vocab is not None and not vocab.search(section):
            continue
        groups.setdefault(section, []).append((url, anchor))

    if groups:
        best = max(groups.values(), key=len)
        if len(best) >= 2:
            return _dedupe(best)

    # Fallback: direct children of the index path, for sites whose section
    # name we have no vocabulary for.
    out: list[tuple[str, str]] = []
    for url, anchor in links(html, base_url):
        path = up.urlsplit(url).path.rstrip("/")
        if path == index_path or not path.startswith(index_path + "/"):
            continue
        remainder = path[len(index_path) + 1:]
        if not remainder or "/" in remainder:
            continue
        out.append((url, anchor))
    return _dedupe(out)


def _dedupe(pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for url, anchor in pairs:
        if url in seen:
            continue
        seen.add(url)
        out.append((url, anchor))
    return out
