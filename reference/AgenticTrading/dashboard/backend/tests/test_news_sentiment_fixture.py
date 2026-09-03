import json
from pathlib import Path

import jsonschema

FIXTURES = Path(__file__).parent / "fixtures"


def load_signals_fixture() -> dict:
    return json.loads((FIXTURES / "signals-fixture.json").read_text())


def load_signals_wire_fixture() -> dict:
    """The stripped-and-injected shape the bearer-gated HTTP endpoint returns,
    as distinct from the raw on-disk artifact (`load_signals_fixture`). Per the
    contract (docs/integrations/finsearch-news-sentiment.md §"Producer response
    shape"): the view drops `generator`/`model`/`prompt_version` via
    `_PUBLIC_STRIP` and appends a server-computed `staleness_hours` last. The
    adapter reads this shape, so its `staleness_hours` / `degraded` branches are
    only reachable through this fixture — the on-disk one omits `staleness_hours`
    and is `status: ok`."""
    return json.loads((FIXTURES / "signals-wire-fixture.json").read_text())


def load_items_wire_fixture() -> dict:
    """The `GET /api/news/items/` response shape (news-story v2), the single
    recorded record of what the adapter's items path parses — see
    docs/integrations/finsearch-news-items.md.

    Content is synthetic (like the signals fixtures) but the KEY SET is the one
    the live producer emits, verified against prod 2026-07-14. That verification
    is the point: before this fixture existed the items shape lived only as
    inline dicts inside individual tests, so when AF renamed title/link ->
    headline/url the tests and the adapter drifted together and stayed green
    while prod silently served the Phase-A fallback.

    This is the batch the signals fixtures were derived FROM: `batch` matches
    their `source_items`, and the 6 stories reconcile with their diagnostics
    (stories_total 6; MSFT/NVDA signalled, AAPL/GOOGL not; one MSFT near-dup) —
    so the pair also demonstrates the Phase-B thesis that the items feed is
    broader than the signals it feeds."""
    return json.loads((FIXTURES / "items-wire-fixture.json").read_text())


# Every key `GET /api/news/items/` puts on a story, per the news-story v2 table
# in docs/integrations/finsearch-news-items.md. The first five are the shared
# vocabulary; guid/description/editorial_score are the items-only extras.
ITEMS_STORY_KEYS = {"headline", "url", "source", "published", "tickers",
                    "guid", "description", "editorial_score"}


def test_items_wire_fixture_matches_contract_essentials():
    """Pins the items fixture to the documented contract, so a future producer
    rename has to change this file — and be seen in review — rather than being
    absorbed silently into whichever test dict happened to mention the field."""
    body = load_items_wire_fixture()
    assert body["schema_version"] == 2
    assert set(body) == {"schema_version", "items", "count", "batch"}
    items = body["items"]
    assert isinstance(items, list) and items
    assert body["count"] == len(items)
    for item in items:
        assert set(item) == ITEMS_STORY_KEYS
        assert isinstance(item["headline"], str) and item["headline"]
        assert isinstance(item["url"], str) and item["url"]
        assert isinstance(item["published"], float)
        assert isinstance(item["tickers"], list)
    # newest-first, as the endpoint sorts it
    published = [i["published"] for i in items]
    assert published == sorted(published, reverse=True)


def test_items_wire_fixture_does_not_speak_the_retired_vocabulary():
    """Regression guard on the 2026-07-14 incident: `title`/`link` are the
    on-disk RSS-native names and must never reappear on the wire fixture — the
    rename happens at AF's boundary, so a consumer that sees them is looking at
    a pre-v1 shape. Bare `score` is retired the same way (news-story v2 renamed
    it `editorial_score`), but note it is retired for a stricter reason: the
    items endpoint has no boundary normalizer, so `editorial_score` sits in the
    producer's REQUIRED_FIELDS and a pre-rename batch trips the batch-level
    poison pill and 404s rather than being served as v1.

    These are named guards kept for their failure message; the exact-set match
    in test_items_wire_fixture_matches_contract_essentials already implies all
    three, and is what generalizes to the next rename."""
    for item in load_items_wire_fixture()["items"]:
        assert "title" not in item
        assert "link" not in item
        assert "score" not in item


