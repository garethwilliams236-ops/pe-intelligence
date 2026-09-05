"""Fixture tests for discovery and heuristic extraction.

The fixtures imitate the three layouts sponsor sites actually use: a card grid
with detail pages, a table with entry/exit years, and a team directory.
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from crawler.discover import index_pages, detail_links
from crawler.extract import portfolio, team
from crawler.fetch import normalise_url, visible_text

HOME = """<html><body><nav>
  <a href="/">Home</a>
  <a href="/about/">About</a>
  <a href="/portfolio/">Our Portfolio</a>
  <a href="/team/">Our Team</a>
  <a href="/news/">News &amp; Insights</a>
  <a href="/privacy-policy/">Privacy</a>
  <a href="https://twitter.com/x">Twitter</a>
</nav></body></html>"""

PORTFOLIO_CARDS = """<html><body>
<nav><a href="/">Home</a><a href="/portfolio/">Portfolio</a></nav>
<div class="grid">
  <article><a href="/portfolio/northbank-software/"><h3>Northbank Software</h3></a>
    <p class="meta">Technology</p><p class="year">Invested 2018</p></article>
  <article><a href="/portfolio/harbour-diagnostics/"><h3>Harbour Diagnostics</h3></a>
    <p class="meta">Healthcare</p><p class="year">Invested 2021</p></article>
  <article><a href="/portfolio/kestrel-analytics/"><h3>Kestrel Analytics</h3></a>
    <p class="meta">Data</p><p>Invested 2016 &middot; Exited 2022 &middot; Realised</p></article>
  <article><a href="/portfolio/pelham-logistics/"><h3>Pelham Logistics</h3></a>
    <p>Read more</p></article>
</div>
<footer><a href="/legal/">Legal</a></footer></body></html>"""

PORTFOLIO_TABLE = """<html><body>
<table><tbody>
<tr><td><a href="/investments/argyle-foods">Argyle Foods</a></td><td>Consumer</td>
    <td>2019</td><td>Current</td></tr>
<tr><td><a href="/investments/brightline-media">Brightline Media</a></td><td>Media</td>
    <td>2015</td><td>Exited 2023</td></tr>
</tbody></table></body></html>"""

TEAM = """<html><body><div class="people">
  <div><a href="/team/alexandra-finch/"><h4>Alexandra Finch</h4></a>
       <span>Managing Partner</span></div>
  <div><a href="/team/tom-oakley/"><h4>Tom Oakley</h4></a>
       <span>Investment Director</span></div>
  <div><a href="/team/joins-us/"><h4>Read more</h4></a></div>
</div></body></html>"""

def check(label, got, want):
    ok = got == want
    print(("PASS " if ok else "FAIL ") + label)
    if not ok:
        print("   got :", got)
        print("   want:", want)
    return ok

fails = 0

# --- url normalisation ---
fails += not check("normalise strips utm + trailing slash",
    normalise_url("https://WWW.Example.com/portfolio/?utm_source=x&page=2#top"),
    "https://www.example.com/portfolio?page=2")

# --- discovery ---
found = {c.kind: c.url for c in index_pages(HOME, "https://example.com/")}
fails += not check("discovers portfolio index", found.get("portfolio_index"),
                   "https://example.com/portfolio")
fails += not check("discovers team index", found.get("team_index"),
                   "https://example.com/team")
fails += not check("skips privacy/social",
                   any("privacy" in u or "twitter" in u for u in found.values()), False)

# --- portfolio, card layout ---
items = portfolio(PORTFOLIO_CARDS, "https://example.com/portfolio").items
names = [i["name"] for i in items]
fails += not check("card grid: four companies", names,
    ["Northbank Software", "Harbour Diagnostics", "Kestrel Analytics", "Pelham Logistics"])
by = {i["name"]: i for i in items}
fails += not check("card grid: entry year", by["Northbank Software"]["entry_year"], 2018)
fails += not check("card grid: exit year", by["Kestrel Analytics"]["exit_year"], 2022)
fails += not check("card grid: realised status", by["Kestrel Analytics"]["status"], "realised")
fails += not check("card grid: 'Read more' falls back to slug",
                   by["Pelham Logistics"]["name"], "Pelham Logistics")

# --- portfolio, table layout ---
items = portfolio(PORTFOLIO_TABLE, "https://example.com/investments")
fails += not check("table layout: two companies",
                   [i["name"] for i in items.items], ["Argyle Foods", "Brightline Media"])

# --- team ---
people = team(TEAM, "https://example.com/team").items
fails += not check("team: two people, junk dropped",
                   [(p["name"], p["title"]) for p in people],
                   [("Alexandra Finch", "Managing Partner"),
                    ("Tom Oakley", "Investment Director")])

# --- text extraction drops scripts ---
fails += not check("visible_text drops script",
    "alert" in visible_text("<html><body><p>Hi</p><script>alert(1)</script></body></html>"),
    False)

# --- real-world URL schemes found in the WP3 pilot survey -------------------
DUKE = """<html><body>
<a href="/our-portfolio.html">Portfolio</a>
<a href="/our-portfolio/argyle-foods.html">Argyle Foods</a>
<a href="/our-portfolio/brightline-media.html">Brightline Media</a>
<a href="/our-portfolio/cawdor-clinics.html">Cawdor Clinics</a>
<a href="/index.html?a=1">x</a><a href="/index.html?a=2">y</a><a href="/index.html?a=3">z</a>
<a href="/latest-news/2026-something.html">News item</a>
</body></html>"""

SYNOVA = """<html><body>
<a href="/companies">Companies</a>
<a href="/case-studies/synectics-solutions">Read Case Study</a>
<a href="/case-studies/unity5">Read Case Study</a>
<a href="/case-studies/expana">Read Case Study</a>
</body></html>"""

EQUISTONE = """<html><body>
<a href="/investmentdetail/sf-filter/196">SF-Filter</a>
<a href="/investmentdetail/virgin-experience-days/194">Virgin Experience Days</a>
<a href="/investmentdetail/eperi/192">eperi</a>
<a href="/privacy-policy">Privacy</a>
</body></html>"""

fails += not check("duke street: .html index, children of section",
    [i["name"] for i in portfolio(DUKE, "https://x.com/our-portfolio.html").items],
    ["Argyle Foods", "Brightline Media", "Cawdor Clinics"])

fails += not check("synova: details in a different section",
    [i["name"] for i in portfolio(SYNOVA, "https://x.com/companies").items],
    ["Synectics Solutions", "Unity5", "Expana"])

fails += not check("equistone: two levels deep, different section",
    [i["name"] for i in portfolio(EQUISTONE, "https://x.com/investments").items],
    ["SF-Filter", "Virgin Experience Days", "eperi"])

print()
print("ALL PASS" if fails == 0 else f"{fails} FAILURE(S)")
sys.exit(1 if fails else 0)
