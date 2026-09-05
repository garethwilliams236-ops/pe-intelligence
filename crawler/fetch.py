"""Polite fetching.

Rules this module will not break:
  * robots.txt is fetched once per domain and honoured, including Crawl-delay
  * one request at a time per domain, with a floor of 2s between them
  * the User-Agent identifies the crawler and gives a contact
  * repeated failures back a domain off exponentially
Only publicly reachable pages are fetched. Nothing here logs in, submits a
form, or defeats a bot check.
"""

from __future__ import annotations

import hashlib
import re
import time
import urllib.parse as up
import urllib.robotparser as robotparser
from dataclasses import dataclass

import httpx
from selectolax.parser import HTMLParser

USER_AGENT = (
    "ArdentPEIntelligenceBot/0.1 "
    "(+https://ardentadvisors.com; research crawler; contact gwilliams@ardentadvisors.com)"
)
MIN_DELAY_MS = 2000
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
MAX_BYTES = 3_000_000

_STRIP_TAGS = ("script", "style", "noscript", "svg", "iframe", "template")
_TRACKING = re.compile(r"^(utm_|fbclid|gclid|mc_cid|mc_eid|ref$)", re.I)


@dataclass
class Fetched:
    url: str
    canonical_url: str
    status: int
    content_type: str | None
    html: str
    text: str
    title: str | None
    content_hash: str
    byte_size: int


def normalise_url(url: str) -> str:
    """Canonical form for dedupe: no fragment, no tracking params, no trailing slash."""
    parts = up.urlsplit(url.strip())
    query = [(k, v) for k, v in up.parse_qsl(parts.query, keep_blank_values=True)
             if not _TRACKING.match(k)]
    path = parts.path.rstrip("/") or "/"
    return up.urlunsplit((
        parts.scheme.lower(),
        parts.netloc.lower(),
        path,
        up.urlencode(sorted(query)),
        "",
    ))


def domain_of(url: str) -> str:
    return up.urlsplit(url).netloc.lower().removeprefix("www.")


def visible_text(html: str) -> str:
    tree = HTMLParser(html)
    for tag in _STRIP_TAGS:
        for node in tree.css(tag):
            node.decompose()
    body = tree.body or tree.root
    text = body.text(separator="\n", strip=True) if body else ""
    return re.sub(r"\n{3,}", "\n\n", text)


def page_title(html: str) -> str | None:
    tree = HTMLParser(html)
    node = tree.css_first("title")
    if node and node.text(strip=True):
        return node.text(strip=True)[:300]
    h1 = tree.css_first("h1")
    return h1.text(strip=True)[:300] if h1 else None


class Fetcher:
    """One instance per crawl run. Holds the robots cache and per-domain clock."""

    def __init__(self, verbose: bool = False):
        self.client = httpx.Client(
            headers={"User-Agent": USER_AGENT,
                     "Accept": "text/html,application/xhtml+xml"},
            timeout=TIMEOUT,
            follow_redirects=True,
        )
        self._robots: dict[str, tuple[robotparser.RobotFileParser | None, int]] = {}
        self._last_hit: dict[str, float] = {}
        self.verbose = verbose

    def close(self) -> None:
        self.client.close()

    # -- robots ------------------------------------------------------------
    def robots_for(self, url: str) -> tuple[robotparser.RobotFileParser | None, int, str | None]:
        host = up.urlsplit(url).netloc.lower()
        if host in self._robots:
            parser, delay = self._robots[host]
            return parser, delay, None
        robots_url = up.urlunsplit((up.urlsplit(url).scheme, host, "/robots.txt", "", ""))
        parser: robotparser.RobotFileParser | None = robotparser.RobotFileParser()
        body: str | None = None
        delay = MIN_DELAY_MS
        try:
            response = self.client.get(robots_url)
            if response.status_code == 200:
                body = response.text[:200_000]
                parser.parse(body.splitlines())
                stated = parser.crawl_delay(USER_AGENT) or parser.crawl_delay("*")
                if stated:
                    delay = max(MIN_DELAY_MS, int(float(stated) * 1000))
            else:
                # No robots.txt is permission by omission, not a reason to stop.
                parser = None
        except Exception:
            parser = None
        self._robots[host] = (parser, delay)
        return parser, delay, body

    def allowed(self, url: str) -> bool:
        parser, _, _ = self.robots_for(url)
        if parser is None:
            return True
        try:
            return parser.can_fetch(USER_AGENT, url)
        except Exception:
            return True

    # -- fetching ----------------------------------------------------------
    def _wait(self, host: str, delay_ms: int) -> None:
        last = self._last_hit.get(host)
        if last is not None:
            elapsed = (time.monotonic() - last) * 1000
            if elapsed < delay_ms:
                time.sleep((delay_ms - elapsed) / 1000)
        self._last_hit[host] = time.monotonic()

    def get(self, url: str) -> Fetched | None:
        """Fetch one page. Returns None if disallowed, non-HTML, or failed."""
        if not self.allowed(url):
            if self.verbose:
                print(f"    robots disallow  {url}")
            return None

        host = up.urlsplit(url).netloc.lower()
        _, delay, _ = self.robots_for(url)
        self._wait(host, delay)

        try:
            response = self.client.get(url)
        except Exception as exc:
            if self.verbose:
                print(f"    ERROR {type(exc).__name__}  {url}")
            return None

        content_type = response.headers.get("content-type", "")
        if response.status_code != 200 or "html" not in content_type.lower():
            if self.verbose:
                print(f"    skip {response.status_code} {content_type[:30]}  {url}")
            return None

        html = response.text[:MAX_BYTES]
        text = visible_text(html)
        return Fetched(
            url=url,
            canonical_url=normalise_url(str(response.url)),
            status=response.status_code,
            content_type=content_type.split(";")[0].strip() or None,
            html=html,
            text=text,
            title=page_title(html),
            content_hash=hashlib.sha256(text.encode("utf-8", "ignore")).hexdigest(),
            byte_size=len(response.content),
        )