def test_items_fixture_is_the_batch_the_signals_fixture_came_from():
    """Content-parity guard across the fixture pair (mirrors the signals
    wire/on-disk parity test below): if these drift apart, the items fixture
    stops being a coherent producer batch and the Phase-B breadth it
    demonstrates goes hollow."""
    signals_body = load_signals_fixture()
    items_body = load_items_wire_fixture()
    assert items_body["batch"] == signals_body["source_items"]
    assert items_body["count"] == signals_body["diagnostics"]["stories_total"]
    # every signalled story must exist in the batch, keyed by guid
    by_guid = {i["guid"]: i for i in items_body["items"]}
    for sym, sig in signals_body["signals"].items():
        story = by_guid[sig["guid"]]
        assert story["headline"] == sig["headline"]
        assert story["url"] == sig["url"]
        assert story["source"] == sig["source"]
        assert story["published"] == sig["published"]
        assert sym in story["tickers"]
    # ...and the batch must be strictly broader than the signals (the Phase-B point)
    assert len(items_body["items"]) > len(signals_body["signals"])


def test_fixture_matches_contract_essentials():
    body = load_signals_fixture()
    assert body["schema_version"] == 2
    assert isinstance(body["signals"], dict) and body["signals"]
    sample = next(iter(body["signals"].values()))
    for field in ("sentiment", "sentiment_score", "rationale", "headline",
                  "source", "url", "published", "guid", "n_articles"):
        assert field in sample


def test_signals_fixture_validates_against_the_vendored_producer_schema():
    """Both files are copied verbatim from FinSearch (`Heartbeat/schemas/` and
    `Heartbeat/tests/fixtures/`), so checking one against the other is what
    makes the vendored pair self-policing.

    Until now nothing in the suite loaded the schema at all — it was inert
    documentation, which is how it sat pinned at v1 while the producer moved to
    v2 and no test noticed. v2 sets additionalProperties:false and requires
    `sentiment_score`, so this is also the assertion that turns a re-vendored
    fixture carrying a stray legacy `score` into a CI failure.

    Only the on-disk fixture is validated, never the wire one: the wire shape
    deliberately violates this schema (it drops the three _PUBLIC_STRIP
    required fields and appends `staleness_hours`), which is precisely the
    distinction test_wire_fixture_reflects_public_projection guards."""
    schema = json.loads((FIXTURES / "signals-v2.schema.json").read_text())
    jsonschema.validate(instance=load_signals_fixture(), schema=schema)


def test_signals_fixtures_do_not_speak_the_retired_score_vocabulary():
    """Named guard on the retired `score` key, kept for its failure message
    rather than its coverage: the schema test above already forbids a stray
    `score` on the on-disk fixture (additionalProperties:false), and the wire
    fixture inherits that transitively via
    test_wire_fixture_is_base_minus_strip_plus_staleness's dict equality. Those
    two are what actually generalize to the NEXT rename; this one just says so
    out loud. The float assertion below is not redundant — see its comment.

    A fixture carrying `score` describes a shape the producer cannot emit (see
    the "two vocabularies" note in docs/integrations/finsearch-news-sentiment.md).
    That was this suite's blind channel: v1-pinned fixtures stayed green while
    prod served v2, so they failed when you fixed them and passed when you were
    wrong."""
    for body in (load_signals_fixture(), load_signals_wire_fixture()):
        for sig in body["signals"].values():
            assert "score" not in sig
            # Deliberately stricter than the vendored schema, whose `number`
            # admits ints: news_signals.py builds this via float() + round(),
            # so float — not "any number" — is the real producer invariant.
            # Don't relax it to (int, float): the schema check above already
            # covers "is a number", and only for the on-disk fixture, so this
            # is also the wire fixture's only type guard.
            assert isinstance(sig["sentiment_score"], float)


def test_wire_fixture_reflects_public_projection():
    """Guards the wire/on-disk distinction the adapter depends on: the wire
    shape carries `staleness_hours` and omits the three fields `_PUBLIC_STRIP`
    removes. If this drifts, the staleness/degraded coverage below goes hollow."""
    wire = load_signals_wire_fixture()
    assert wire["staleness_hours"] is not None            # injected on the wire
    for stripped in ("generator", "model", "prompt_version"):
        assert stripped not in wire                        # dropped by _PUBLIC_STRIP
    assert isinstance(wire["signals"], dict) and wire["signals"]


def test_wire_fixture_is_base_minus_strip_plus_staleness():
    """Content-parity guard: the wire fixture must equal the on-disk fixture
    modulo the documented transform (drop the three _PUBLIC_STRIP fields, append
    `staleness_hours`). The `signals` blocks are byte-identical today; without
    this assertion the two could silently diverge and quietly hollow out the
    wire-shape coverage that depends on them matching."""
    base = load_signals_fixture()
    wire = load_signals_wire_fixture()
    expected = {k: v for k, v in base.items()
                if k not in ("generator", "model", "prompt_version")}
    expected["staleness_hours"] = wire["staleness_hours"]
    assert wire == expected
