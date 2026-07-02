-- franky sharing layer — behavioral test suite (TDD: written before migration.sql)
-- Run via Supabase MCP execute_sql (or psql) as a role with BYPASSRLS.
-- Self-contained: creates fixtures, asserts, and ROLLS BACK — safe to re-run.
-- RED state: fails at the first DO block ("relation gbrain.users does not exist").
-- GREEN state: final SELECT returns 'ALL SHARING-LAYER TESTS PASSED'.

BEGIN;

DO $test$
DECLARE
  v_alice uuid; v_bob uuid; v_carol uuid;
  v_team uuid;
  v_alice_key text; v_bob_key text; v_carol_key text;
  v_alice_key_id uuid; v_tmp_key text; v_tmp_key_id uuid;
  v_note jsonb; v_note_slug text;
  v_owner_page_id int;
  v_res jsonb;
  v_cnt int;
  v_threw boolean;
  v_vec text;
BEGIN
  ---------------------------------------------------------------------------
  -- 1. Schema objects exist
  ---------------------------------------------------------------------------
  PERFORM 1 FROM information_schema.tables WHERE table_schema='gbrain' AND table_name='users';
  IF NOT FOUND THEN RAISE EXCEPTION 'T1a gbrain.users missing'; END IF;
  PERFORM 1 FROM information_schema.tables WHERE table_schema='gbrain' AND table_name='teams';
  IF NOT FOUND THEN RAISE EXCEPTION 'T1b gbrain.teams missing'; END IF;
  PERFORM 1 FROM information_schema.tables WHERE table_schema='gbrain' AND table_name='team_members';
  IF NOT FOUND THEN RAISE EXCEPTION 'T1c gbrain.team_members missing'; END IF;
  PERFORM 1 FROM information_schema.tables WHERE table_schema='gbrain' AND table_name='api_keys';
  IF NOT FOUND THEN RAISE EXCEPTION 'T1d gbrain.api_keys missing'; END IF;
  PERFORM 1 FROM information_schema.tables WHERE table_schema='gbrain' AND table_name='page_shares';
  IF NOT FOUND THEN RAISE EXCEPTION 'T1e gbrain.page_shares missing'; END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema='gbrain' AND table_name='pages' AND column_name='owner_user_id';
  IF NOT FOUND THEN RAISE EXCEPTION 'T1f pages.owner_user_id missing'; END IF;
  PERFORM 1 FROM gbrain.sources WHERE id='user-notes';
  IF NOT FOUND THEN RAISE EXCEPTION 'T1g user-notes source missing'; END IF;

  ---------------------------------------------------------------------------
  -- 2. Admin: users, teams, memberships
  ---------------------------------------------------------------------------
  v_alice := gbrain.admin_create_user('alice', 'Alice', 'alice@example.com');
  v_bob   := gbrain.admin_create_user('bob',   'Bob',   NULL);
  v_carol := gbrain.admin_create_user('carol', 'Carol', NULL);
  IF v_alice IS NULL OR v_bob IS NULL THEN RAISE EXCEPTION 'T2a admin_create_user returned NULL'; END IF;

  v_threw := false;
  BEGIN
    PERFORM gbrain.admin_create_user('Bad Handle!', NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_threw := true; END;
  IF NOT v_threw THEN RAISE EXCEPTION 'T2b invalid handle accepted'; END IF;

  v_team := gbrain.admin_create_team('builders', 'Builders', 'alice');
  IF v_team IS NULL THEN RAISE EXCEPTION 'T2c admin_create_team returned NULL'; END IF;
  PERFORM 1 FROM gbrain.team_members WHERE team_id=v_team AND user_id=v_alice AND role='owner';
  IF NOT FOUND THEN RAISE EXCEPTION 'T2d team owner not auto-enrolled'; END IF;

  PERFORM gbrain.admin_add_member('builders', 'bob', 'member');
  PERFORM 1 FROM gbrain.team_members WHERE team_id=v_team AND user_id=v_bob AND role='member';
  IF NOT FOUND THEN RAISE EXCEPTION 'T2e admin_add_member failed'; END IF;

  ---------------------------------------------------------------------------
  -- 3. API keys: issue, resolve, revoke, expire
  ---------------------------------------------------------------------------
  SELECT api_key, key_id INTO v_alice_key, v_alice_key_id FROM gbrain.admin_issue_api_key('alice', 'test-key');
  SELECT api_key INTO v_bob_key   FROM gbrain.admin_issue_api_key('bob', 'test-key');
  SELECT api_key INTO v_carol_key FROM gbrain.admin_issue_api_key('carol', 'test-key');
  IF v_alice_key !~ '^gbk_[0-9a-f]{40}$' THEN RAISE EXCEPTION 'T3a key format wrong: %', left(v_alice_key, 8); END IF;

  IF gbrain.resolve_api_key(v_alice_key) IS DISTINCT FROM v_alice THEN RAISE EXCEPTION 'T3b resolve_api_key wrong user'; END IF;
  IF gbrain.resolve_api_key('gbk_' || repeat('0', 40)) IS NOT NULL THEN RAISE EXCEPTION 'T3c bogus key resolved'; END IF;
  IF gbrain.resolve_api_key('not-a-key') IS NOT NULL THEN RAISE EXCEPTION 'T3d malformed key resolved'; END IF;

  -- plaintext never stored
  PERFORM 1 FROM gbrain.api_keys WHERE key_hash = v_alice_key OR key_prefix = v_alice_key;
  IF FOUND THEN RAISE EXCEPTION 'T3e plaintext key stored'; END IF;

  SELECT api_key, key_id INTO v_tmp_key, v_tmp_key_id FROM gbrain.admin_issue_api_key('alice', 'revoke-me');
  PERFORM gbrain.admin_revoke_api_key(v_tmp_key_id);
  IF gbrain.resolve_api_key(v_tmp_key) IS NOT NULL THEN RAISE EXCEPTION 'T3f revoked key still resolves'; END IF;

  SELECT api_key INTO v_tmp_key FROM gbrain.admin_issue_api_key('alice', 'expired', interval '-1 hour');
  IF gbrain.resolve_api_key(v_tmp_key) IS NOT NULL THEN RAISE EXCEPTION 'T3g expired key still resolves'; END IF;

  ---------------------------------------------------------------------------
  -- 4. put_note: ownership + visibility to author only
  ---------------------------------------------------------------------------
  v_note := public.gbrain_put_note(v_alice_key, 'Sharing Test Note', 'The zebra crossed the quantum bridge.');
  v_note_slug := v_note->>'slug';
  IF v_note_slug IS NULL THEN RAISE EXCEPTION 'T4a put_note returned no slug: %', v_note; END IF;
  PERFORM 1 FROM gbrain.pages WHERE slug=v_note_slug AND source_id='user-notes' AND owner_user_id=v_alice;
  IF NOT FOUND THEN RAISE EXCEPTION 'T4b note not persisted with ownership'; END IF;

  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(public.gbrain_list_shared(v_alice_key)) e WHERE e->>'slug'=v_note_slug;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T4c author cannot list own note'; END IF;
  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(public.gbrain_list_shared(v_bob_key)) e WHERE e->>'slug'=v_note_slug;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T4d unshared note visible to non-owner'; END IF;

  ---------------------------------------------------------------------------
  -- 5. Sharing: user grant, team grant, owner-only enforcement, unshare
  ---------------------------------------------------------------------------
  PERFORM public.gbrain_share_page(v_alice_key, v_note_slug, 'user', 'carol', 'read');
  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(public.gbrain_list_shared(v_carol_key)) e WHERE e->>'slug'=v_note_slug;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T5a user-share not visible to grantee'; END IF;

  v_res := public.gbrain_get_page(v_carol_key, v_note_slug);
  IF v_res->>'content' NOT LIKE '%quantum bridge%' THEN RAISE EXCEPTION 'T5b get_page content wrong'; END IF;
  IF v_res->>'permission' <> 'read' THEN RAISE EXCEPTION 'T5c permission should be read'; END IF;

  -- non-owner cannot share someone else's page
  v_threw := false;
  BEGIN
    PERFORM public.gbrain_share_page(v_carol_key, v_note_slug, 'user', 'bob', 'read');
  EXCEPTION WHEN OTHERS THEN v_threw := true; END;
  IF NOT v_threw THEN RAISE EXCEPTION 'T5d non-owner was able to share'; END IF;

  -- team share: bob (member of builders) gains visibility
  PERFORM public.gbrain_share_page(v_alice_key, v_note_slug, 'team', 'builders', 'write');
  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(public.gbrain_list_shared(v_bob_key)) e WHERE e->>'slug'=v_note_slug;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T5e team-share not visible to member'; END IF;
  -- write beats read when both grants exist (carol still read; bob write via team)
  v_res := public.gbrain_get_page(v_bob_key, v_note_slug);
  IF v_res->>'permission' <> 'write' THEN RAISE EXCEPTION 'T5f team write permission not applied'; END IF;

  PERFORM public.gbrain_unshare_page(v_alice_key, v_note_slug, 'user', 'carol');
  v_threw := false;
  BEGIN
    v_res := public.gbrain_get_page(v_carol_key, v_note_slug);
  EXCEPTION WHEN OTHERS THEN v_threw := true; END;
  IF NOT v_threw THEN RAISE EXCEPTION 'T5g unshare did not revoke access'; END IF;

  ---------------------------------------------------------------------------
  -- 6. get_page: missing and unpermitted look identical (no existence leak)
  ---------------------------------------------------------------------------
  v_threw := false;
  BEGIN
    v_res := public.gbrain_get_page(v_carol_key, 'no/such/page');
  EXCEPTION WHEN OTHERS THEN v_threw := true; END;
  IF NOT v_threw THEN RAISE EXCEPTION 'T6a missing page did not error'; END IF;

  ---------------------------------------------------------------------------
  -- 7. Brain-owner pages (owner_user_id NULL) shared via admin_share_page
  ---------------------------------------------------------------------------
  INSERT INTO gbrain.pages (source_id, slug, type, title, compiled_truth)
  VALUES ('default', 'test/owner-doc', 'concept', 'Owner Doc', 'The falcon archives the moonlit ledger.')
  RETURNING id INTO v_owner_page_id;

  PERFORM gbrain.admin_share_page('test/owner-doc', 'team', 'builders', 'read');
  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(public.gbrain_list_shared(v_bob_key)) e WHERE e->>'slug'='test/owner-doc';
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T7a admin team-share not visible'; END IF;
  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(public.gbrain_list_shared(v_carol_key)) e WHERE e->>'slug'='test/owner-doc';
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T7b admin share leaked outside team'; END IF;

  ---------------------------------------------------------------------------
  -- 8. FTS search respects visibility
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(public.gbrain_search_shared(v_bob_key, 'moonlit ledger')) e WHERE e->>'slug'='test/owner-doc';
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T8a FTS missed shared page'; END IF;
  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(public.gbrain_search_shared(v_carol_key, 'moonlit ledger')) e;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T8b FTS leaked unshared page'; END IF;

  ---------------------------------------------------------------------------
  -- 9. Vector search respects visibility (fixed unit vector fixture)
  ---------------------------------------------------------------------------
  v_vec := '[' || '1' || repeat(',0', 1535) || ']';
  INSERT INTO gbrain.content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, modality, embedding)
  VALUES (v_owner_page_id, 0, 'The falcon archives the moonlit ledger.', 'body', 'test-fixture', 'text', v_vec::extensions.vector);

  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(
    public.gbrain_search_vector(v_bob_key, (SELECT array_agg(x) FROM (SELECT 1.0::float8 AS x UNION ALL SELECT 0.0 FROM generate_series(1,1535)) s), 5)
  ) e WHERE e->>'slug'='test/owner-doc';
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T9a vector search missed shared chunk'; END IF;

  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(
    public.gbrain_search_vector(v_carol_key, (SELECT array_agg(x) FROM (SELECT 1.0::float8 AS x UNION ALL SELECT 0.0 FROM generate_series(1,1535)) s), 5)
  ) e;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T9b vector search leaked unshared chunk'; END IF;

  ---------------------------------------------------------------------------
  -- 10. whoami + invalid-key surface
  ---------------------------------------------------------------------------
  v_res := public.gbrain_whoami(v_bob_key);
  IF v_res->>'handle' <> 'bob' THEN RAISE EXCEPTION 'T10a whoami wrong handle'; END IF;
  IF NOT (v_res->'teams') @> '["builders"]'::jsonb THEN RAISE EXCEPTION 'T10b whoami missing team'; END IF;

  v_threw := false;
  BEGIN
    v_res := public.gbrain_whoami('gbk_' || repeat('f', 40));
  EXCEPTION WHEN OTHERS THEN v_threw := true; END;
  IF NOT v_threw THEN RAISE EXCEPTION 'T10c whoami accepted bogus key'; END IF;

  ---------------------------------------------------------------------------
  -- 11. RLS posture: sharing tables locked down; anon can't touch gbrain
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='gbrain' AND c.relkind='r' AND NOT c.relrowsecurity;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T11a % gbrain tables without RLS', v_cnt; END IF;

  IF has_table_privilege('anon', 'gbrain.users', 'SELECT') THEN RAISE EXCEPTION 'T11b anon can SELECT gbrain.users'; END IF;
  IF has_table_privilege('anon', 'gbrain.api_keys', 'SELECT') THEN RAISE EXCEPTION 'T11c anon can SELECT gbrain.api_keys'; END IF;
  IF NOT has_function_privilege('anon', 'public.gbrain_whoami(text)', 'EXECUTE') THEN RAISE EXCEPTION 'T11d anon cannot EXECUTE whoami RPC'; END IF;
  IF NOT has_function_privilege('anon', 'public.gbrain_search_shared(text,text,integer)', 'EXECUTE') THEN RAISE EXCEPTION 'T11e anon cannot EXECUTE search RPC'; END IF;

  RAISE NOTICE 'ALL SHARING-LAYER TESTS PASSED';
END
$test$;

ROLLBACK;
SELECT 'test transaction rolled back (fixtures discarded)' AS note;
