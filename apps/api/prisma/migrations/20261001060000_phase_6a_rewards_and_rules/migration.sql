BEGIN;

-- Prisma schema-to-schema diff, explicitly qualified to public; no existing table DDL.
CREATE TYPE public.reward_type AS ENUM ('FREE_ITEM', 'PERCENT_DISCOUNT', 'FIXED_DISCOUNT', 'CUSTOM');
CREATE TYPE public.lifecycle_status AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');
CREATE TYPE public.rule_metric AS ENUM ('VISIT_COUNT');
CREATE TYPE public.rule_operator AS ENUM ('GTE');

CREATE TABLE public.rewards (
    id UUID NOT NULL,
    restaurant_id UUID NOT NULL,
    name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    reward_type public.reward_type NOT NULL,
    value DECIMAL(12,2),
    currency CHAR(3),
    item_reference VARCHAR(100),
    terms_text TEXT NOT NULL,
    valid_days_after_issue SMALLINT,
    starts_at TIMESTAMPTZ(6),
    ends_at TIMESTAMPTZ(6),
    status public.lifecycle_status NOT NULL,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT rewards_pkey PRIMARY KEY (id)
);

CREATE TABLE public.reward_locations (
    reward_id UUID NOT NULL,
    location_id UUID NOT NULL,
    CONSTRAINT reward_locations_pkey PRIMARY KEY (reward_id, location_id)
);

CREATE TABLE public.reward_rules (
    id UUID NOT NULL,
    reward_id UUID NOT NULL,
    name VARCHAR(120) NOT NULL,
    metric public.rule_metric NOT NULL,
    operator public.rule_operator NOT NULL,
    threshold INTEGER NOT NULL,
    window_days SMALLINT,
    min_visit_spacing_hours SMALLINT NOT NULL,
    max_awards_per_user SMALLINT NOT NULL,
    starts_at TIMESTAMPTZ(6),
    ends_at TIMESTAMPTZ(6),
    status public.lifecycle_status NOT NULL,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT reward_rules_pkey PRIMARY KEY (id)
);

CREATE INDEX rewards_restaurant_id_status_idx ON public.rewards(restaurant_id, status);
CREATE INDEX reward_locations_location_id_reward_id_idx ON public.reward_locations(location_id, reward_id);
CREATE INDEX reward_rules_reward_id_status_idx ON public.reward_rules(reward_id, status);

