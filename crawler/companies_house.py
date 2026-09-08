"""Companies House API client.

Public register, free API, but rate limited to 600 requests per five minutes
and it will start returning 429 if you ignore that. This client paces itself,
backs off when told to, and identifies itself.

Needs CH_API_KEY. Register at developer.company-information.service.gov.uk —
the key is used as the HTTP basic-auth username with an empty password, which
is unusual but is what the service expects.

What this gives us: company number, registered name, previous names, status,
incorporation date, registered address and SIC codes. What it does not give us
is financials — filed accounts are iXBRL documents behind the document API and
parsing those is a separate job.
"""

from __future__ import annotations

import os
import time

import httpx

BASE = "https://api.company-information.service.gov.uk"
USER_AGENT = (
    "ArdentPEIntelligence/0.1 (+https://ardentadvisors.com; "
    "contact gwilliams@ardentadvisors.com)"
)

# 600 requests per 5 minutes = 2/sec. Sit comfortably under it.
MIN_INTERVAL = 0.6
MAX_RETRIES = 4


class RateLimited(Exception):
    pass


class CompaniesHouse:
    def __init__(self, api_key: str | None = None, verbose: bool = False):
        key = api_key or os.environ.get("CH_API_KEY")
        if not key:
            raise SystemExit(
                "CH_API_KEY is not set.\n"
                "Register a key at https://developer.company-information.service.gov.uk\n"
                "then add it to .env:  export CH_API_KEY='...'"
            )
        self.client = httpx.Client(
            base_url=BASE,
            auth=(key, ""),
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=httpx.Timeout(20.0, connect=10.0),
        )
        self._last = 0.0
        self.verbose = verbose
        self.calls = 0

    def close(self) -> None:
        self.client.close()

    def _get(self, path: str, params: dict | None = None) -> dict | None:
        for attempt in range(MAX_RETRIES):
            wait = MIN_INTERVAL - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            self.calls += 1
            try:
                response = self.client.get(path, params=params)
            except Exception as exc:
                if self.verbose:
                    print(f"    {type(exc).__name__} on {path}")
                return None

            if response.status_code == 200:
                return response.json()
            if response.status_code == 404:
                return None
            if response.status_code == 429:
                # Respect Retry-After when given; otherwise back off hard,
                # because the window is five minutes long.
                delay = int(response.headers.get("Retry-After", 0)) or (30 * (attempt + 1))
                if self.verbose:
                    print(f"    rate limited, waiting {delay}s")
                time.sleep(delay)
                continue
            if response.status_code in (401, 403):
                raise SystemExit(
                    f"Companies House rejected the key ({response.status_code}). "
                    "Check CH_API_KEY is a Live key for the REST API, not a "
                    "streaming or test key."
                )
            if self.verbose:
                print(f"    HTTP {response.status_code} on {path}")
            return None
        raise RateLimited(f"gave up after {MAX_RETRIES} attempts on {path}")

    # -- endpoints ---------------------------------------------------------
    def search(self, name: str, limit: int = 8) -> list[dict]:
        data = self._get("/search/companies", {"q": name, "items_per_page": limit})
        return (data or {}).get("items", []) or []

    def profile(self, number: str) -> dict | None:
        return self._get(f"/company/{number}")
