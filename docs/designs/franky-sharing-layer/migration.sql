-- franky sharing layer — users / teams / API keys / per-page shares
-- for the gbrain schema on the franky Supabase project.
--
-- Access model:
--   * The gbrain engine connects over the Postgres wire as `postgres`
--     (BYPASSRLS) — nothing here affects it.
--   * External consumers (future CLI/skills) call SECURITY DEFINER RPCs in
--     `public` (PostgREST-exposed) with the project's publishable key plus a
--     per-user API key argument. The gbrain schema itself is NOT exposed to
--     PostgREST and anon has no USAGE on it.
--   * RLS is enabled on every gbrain-schema table with no permissive
--     policies: deny-by-default for any future non-BYPASSRLS role;
--     enforcement for RPC callers lives in the RPCs' own visibility joins.
--   * Verified by tests.sql (run, then rolled back). Apply via Supabase MCP
--     apply_migration or psql as postgres.

-- ---------------------------------------------------------------------------
-- 1. Page ownership (NULL = brain owner; the engine never sets it)
-- ---------------------------------------------------------------------------
ALTER TABLE gbrain.pages ADD COLUMN IF NOT EXISTS owner_user_id uuid;
COMMENT ON COLUMN gbrain.pages.owner_user_id IS
  'Sharing layer: user who created this page via RPC (NULL = brain owner). FK added after users table below.';

-- ---------------------------------------------------------------------------
-- 2. Identity + grant tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbrain.users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle       text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9_-]{1,31}$'),
  display_name text,
  email        text UNIQUE,
  disabled_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE gbrain.users IS 'Sharing layer: humans/agents that authenticate with API keys.';

CREATE TABLE IF NOT EXISTS gbrain.teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{1,31}$'),
  name          text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES gbrain.users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE gbrain.teams IS 'Sharing layer: named groups content can be shared with.';