ALTER TABLE public.rewards ADD CONSTRAINT rewards_restaurant_id_fkey
  FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public.reward_locations ADD CONSTRAINT reward_locations_reward_id_fkey
  FOREIGN KEY (reward_id) REFERENCES public.rewards(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public.reward_locations ADD CONSTRAINT reward_locations_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES public.restaurant_locations(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public.reward_rules ADD CONSTRAINT reward_rules_reward_id_fkey
  FOREIGN KEY (reward_id) REFERENCES public.rewards(id) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- v1.1 sections 8 and 10. Explicit NULL guards: PostgreSQL CHECK accepts UNKNOWN.
ALTER TABLE public.rewards
  ADD CONSTRAINT rewards_value_finite_check CHECK (value IS NULL OR value <> 'NaN'::numeric),
  ADD CONSTRAINT rewards_currency_check CHECK (currency IS NULL OR currency::text ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT rewards_type_values_check CHECK (
    (reward_type = 'PERCENT_DISCOUNT' AND value IS NOT NULL AND value > 0 AND value <= 100 AND currency IS NULL)
    OR (reward_type = 'FIXED_DISCOUNT' AND value IS NOT NULL AND value > 0 AND currency IS NOT NULL)
    OR (reward_type = 'FREE_ITEM' AND item_reference IS NOT NULL AND item_reference ~ '[^[:space:]]')
    OR (reward_type = 'CUSTOM' AND terms_text ~ '[^[:space:]]')
  ),
  -- An issued coupon's expiry must be strictly after issuance (v1.1 section 8).
  ADD CONSTRAINT rewards_valid_days_check CHECK (valid_days_after_issue IS NULL OR valid_days_after_issue > 0),
  ADD CONSTRAINT rewards_window_check CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at);

ALTER TABLE public.reward_rules
  ADD CONSTRAINT reward_rules_threshold_check CHECK (threshold > 0),
  ADD CONSTRAINT reward_rules_window_days_check CHECK (window_days IS NULL OR window_days > 0),
  ADD CONSTRAINT reward_rules_spacing_check CHECK (min_visit_spacing_hours >= 0),
  ADD CONSTRAINT reward_rules_max_awards_check CHECK (max_awards_per_user = 1),
  ADD CONSTRAINT reward_rules_window_check CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at);

CREATE TRIGGER rewards_updated_at BEFORE UPDATE ON public.rewards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER reward_rules_updated_at BEFORE UPDATE ON public.reward_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Lock/write both OLD and NEW owners in UUID order before changing selections.
-- The write, rather than just SELECT FOR UPDATE, also forces a retry on stale
-- REPEATABLE READ snapshots. Bulk callers must lock owners first, in UUID order;
-- retry the whole transaction on 40001/40P01. No cleanup or implicit scope changes.
CREATE FUNCTION public.lock_reward_selection() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  owner_ids uuid[] := ARRAY[]::uuid[];
  owner_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN owner_ids := array_append(owner_ids, OLD.reward_id); END IF;
  IF TG_OP <> 'DELETE' THEN owner_ids := array_append(owner_ids, NEW.reward_id); END IF;
  FOR owner_id IN SELECT DISTINCT id FROM unnest(owner_ids) AS owners(id) ORDER BY id LOOP
    UPDATE public.rewards SET updated_at = clock_timestamp() WHERE id = owner_id;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reward_locations_lock BEFORE INSERT OR UPDATE OR DELETE ON public.reward_locations
  FOR EACH ROW EXECUTE FUNCTION public.lock_reward_selection();

-- Revalidate final state after changing either a selection or its reward owner.
-- Location reassignment is already rejected by the Phase 1 immutable-owner trigger.
-- There is intentionally no minimum selection count: zero means all locations.
CREATE FUNCTION public.enforce_reward_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  owner_ids uuid[] := ARRAY[]::uuid[];
  owner_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'rewards' THEN
    IF TG_OP <> 'INSERT' THEN owner_ids := array_append(owner_ids, OLD.id); END IF;
    IF TG_OP <> 'DELETE' THEN owner_ids := array_append(owner_ids, NEW.id); END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN owner_ids := array_append(owner_ids, OLD.reward_id); END IF;
    IF TG_OP <> 'DELETE' THEN owner_ids := array_append(owner_ids, NEW.reward_id); END IF;
  END IF;
  FOR owner_id IN SELECT DISTINCT id FROM unnest(owner_ids) AS owners(id) ORDER BY id LOOP
    IF EXISTS (
      SELECT 1 FROM public.rewards r
      JOIN public.reward_locations selection ON selection.reward_id = r.id
      JOIN public.restaurant_locations location ON location.id = selection.location_id
      WHERE r.id = owner_id AND r.restaurant_id <> location.restaurant_id
    ) THEN
      RAISE EXCEPTION 'Selected location belongs to another restaurant'
        USING ERRCODE = '23514', CONSTRAINT = 'reward_locations_restaurant_check';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER rewards_scope AFTER INSERT OR UPDATE OR DELETE ON public.rewards
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_reward_scope();
CREATE CONSTRAINT TRIGGER reward_locations_scope AFTER INSERT OR UPDATE OR DELETE ON public.reward_locations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_reward_scope();

-- TRUNCATE silently broadens every scope and bypasses owner locking/audit.
-- A deliberate change to all locations must use a scoped transactional DELETE.
CREATE FUNCTION public.reject_reward_selection_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Use an explicit transactional DELETE to change reward scope'
    USING ERRCODE = '0A000';
END;
$$;
CREATE TRIGGER reward_locations_no_truncate BEFORE TRUNCATE ON public.reward_locations
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_reward_selection_truncate();

ALTER TABLE public.rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rewards, public.reward_locations, public.reward_rules FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lock_reward_selection() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_reward_scope() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_reward_selection_truncate() FROM PUBLIC, anon, authenticated;

-- Deferred to coupon implementation: freezing published reward/rule conditions,
-- FK identities and selections after first issuance. No coupon models exist here.
COMMIT;
