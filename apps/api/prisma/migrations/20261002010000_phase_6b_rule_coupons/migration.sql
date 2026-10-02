BEGIN;

-- Additive Prisma schema diff, qualified to public. No Auth/Storage DDL or data backfill.
CREATE TYPE public.coupon_source AS ENUM ('RULE', 'CAMPAIGN', 'MANUAL');
CREATE TYPE public.coupon_status AS ENUM ('ISSUED', 'REDEEMED', 'EXPIRED', 'REVOKED');
CREATE TABLE public.coupons (
  id uuid NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL,
  source public.coupon_source NOT NULL,
  public_code varchar(32) NOT NULL,
  status public.coupon_status NOT NULL,
  issued_at timestamptz(6) NOT NULL,
  expires_at timestamptz(6),
  issuance_key varchar(200) NOT NULL,
  eligibility_snapshot jsonb NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT coupons_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT coupons_rule_only_check CHECK (source = 'RULE'),
  CONSTRAINT coupons_expiry_check CHECK (expires_at IS NULL OR expires_at > issued_at),
  CONSTRAINT coupons_code_check CHECK (public_code ~ '^[A-Za-z0-9_-]{32}$')
);
CREATE TABLE public.coupon_rule_origins (
  coupon_id uuid NOT NULL PRIMARY KEY,
  reward_rule_id uuid NOT NULL,
  CONSTRAINT coupon_rule_origins_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupons(id)
    ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT coupon_rule_origins_reward_rule_id_fkey FOREIGN KEY (reward_rule_id) REFERENCES public.reward_rules(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX coupons_public_code_key ON public.coupons(public_code);
CREATE UNIQUE INDEX coupons_issuance_key_key ON public.coupons(issuance_key);
CREATE INDEX coupons_user_id_status_expires_at_idx ON public.coupons(user_id, status, expires_at);
CREATE INDEX coupon_rule_origins_reward_rule_id_coupon_id_idx ON public.coupon_rule_origins(reward_rule_id, coupon_id);

-- Validate a versioned historical decision, including every counted visit. Invalid
-- casts return false; missing properties/JSON null must not pass through SQL UNKNOWN.
CREATE FUNCTION public.valid_rule_snapshot(s jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v jsonb; previous_time timestamptz; previous_id uuid; visit_time timestamptz;
  ids uuid[] := ARRAY[]::uuid[]; evaluated timestamptz; spacing integer;
BEGIN
  IF NOT COALESCE(jsonb_typeof(s) = 'object' AND s->'schemaVersion' = '1'::jsonb
    AND s->>'source' = 'RULE' AND s->'eligible' = 'true'::jsonb
    AND jsonb_typeof(s->'rule') = 'object' AND jsonb_typeof(s->'scope') = 'object'
    AND jsonb_typeof(s->'rewardWindow') = 'object'
    AND jsonb_typeof(s->'countedVisits') = 'array'
    AND jsonb_typeof(s->'scope'->'locationIds') = 'array'
    AND s->'rule'->>'metric' = 'VISIT_COUNT' AND s->'rule'->>'operator' = 'GTE'
    AND s->'rule'->'maxAwardsPerUser' = '1'::jsonb
    AND jsonb_typeof(s->'rule'->'threshold') = 'number'
    AND (s->'rule'->>'threshold') ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(s->'rule'->'minVisitSpacingHours') = 'number'
    AND (s->'rule'->>'minVisitSpacingHours') ~ '^(0|[1-9][0-9]*)$'
    AND (s->'rule'->'windowDays' = 'null'::jsonb OR
      (jsonb_typeof(s->'rule'->'windowDays') = 'number' AND (s->'rule'->>'windowDays') ~ '^[1-9][0-9]*$'))
    AND jsonb_typeof(s->'count') = 'number' AND (s->>'count') ~ '^[1-9][0-9]*$'
    AND (s->>'count')::integer = jsonb_array_length(s->'countedVisits')
    AND (s->>'count')::integer >= (s->'rule'->>'threshold')::integer
    AND s->'rule' ?& ARRAY['startsAt','endsAt']
    AND s->'rewardWindow' ?& ARRAY['startsAt','endsAt'], false) THEN RETURN false; END IF;
  IF NOT COALESCE((s->>'userId')::uuid IS NOT NULL AND (s->>'rewardRuleId')::uuid IS NOT NULL
    AND (s->>'rewardId')::uuid IS NOT NULL AND (s->>'triggeringVisitId')::uuid IS NOT NULL
    AND (s->'scope'->>'restaurantId')::uuid IS NOT NULL, false) THEN RETURN false; END IF;
  evaluated := (s->>'evaluatedAt')::timestamptz;
  spacing := (s->'rule'->>'minVisitSpacingHours')::integer;
  IF evaluated IS NULL OR NOT isfinite(evaluated) THEN RETURN false; END IF;
  FOREACH v IN ARRAY ARRAY[s->'rule', s->'rewardWindow'] LOOP
    IF (v->>'startsAt')::timestamptz > evaluated OR (v->>'endsAt')::timestamptz <= evaluated THEN RETURN false; END IF;
  END LOOP;
  FOR v IN SELECT value FROM jsonb_array_elements(s->'scope'->'locationIds') LOOP
    IF jsonb_typeof(v) <> 'string' OR (v #>> '{}')::uuid IS NULL THEN RETURN false; END IF;
  END LOOP;
  FOR v IN SELECT value FROM jsonb_array_elements(s->'countedVisits') LOOP
    visit_time := (v->>'checkedInAt')::timestamptz;
    IF NOT COALESCE(jsonb_typeof(v) = 'object' AND (v->>'id')::uuid IS NOT NULL
      AND (v->>'locationId')::uuid IS NOT NULL AND visit_time IS NOT NULL
      AND isfinite(visit_time) AND visit_time <= evaluated, false) THEN RETURN false; END IF;
    IF (v->>'id')::uuid = ANY(ids) OR
      visit_time < evaluated - (s->'rule'->>'windowDays')::integer * interval '24 hours' OR
      (previous_time IS NOT NULL AND (visit_time < previous_time + spacing * interval '1 hour'
        OR (visit_time = previous_time AND (v->>'id')::uuid <= previous_id))) THEN RETURN false; END IF;
    ids := array_append(ids, (v->>'id')::uuid);
    previous_id := (v->>'id')::uuid; previous_time := visit_time;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
ALTER TABLE public.coupons ADD CONSTRAINT coupons_snapshot_check CHECK (public.valid_rule_snapshot(eligibility_snapshot));

CREATE FUNCTION public.coupon_immutable_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','updated_at']) THEN
    RAISE EXCEPTION 'Coupon identity and issuance facts are immutable' USING ERRCODE = '23514', CONSTRAINT = 'coupons_immutable_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER coupons_immutable BEFORE UPDATE ON public.coupons FOR EACH ROW EXECUTE FUNCTION public.coupon_immutable_guard();
CREATE TRIGGER coupons_updated_at BEFORE UPDATE ON public.coupons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Definition updates already own the row lock; first issuance takes/writes the
-- same rows. Fresh RC reads see the winner, RR writers get serialization failure.
CREATE FUNCTION public.published_reward_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','updated_at'])
    AND EXISTS (SELECT 1 FROM public.coupon_rule_origins o JOIN public.reward_rules rr ON rr.id = o.reward_rule_id WHERE rr.reward_id = OLD.id) THEN
    RAISE EXCEPTION 'Issued reward conditions are immutable' USING ERRCODE = '23514', CONSTRAINT = 'rewards_published_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.published_rule_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','updated_at'])
    AND EXISTS (SELECT 1 FROM public.coupon_rule_origins WHERE reward_rule_id = OLD.id) THEN
    RAISE EXCEPTION 'Issued rule conditions are immutable' USING ERRCODE = '23514', CONSTRAINT = 'reward_rules_published_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.published_selection_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE owners uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Alphabetically after reward_locations_lock, which writes both owners first.
  IF TG_OP <> 'INSERT' THEN owners := array_append(owners, OLD.reward_id); END IF;
  IF TG_OP <> 'DELETE' THEN owners := array_append(owners, NEW.reward_id); END IF;
  IF EXISTS (SELECT 1 FROM public.coupon_rule_origins o JOIN public.reward_rules r ON r.id = o.reward_rule_id WHERE r.reward_id = ANY(owners)) THEN
    RAISE EXCEPTION 'Issued reward selections are immutable' USING ERRCODE = '23514', CONSTRAINT = 'reward_locations_published_check';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rewards_published BEFORE UPDATE ON public.rewards FOR EACH ROW EXECUTE FUNCTION public.published_reward_guard();
CREATE TRIGGER reward_rules_published BEFORE UPDATE ON public.reward_rules FOR EACH ROW EXECUTE FUNCTION public.published_rule_guard();
CREATE TRIGGER reward_locations_published BEFORE INSERT OR UPDATE OR DELETE ON public.reward_locations FOR EACH ROW EXECUTE FUNCTION public.published_selection_guard();

CREATE FUNCTION public.coupon_rule_origin_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE owner_id uuid; locked_owner uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Coupon origin is immutable' USING ERRCODE = '23514', CONSTRAINT = 'coupon_rule_origin_immutable_check';
    END IF;
    RETURN NEW;
  END IF;
  SELECT reward_id INTO owner_id FROM public.reward_rules WHERE id = NEW.reward_rule_id;
  UPDATE public.rewards SET updated_at = clock_timestamp() WHERE id = owner_id;
  UPDATE public.reward_rules SET updated_at = clock_timestamp() WHERE id = NEW.reward_rule_id RETURNING reward_id INTO locked_owner;
  IF locked_owner IS DISTINCT FROM owner_id THEN
    RAISE EXCEPTION 'Definition changed during issuance; retry transaction' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER coupon_rule_origins_lock BEFORE INSERT OR UPDATE ON public.coupon_rule_origins FOR EACH ROW EXECUTE FUNCTION public.coupon_rule_origin_guard();

CREATE FUNCTION public.enforce_coupon_rule_origin() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE target uuid; c public.coupons; rule public.reward_rules; reward public.rewards; s jsonb; selections jsonb;
BEGIN
  IF TG_TABLE_NAME = 'coupons' THEN
    IF TG_OP = 'DELETE' THEN target := OLD.id; ELSE target := NEW.id; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN target := OLD.coupon_id; ELSE target := NEW.coupon_id; END IF;
  END IF;
  SELECT * INTO c FROM public.coupons WHERE id = target;
  IF NOT FOUND THEN RETURN NULL; END IF; -- Only atomic parent+origin maintenance deletion is possible.
  IF TG_TABLE_NAME = 'coupon_rule_origins' AND TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot remove or replace the origin of a surviving coupon' USING ERRCODE = '23514', CONSTRAINT = 'coupon_rule_origin_immutable_check';
  END IF;
  SELECT rr.* INTO rule FROM public.coupon_rule_origins o JOIN public.reward_rules rr ON rr.id = o.reward_rule_id WHERE o.coupon_id = target;
  IF NOT FOUND OR c.source <> 'RULE' THEN
    RAISE EXCEPTION 'Exactly one RULE origin is required' USING ERRCODE = '23514', CONSTRAINT = 'coupons_exact_origin_check';
  END IF;
  IF c.issuance_key <> 'rule:' || rule.id::text || ':user:' || c.user_id::text THEN
    RAISE EXCEPTION 'Issuance key must identify the rule and recipient' USING ERRCODE = '23514', CONSTRAINT = 'coupons_issuance_key_check';
  END IF;
  SELECT * INTO reward FROM public.rewards WHERE id = rule.reward_id;
  SELECT COALESCE(jsonb_agg(location_id::text ORDER BY location_id), '[]'::jsonb) INTO selections FROM public.reward_locations WHERE reward_id = reward.id;
  s := c.eligibility_snapshot;
  IF (s->>'userId')::uuid IS DISTINCT FROM c.user_id OR (s->>'rewardRuleId')::uuid IS DISTINCT FROM rule.id
    OR (s->>'rewardId')::uuid IS DISTINCT FROM reward.id OR (s->>'evaluatedAt')::timestamptz IS DISTINCT FROM c.issued_at
    OR (s->'scope'->>'restaurantId')::uuid IS DISTINCT FROM reward.restaurant_id
    OR s->'scope'->'locationIds' IS DISTINCT FROM selections
    OR (s->'rule'->>'threshold')::integer IS DISTINCT FROM rule.threshold
    OR (s->'rule'->>'windowDays')::integer IS DISTINCT FROM rule.window_days
    OR (s->'rule'->>'minVisitSpacingHours')::integer IS DISTINCT FROM rule.min_visit_spacing_hours
    OR (s->'rule'->>'startsAt')::timestamptz IS DISTINCT FROM rule.starts_at
    OR (s->'rule'->>'endsAt')::timestamptz IS DISTINCT FROM rule.ends_at
    OR (s->'rewardWindow'->>'startsAt')::timestamptz IS DISTINCT FROM reward.starts_at
    OR (s->'rewardWindow'->>'endsAt')::timestamptz IS DISTINCT FROM reward.ends_at
    OR c.expires_at IS DISTINCT FROM c.issued_at + reward.valid_days_after_issue * interval '24 hours' THEN
    RAISE EXCEPTION 'Snapshot or expiry does not match issuance conditions' USING ERRCODE = '23514', CONSTRAINT = 'coupons_snapshot_origin_check';
  END IF;
  -- Validate the recorded facts at issuance only; never reconstruct historical
  -- snapshots on subsequent status changes.
  IF TG_OP = 'INSERT' THEN
    IF rule.status <> 'ACTIVE' OR reward.status <> 'ACTIVE'
      OR NOT EXISTS (SELECT 1 FROM public.visits v JOIN public.restaurant_locations l ON l.id = v.location_id
        WHERE v.id = (s->>'triggeringVisitId')::uuid AND v.user_id = c.user_id AND v.status = 'VERIFIED'
        AND l.restaurant_id = reward.restaurant_id AND (selections = '[]'::jsonb OR selections ? v.location_id::text))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'countedVisits') fact WHERE NOT EXISTS (
        SELECT 1 FROM public.visits v JOIN public.restaurant_locations l ON l.id = v.location_id
        WHERE v.id = (fact->>'id')::uuid AND v.user_id = c.user_id AND v.status = 'VERIFIED'
          AND v.location_id = (fact->>'locationId')::uuid AND date_trunc('milliseconds', v.checked_in_at) = (fact->>'checkedInAt')::timestamptz
          AND l.restaurant_id = reward.restaurant_id AND (selections = '[]'::jsonb OR selections ? v.location_id::text))) THEN
      RAISE EXCEPTION 'Snapshot must describe verified recipient visits in scope' USING ERRCODE = '23514', CONSTRAINT = 'coupons_snapshot_facts_check';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER coupons_exact_origin AFTER INSERT OR UPDATE OR DELETE ON public.coupons
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_coupon_rule_origin();
CREATE CONSTRAINT TRIGGER coupon_rule_origins_exact_origin AFTER INSERT OR UPDATE OR DELETE ON public.coupon_rule_origins
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_coupon_rule_origin();

-- Prevent TRUNCATE from bypassing deferred origin checks/publication guards.
CREATE TRIGGER coupons_no_truncate BEFORE TRUNCATE ON public.coupons FOR EACH STATEMENT EXECUTE FUNCTION public.reject_reward_selection_truncate();
CREATE TRIGGER coupon_rule_origins_no_truncate BEFORE TRUNCATE ON public.coupon_rule_origins FOR EACH STATEMENT EXECUTE FUNCTION public.reject_reward_selection_truncate();
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_rule_origins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.coupons, public.coupon_rule_origins FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.valid_rule_snapshot(jsonb), public.coupon_immutable_guard(), public.published_reward_guard(),
  public.published_rule_guard(), public.published_selection_guard(), public.coupon_rule_origin_guard(), public.enforce_coupon_rule_origin()
  FROM PUBLIC, anon, authenticated;

COMMIT;
