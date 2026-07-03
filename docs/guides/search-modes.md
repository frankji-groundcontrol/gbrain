# Search Modes

## Goal
Know which search command to use and when -- keyword, hybrid, or direct -- so every lookup is fast and returns the right result.

## What the User Gets
Without this: the agent fumbles between search commands, returns chunks when full pages are needed, runs expensive semantic searches when a direct get would do, or misses results entirely. With this: every lookup uses the optimal mode, token budgets are respected, and the user gets the right information in the fewest calls.

## Implementation

```
on user_asks_about(topic):
    # Decision tree: pick the right search mode

    if know_exact_slug(topic):
        # MODE 3: Direct get -- instant, no search overhead
        result = gbrain get <slug>
        # e.g., "Tell me about Alice" -> gbrain get alice-chen
        # Returns the FULL page -- compiled truth + timeline

    elif topic.is_exact_name or topic.is_keyword:
        # MODE 1: Keyword search -- fast, no embeddings needed, day-one ready
        results = gbrain search "{name_or_keyword}"
        # e.g., "Find anything about Series A" -> gbrain search "Series A"
        # Returns CHUNKS, not full pages

        # IMPORTANT: keyword search returns chunks
        # If the chunk confirms relevance, THEN load the full page:
        if chunk.confirms_relevance:
            full_page = gbrain get <slug_from_chunk>

    elif topic.is_semantic_question:
        # MODE 2: Hybrid search -- semantic + keyword, needs embeddings
        results = gbrain query "{natural language question}"
        # e.g., "Who do I know at fintech companies?" -> gbrain query "fintech contacts"
        # Returns ranked chunks via vector + keyword + RRF

        # Same rule: chunks first, then get full page if needed
        if chunk.confirms_relevance:
            full_page = gbrain get <slug_from_chunk>

# Quick reference:
# | Mode    | Command              | Needs Embeddings | Speed   | Best For                        |
# |---------|----------------------|------------------|---------|---------------------------------|
# | Keyword | gbrain search "term" | No               | Fastest | Known names, exact matches      |
# | Hybrid  | gbrain query "..."   | Yes              | Fast    | Semantic questions, fuzzy match  |
# | Direct  | gbrain get <slug>    | No               | Instant | When you know the slug          |

# Progression over time:
#   Day 1:  keyword search (works without embeddings)
#   After first embed: hybrid search unlocked
#   Once you know slugs: direct get for speed

# Precedence for conflicting information within a page:
#   1. User's direct statements (always wins)
#   2. Compiled truth sections (synthesized from evidence)
#   3. Timeline entries (raw signal, reverse chronological)
#   4. External sources (web search, APIs)
```

## Tricky Spots

1. **Search returns chunks, not full pages.** After `gbrain search` or `gbrain query`, you get excerpts. Always run `gbrain get <slug>` to load the full page when the chunk confirms relevance. Don't answer questions from chunks alone when the full context matters.
2. **Keyword search works without embeddings.** On day one before any embedding run, `gbrain search` still works. Don't tell the user "search isn't available yet" -- keyword search is always available.
3. **Don't use hybrid search for known names.** `gbrain query "Alice Chen"` wastes embedding compute. Use `gbrain search "Alice Chen"` or better yet `gbrain get alice-chen` if you know the slug.
4. **Token budget awareness.** A full page via `gbrain get` can be large. Read the search chunks first to confirm relevance before pulling the full page. "Did anyone mention the Series A?" -- search results (chunks) are probably enough. "Tell me everything about Alice" -- get the full page.
5. **Hybrid search needs embeddings to have been run.** If `gbrain query` returns nothing but `gbrain search` finds results, the embeddings haven't been generated yet. Run the embedding pipeline first.
6. **A far embedding provider can silently turn `gbrain query` into keyword-only search.** The query-time embed has a wall-clock budget (`search.query_embed_timeout_ms`, default 6000ms). If the embedding provider is far from the caller (e.g. DashScope Beijing from a cold CLI process) and the embed doesn't finish in time, the vector leg is dropped and `gbrain query` falls back to keyword-only -- so a purely-semantic question can come back empty or look like plain keyword results even though embeddings exist. This is distinct from #5, where no embeddings were ever run. Fix: raise the budget with `gbrain config set search.query_embed_timeout_ms 20000`, or export `GBRAIN_QUERY_EMBED_TIMEOUT_MS`.

## How to Verify

1. Run `gbrain search "Alice"` -- confirm it returns chunks with matching text and slug references.
2. Run `gbrain query "who works at fintech companies"` -- confirm it returns semantically relevant results (not just keyword matches on "fintech").
3. Run `gbrain get alice-chen` -- confirm it returns the full page with compiled truth and timeline.
4. Compare: search for the same entity using all three modes. Keyword should be fastest, hybrid should surface conceptual matches, direct should return the complete page.
5. After a search returns a chunk, run `gbrain get` on the slug from that chunk. Confirm the full page contains more context than the chunk alone.

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