CREATE TABLE IF NOT EXISTS gbrain.team_members (
  team_id    uuid NOT NULL REFERENCES gbrain.teams(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES gbrain.users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  added_by   uuid REFERENCES gbrain.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS gbrain.api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES gbrain.users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_prefix   text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON gbrain.api_keys (key_prefix);
COMMENT ON TABLE gbrain.api_keys IS
  'Sharing layer: sha256(key) only — plaintext is returned once by admin_issue_api_key and never stored.';

CREATE TABLE IF NOT EXISTS gbrain.page_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         integer NOT NULL REFERENCES gbrain.pages(id) ON DELETE CASCADE,
  grantee_kind    text NOT NULL CHECK (grantee_kind IN ('user','team')),
  grantee_user_id uuid REFERENCES gbrain.users(id) ON DELETE CASCADE,
  grantee_team_id uuid REFERENCES gbrain.teams(id) ON DELETE CASCADE,
  permission      text NOT NULL DEFAULT 'read' CHECK (permission IN ('read','write')),
  created_by      uuid REFERENCES gbrain.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((grantee_kind = 'user') = (grantee_user_id IS NOT NULL)),
  CHECK ((grantee_kind = 'team') = (grantee_team_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS page_shares_user_uniq
  ON gbrain.page_shares (page_id, grantee_user_id) WHERE grantee_kind = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS page_shares_team_uniq
  ON gbrain.page_shares (page_id, grantee_team_id) WHERE grantee_kind = 'team';
CREATE INDEX IF NOT EXISTS page_shares_page_idx ON gbrain.page_shares (page_id);
COMMENT ON TABLE gbrain.page_shares IS
  'Sharing layer: per-page grants. Absence of a row = private. Owner chooses what to share.';

ALTER TABLE gbrain.pages
  DROP CONSTRAINT IF EXISTS pages_owner_user_id_fkey;
ALTER TABLE gbrain.pages
  ADD CONSTRAINT pages_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES gbrain.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pages_owner_idx ON gbrain.pages (owner_user_id) WHERE owner_user_id IS NOT NULL;

-- Source bucket for RPC-created notes (engine sources are code/memory imports)
INSERT INTO gbrain.sources (id, name, config, archived, trust_frontmatter_overrides, created_at)
VALUES ('user-notes', 'user-notes', '{"federated": false}'::jsonb, false, false, now())
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Auth + ACL helpers (gbrain schema — NOT REST-exposed)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gbrain.resolve_api_key(p_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = gbrain, extensions, pg_catalog AS $$
DECLARE v_key_id uuid; v_user uuid;
BEGIN
  IF p_key IS NULL OR p_key !~ '^gbk_[0-9a-f]{40}$' THEN RETURN NULL; END IF;
  SELECT k.id, k.user_id INTO v_key_id, v_user
    FROM gbrain.api_keys k
    JOIN gbrain.users u ON u.id = k.user_id
   WHERE k.key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')
     AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > now())
     AND u.disabled_at IS NULL;
  IF v_key_id IS NULL THEN RETURN NULL; END IF;
  -- last_used_at, throttled to one write per minute per key. Best-effort:
  -- PostgREST executes STABLE RPCs in a READ ONLY transaction, and auth
  -- must not fail just because the telemetry stamp can't be written.
  BEGIN
    UPDATE gbrain.api_keys SET last_used_at = now()
     WHERE id = v_key_id AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds');
  EXCEPTION WHEN read_only_sql_transaction THEN
    NULL;
  END;
  RETURN v_user;
END $$;

CREATE OR REPLACE FUNCTION gbrain.require_user(p_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
DECLARE v_user uuid;
BEGIN
  v_user := gbrain.resolve_api_key(p_key);
  IF v_user IS NULL THEN RAISE EXCEPTION 'invalid_api_key'; END IF;
  RETURN v_user;
END $$;

CREATE OR REPLACE FUNCTION gbrain.user_team_ids(p_user uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
  SELECT team_id FROM gbrain.team_members WHERE user_id = p_user
$$;

-- Flattened ACL: every page p_user can see, with the strongest permission.
-- 'write' > 'read' compares correctly as text.
CREATE OR REPLACE FUNCTION gbrain.visible_pages(p_user uuid)
RETURNS TABLE (page_id integer, permission text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
  SELECT v.page_id, max(v.permission) AS permission FROM (
    SELECT p.id AS page_id, 'write'::text AS permission
      FROM gbrain.pages p
     WHERE p.owner_user_id = p_user AND p.deleted_at IS NULL
    UNION ALL
    SELECT s.page_id, s.permission
      FROM gbrain.page_shares s
      JOIN gbrain.pages p ON p.id = s.page_id AND p.deleted_at IS NULL
     WHERE (s.grantee_kind = 'user' AND s.grantee_user_id = p_user)
        OR (s.grantee_kind = 'team' AND s.grantee_team_id IN (SELECT gbrain.user_team_ids(p_user)))
  ) v GROUP BY v.page_id
$$;

-- ---------------------------------------------------------------------------
-- 4. Admin helpers (wire-protocol only: Frank via psql/MCP/gbrain CLI)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gbrain.admin_create_user(p_handle text, p_display_name text DEFAULT NULL, p_email text DEFAULT NULL)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
  INSERT INTO gbrain.users (handle, display_name, email)
  VALUES (p_handle, p_display_name, p_email)
  RETURNING id
$$;

CREATE OR REPLACE FUNCTION gbrain.admin_create_team(p_slug text, p_name text, p_owner_handle text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
DECLARE v_owner uuid; v_team uuid;
BEGIN
  SELECT id INTO v_owner FROM gbrain.users WHERE handle = p_owner_handle;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'unknown_user: %', p_owner_handle; END IF;
  INSERT INTO gbrain.teams (slug, name, owner_user_id) VALUES (p_slug, p_name, v_owner) RETURNING id INTO v_team;
  INSERT INTO gbrain.team_members (team_id, user_id, role, added_by) VALUES (v_team, v_owner, 'owner', v_owner);
  RETURN v_team;
END $$;

CREATE OR REPLACE FUNCTION gbrain.admin_add_member(p_team_slug text, p_handle text, p_role text DEFAULT 'member')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
DECLARE v_team uuid; v_user uuid;
BEGIN
  SELECT id INTO v_team FROM gbrain.teams WHERE slug = p_team_slug;
  IF v_team IS NULL THEN RAISE EXCEPTION 'unknown_team: %', p_team_slug; END IF;
  SELECT id INTO v_user FROM gbrain.users WHERE handle = p_handle;
  IF v_user IS NULL THEN RAISE EXCEPTION 'unknown_user: %', p_handle; END IF;
  INSERT INTO gbrain.team_members (team_id, user_id, role)
  VALUES (v_team, v_user, p_role)
  ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role;
END $$;

-- Returns the plaintext key EXACTLY ONCE. Only the sha256 lands on disk.
CREATE OR REPLACE FUNCTION gbrain.admin_issue_api_key(p_handle text, p_name text, p_ttl interval DEFAULT NULL)
RETURNS TABLE (api_key text, key_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = gbrain, extensions, pg_catalog AS $$
DECLARE v_user uuid; v_raw text; v_id uuid;
BEGIN
  SELECT id INTO v_user FROM gbrain.users WHERE handle = p_handle;
  IF v_user IS NULL THEN RAISE EXCEPTION 'unknown_user: %', p_handle; END IF;
  v_raw := 'gbk_' || encode(extensions.gen_random_bytes(20), 'hex');
  INSERT INTO gbrain.api_keys (user_id, name, key_prefix, key_hash, expires_at)
  VALUES (v_user, p_name, left(v_raw, 12),
          encode(extensions.digest(v_raw, 'sha256'), 'hex'),
          CASE WHEN p_ttl IS NULL THEN NULL ELSE now() + p_ttl END)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_raw, v_id;
END $$;

CREATE OR REPLACE FUNCTION gbrain.admin_revoke_api_key(p_key_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
  UPDATE gbrain.api_keys SET revoked_at = now() WHERE id = p_key_id AND revoked_at IS NULL
$$;

-- Share a brain-owner page (owner_user_id IS NULL) — the RPC surface only
-- lets users share pages they own.
CREATE OR REPLACE FUNCTION gbrain.admin_share_page(p_slug text, p_grantee_kind text, p_grantee text, p_permission text DEFAULT 'read')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
DECLARE v_page integer;
BEGIN
  SELECT id INTO v_page FROM gbrain.pages WHERE slug = p_slug AND deleted_at IS NULL;
  IF v_page IS NULL THEN RAISE EXCEPTION 'unknown_page: %', p_slug; END IF;
  PERFORM gbrain.upsert_share(v_page, p_grantee_kind, p_grantee, p_permission, NULL);
END $$;

-- Shared grant-upsert used by both the admin path and the RPC path.
CREATE OR REPLACE FUNCTION gbrain.upsert_share(p_page integer, p_grantee_kind text, p_grantee text, p_permission text, p_created_by uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
DECLARE v_user uuid; v_team uuid;
BEGIN
  IF p_grantee_kind = 'user' THEN
    SELECT id INTO v_user FROM gbrain.users WHERE handle = p_grantee;
    IF v_user IS NULL THEN RAISE EXCEPTION 'unknown_user: %', p_grantee; END IF;
    INSERT INTO gbrain.page_shares (page_id, grantee_kind, grantee_user_id, permission, created_by)
    VALUES (p_page, 'user', v_user, p_permission, p_created_by)
    ON CONFLICT (page_id, grantee_user_id) WHERE grantee_kind = 'user'
    DO UPDATE SET permission = EXCLUDED.permission;
  ELSIF p_grantee_kind = 'team' THEN
    SELECT id INTO v_team FROM gbrain.teams WHERE slug = p_grantee;
    IF v_team IS NULL THEN RAISE EXCEPTION 'unknown_team: %', p_grantee; END IF;
    INSERT INTO gbrain.page_shares (page_id, grantee_kind, grantee_team_id, permission, created_by)
    VALUES (p_page, 'team', v_team, p_permission, p_created_by)
    ON CONFLICT (page_id, grantee_team_id) WHERE grantee_kind = 'team'
    DO UPDATE SET permission = EXCLUDED.permission;
  ELSE
    RAISE EXCEPTION 'invalid_grantee_kind: %', p_grantee_kind;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Public RPC surface (PostgREST-exposed; publishable key + per-user API key)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gbrain_whoami(p_api_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
DECLARE v_user uuid;
BEGIN
  v_user := gbrain.require_user(p_api_key);
  RETURN (
    SELECT jsonb_build_object(
      'user_id', u.id, 'handle', u.handle, 'display_name', u.display_name,
      'teams', COALESCE((SELECT jsonb_agg(t.slug ORDER BY t.slug)
                           FROM gbrain.team_members m JOIN gbrain.teams t ON t.id = m.team_id
                          WHERE m.user_id = u.id), '[]'::jsonb))
    FROM gbrain.users u WHERE u.id = v_user);
END $$;

CREATE OR REPLACE FUNCTION public.gbrain_list_shared(p_api_key text, p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
DECLARE v_user uuid;
BEGIN
  v_user := gbrain.require_user(p_api_key);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'slug', p.slug, 'title', p.title, 'type', p.type,
             'permission', vp.permission,
             'via', CASE WHEN p.owner_user_id = v_user THEN 'owner' ELSE 'share' END,
             'updated_at', p.updated_at) ORDER BY p.updated_at DESC)
    FROM (SELECT * FROM gbrain.visible_pages(v_user) ORDER BY page_id LIMIT LEAST(p_limit, 200) OFFSET GREATEST(p_offset, 0)) vp
    JOIN gbrain.pages p ON p.id = vp.page_id
  ), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.gbrain_get_page(p_api_key text, p_slug text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
DECLARE v_user uuid; v_out jsonb;
BEGIN
  v_user := gbrain.require_user(p_api_key);
  SELECT jsonb_build_object(
           'slug', p.slug, 'title', p.title, 'type', p.type,
           'content', p.compiled_truth, 'frontmatter', p.frontmatter,
           'permission', vp.permission, 'updated_at', p.updated_at)
    INTO v_out
    FROM gbrain.pages p
    JOIN gbrain.visible_pages(v_user) vp ON vp.page_id = p.id
   WHERE p.slug = p_slug;
  -- Missing and unpermitted are indistinguishable on purpose (no existence leak).
  IF v_out IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION public.gbrain_search_shared(p_api_key text, p_query text, p_limit int DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
DECLARE v_user uuid;
BEGIN
  v_user := gbrain.require_user(p_api_key);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'slug', p.slug, 'title', p.title, 'permission', vp.permission,
             'rank', round(ts_rank(p.search_vector, q)::numeric, 6)) ORDER BY ts_rank(p.search_vector, q) DESC)
    FROM websearch_to_tsquery('english', p_query) q,
         gbrain.visible_pages(v_user) vp
    JOIN gbrain.pages p ON p.id = vp.page_id
    WHERE p.search_vector @@ q
    LIMIT LEAST(p_limit, 100)
  ), '[]'::jsonb);
END $$;

-- Client-side query embedding (the CLI embeds via DashScope itself), server-side
-- permission-filtered cosine search over content_chunks.
CREATE OR REPLACE FUNCTION public.gbrain_search_vector(p_api_key text, p_embedding float8[], p_limit int DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = gbrain, extensions, pg_catalog AS $$
DECLARE v_user uuid; v_vec extensions.vector;
BEGIN
  v_user := gbrain.require_user(p_api_key);
  IF p_embedding IS NULL OR array_length(p_embedding, 1) <> 1536 THEN
    RAISE EXCEPTION 'embedding_must_be_1536_dims';
  END IF;
  v_vec := p_embedding::extensions.vector(1536);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'slug', s.slug, 'title', s.title, 'permission', s.permission,
             'chunk', left(s.chunk_text, 500), 'distance', round(s.dist::numeric, 6)) ORDER BY s.dist ASC)
    FROM (
      SELECT p.slug, p.title, vp.permission, c.chunk_text, (c.embedding <=> v_vec) AS dist
        FROM gbrain.visible_pages(v_user) vp
        JOIN gbrain.pages p ON p.id = vp.page_id
        JOIN gbrain.content_chunks c ON c.page_id = p.id
       WHERE c.embedding IS NOT NULL
       ORDER BY c.embedding <=> v_vec
       LIMIT LEAST(p_limit, 100)
    ) s
  ), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.gbrain_put_note(p_api_key text, p_title text, p_content text, p_type text DEFAULT 'note')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = gbrain, extensions, pg_catalog AS $$
DECLARE v_user uuid; v_handle text; v_slug text; v_id integer;
BEGIN
  v_user := gbrain.require_user(p_api_key);
  IF p_title IS NULL OR length(trim(p_title)) = 0 THEN RAISE EXCEPTION 'title_required'; END IF;
  IF length(coalesce(p_content, '')) > 262144 THEN RAISE EXCEPTION 'content_too_large'; END IF;
  SELECT handle INTO v_handle FROM gbrain.users WHERE id = v_user;
  v_slug := 'notes/' || v_handle || '/'
         || left(regexp_replace(lower(trim(p_title)), '[^a-z0-9]+', '-', 'g'), 48)
         || '-' || encode(extensions.gen_random_bytes(3), 'hex');
  INSERT INTO gbrain.pages (source_id, slug, type, title, compiled_truth, owner_user_id)
  VALUES ('user-notes', v_slug, p_type, trim(p_title), coalesce(p_content, ''), v_user)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('slug', v_slug, 'id', v_id, 'title', trim(p_title));
END $$;

CREATE OR REPLACE FUNCTION public.gbrain_share_page(p_api_key text, p_slug text, p_grantee_kind text, p_grantee text, p_permission text DEFAULT 'read')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
DECLARE v_user uuid; v_page integer;
BEGIN
  v_user := gbrain.require_user(p_api_key);
  IF p_permission NOT IN ('read', 'write') THEN RAISE EXCEPTION 'invalid_permission'; END IF;
  -- Only the page OWNER may share it (brain-owner pages go through gbrain.admin_share_page).
  SELECT id INTO v_page FROM gbrain.pages WHERE slug = p_slug AND owner_user_id = v_user AND deleted_at IS NULL;
  IF v_page IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  PERFORM gbrain.upsert_share(v_page, p_grantee_kind, p_grantee, p_permission, v_user);
END $$;

CREATE OR REPLACE FUNCTION public.gbrain_unshare_page(p_api_key text, p_slug text, p_grantee_kind text, p_grantee text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = gbrain, pg_catalog AS $$
DECLARE v_user uuid; v_page integer;
BEGIN
  v_user := gbrain.require_user(p_api_key);
  SELECT id INTO v_page FROM gbrain.pages WHERE slug = p_slug AND owner_user_id = v_user AND deleted_at IS NULL;
  IF v_page IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF p_grantee_kind = 'user' THEN
    DELETE FROM gbrain.page_shares s USING gbrain.users u
     WHERE s.page_id = v_page AND s.grantee_kind = 'user' AND s.grantee_user_id = u.id AND u.handle = p_grantee;
  ELSIF p_grantee_kind = 'team' THEN
    DELETE FROM gbrain.page_shares s USING gbrain.teams t
     WHERE s.page_id = v_page AND s.grantee_kind = 'team' AND s.grantee_team_id = t.id AND t.slug = p_grantee;
  ELSE
    RAISE EXCEPTION 'invalid_grantee_kind: %', p_grantee_kind;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Helper views (wire-protocol convenience; security_invoker so they never
--    become a definer-leak if a future role gets schema USAGE)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW gbrain.v_page_access WITH (security_invoker = on) AS
  SELECT u.id AS user_id, u.handle, vp.page_id, vp.permission, p.slug, p.title
    FROM gbrain.users u
    CROSS JOIN LATERAL gbrain.visible_pages(u.id) vp
    JOIN gbrain.pages p ON p.id = vp.page_id;

CREATE OR REPLACE VIEW gbrain.v_team_rosters WITH (security_invoker = on) AS
  SELECT t.slug AS team, t.name, u.handle, m.role, m.created_at AS member_since
    FROM gbrain.teams t
    JOIN gbrain.team_members m ON m.team_id = t.id
    JOIN gbrain.users u ON u.id = m.user_id;

-- ---------------------------------------------------------------------------
-- 7. RLS: deny-by-default on EVERY gbrain table (engine role has BYPASSRLS;
--    migration v35's auto-RLS event trigger only covers public, so the doctor
--    rls check would otherwise flag the whole schema)
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'gbrain' AND c.relkind = 'r' AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE gbrain.%I ENABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Grants: RPCs callable by the REST roles; nothing else reachable
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA gbrain FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION
  gbrain.resolve_api_key(text), gbrain.require_user(text), gbrain.user_team_ids(uuid),
  gbrain.visible_pages(uuid), gbrain.upsert_share(integer, text, text, text, uuid),
  gbrain.admin_create_user(text, text, text), gbrain.admin_create_team(text, text, text),
  gbrain.admin_add_member(text, text, text), gbrain.admin_issue_api_key(text, text, interval),
  gbrain.admin_revoke_api_key(uuid), gbrain.admin_share_page(text, text, text, text)
FROM PUBLIC, anon, authenticated;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.gbrain_whoami(text)',
    'public.gbrain_list_shared(text, integer, integer)',
    'public.gbrain_get_page(text, text)',
    'public.gbrain_search_shared(text, text, integer)',
    'public.gbrain_search_vector(text, float8[], integer)',
    'public.gbrain_put_note(text, text, text, text)',
    'public.gbrain_share_page(text, text, text, text, text)',
    'public.gbrain_unshare_page(text, text, text, text)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated, service_role', fn);
  END LOOP;
END $$;
