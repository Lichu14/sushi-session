-- Phase 3, contract v1.1. Additive public-only migration, reviewed before deployment.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '10s';

-- CreateEnum
CREATE TYPE "public"."check_in_code_mode" AS ENUM ('STATIC', 'ROTATING', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "public"."check_in_code_status" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."visit_source" AS ENUM ('QR', 'MANUAL', 'IMPORT');

-- CreateEnum
CREATE TYPE "public"."visit_status" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."session_status" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."session_entry_mode" AS ENUM ('TAP', 'MANUAL');

-- CreateTable
CREATE TABLE "public"."check_in_codes" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "label" VARCHAR(80),
    "token_hash" CHAR(64) NOT NULL,
    "mode" "public"."check_in_code_mode" NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6),
    "max_uses" INTEGER,
    "status" "public"."check_in_code_status" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "created_by_membership_id" UUID,

    CONSTRAINT "check_in_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."visits" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "source" "public"."visit_source" NOT NULL,
    "status" "public"."visit_status" NOT NULL,
    "checked_in_at" TIMESTAMPTZ(6) NOT NULL,
    "checked_out_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "rejected_reason" VARCHAR(300),
    "idempotency_key" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."visit_check_in_evidence" (
    "visit_id" UUID NOT NULL,
    "check_in_code_id" UUID NOT NULL,
    "validated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "visit_check_in_evidence_pkey" PRIMARY KEY ("visit_id")
);

-- CreateTable
CREATE TABLE "public"."sushi_sessions" (
    "id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "status" "public"."session_status" NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "piece_count" INTEGER NOT NULL,
    "entry_mode" "public"."session_entry_mode" NOT NULL,
    "notes" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "sushi_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "check_in_codes_token_hash_key" ON "public"."check_in_codes"("token_hash");

-- CreateIndex
CREATE INDEX "check_in_codes_location_id_status_idx" ON "public"."check_in_codes"("location_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "visits_idempotency_key_key" ON "public"."visits"("idempotency_key");

-- CreateIndex
CREATE INDEX "visits_user_id_checked_in_at_idx" ON "public"."visits"("user_id", "checked_in_at" DESC);

-- CreateIndex
CREATE INDEX "visits_location_id_checked_in_at_idx" ON "public"."visits"("location_id", "checked_in_at" DESC);

-- CreateIndex
CREATE INDEX "visit_check_in_evidence_check_in_code_id_idx" ON "public"."visit_check_in_evidence"("check_in_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "sushi_sessions_visit_id_key" ON "public"."sushi_sessions"("visit_id");

-- AddForeignKey
ALTER TABLE "public"."check_in_codes" ADD CONSTRAINT "check_in_codes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."restaurant_locations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "public"."check_in_codes" ADD CONSTRAINT "check_in_codes_created_by_membership_id_fkey" FOREIGN KEY ("created_by_membership_id") REFERENCES "public"."merchant_memberships"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "public"."visits" ADD CONSTRAINT "visits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "public"."visits" ADD CONSTRAINT "visits_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."restaurant_locations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "public"."visit_check_in_evidence" ADD CONSTRAINT "visit_check_in_evidence_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "public"."visit_check_in_evidence" ADD CONSTRAINT "visit_check_in_evidence_check_in_code_id_fkey" FOREIGN KEY ("check_in_code_id") REFERENCES "public"."check_in_codes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "public"."sushi_sessions" ADD CONSTRAINT "sushi_sessions_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Contract v1.1: row constraints; cross-table cardinality is deferred below.
ALTER TABLE public.check_in_codes
  ADD CONSTRAINT check_in_codes_window_check CHECK (valid_until IS NULL OR valid_until > valid_from),
  ADD CONSTRAINT check_in_codes_expiry_check CHECK (mode = 'STATIC' OR valid_until IS NOT NULL),
  ADD CONSTRAINT check_in_codes_max_uses_check CHECK (max_uses IS NULL OR max_uses > 0),
  ADD CONSTRAINT check_in_codes_one_time_check CHECK (mode <> 'ONE_TIME' OR (max_uses IS NOT NULL AND max_uses = 1)),
  ADD CONSTRAINT check_in_codes_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE public.visits
  ADD CONSTRAINT visits_verified_at_check CHECK (status <> 'VERIFIED' OR verified_at IS NOT NULL),
  ADD CONSTRAINT visits_checkout_check CHECK (checked_out_at IS NULL OR checked_out_at > checked_in_at);
ALTER TABLE public.sushi_sessions
  ADD CONSTRAINT sushi_sessions_piece_count_check CHECK (piece_count BETWEEN 0 AND 1000),
  ADD CONSTRAINT sushi_sessions_version_check CHECK (version > 0),
  ADD CONSTRAINT sushi_sessions_completed_check CHECK (status <> 'COMPLETED' OR ended_at IS NOT NULL),
  ADD CONSTRAINT sushi_sessions_end_check CHECK (ended_at IS NULL OR ended_at >= started_at);

CREATE FUNCTION public.check_in_code_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    RAISE EXCEPTION 'Create a new code to change its location or token'
      USING ERRCODE = '23514', CONSTRAINT = 'check_in_codes_identity_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_in_codes_identity BEFORE UPDATE ON public.check_in_codes
FOR EACH ROW EXECUTE FUNCTION public.check_in_code_identity_guard();

-- The write lock also makes competing REPEATABLE READ writers abort instead of
-- counting a stale snapshot. No cached/denormalized use counter is stored.
CREATE FUNCTION public.check_in_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE code public.check_in_codes; previous_visit uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN previous_visit := OLD.visit_id; END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE public.check_in_codes SET status = status WHERE id = NEW.check_in_code_id RETURNING * INTO code;
    IF FOUND AND (TG_OP = 'INSERT' OR NEW.check_in_code_id IS DISTINCT FROM OLD.check_in_code_id) THEN
      IF code.status <> 'ACTIVE' OR code.revoked_at IS NOT NULL
         OR code.valid_from > clock_timestamp()
         OR (code.valid_until IS NOT NULL AND code.valid_until <= clock_timestamp()) THEN
        RAISE EXCEPTION 'Code is not usable' USING ERRCODE = '23514', CONSTRAINT = 'check_in_codes_usable_check';
      END IF;
      IF code.max_uses IS NOT NULL AND
         (SELECT count(*) FROM public.visit_check_in_evidence WHERE check_in_code_id = code.id
           AND visit_id IS DISTINCT FROM previous_visit) >= code.max_uses THEN
        RAISE EXCEPTION 'Code exhausted' USING ERRCODE = '23514', CONSTRAINT = 'check_in_codes_capacity_check';
      END IF;
      NEW.validated_at := clock_timestamp();
    END IF;
  END IF;
  -- Serialize source/location changes with evidence changes; stable ID order.
  IF TG_OP = 'INSERT' THEN
    UPDATE public.visits SET updated_at = updated_at WHERE id = NEW.visit_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.visits SET updated_at = updated_at WHERE id = OLD.visit_id;
  ELSE
    PERFORM id FROM public.visits WHERE id IN (OLD.visit_id, NEW.visit_id) ORDER BY id FOR UPDATE;
    UPDATE public.visits SET updated_at = updated_at WHERE id IN (OLD.visit_id, NEW.visit_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER visit_check_in_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.visit_check_in_evidence
FOR EACH ROW EXECUTE FUNCTION public.check_in_evidence_guard();

CREATE FUNCTION public.assert_visit_evidence(target_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v public.visits; code_location uuid; has_evidence boolean;
BEGIN
  SELECT * INTO v FROM public.visits WHERE id = target_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT c.location_id INTO code_location FROM public.visit_check_in_evidence e
    JOIN public.check_in_codes c ON c.id = e.check_in_code_id WHERE e.visit_id = target_id;
  has_evidence := FOUND;
  IF (v.source = 'QR') <> has_evidence THEN
    RAISE EXCEPTION 'QR requires one evidence; MANUAL and IMPORT require none'
      USING ERRCODE = '23514', CONSTRAINT = 'visits_evidence_source_check';
  END IF;
  IF has_evidence AND code_location <> v.location_id THEN
    RAISE EXCEPTION 'Evidence belongs to another location'
      USING ERRCODE = '23514', CONSTRAINT = 'visits_evidence_location_check';
  END IF;
END;
$$;
CREATE FUNCTION public.visit_evidence_constraint() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME = 'visits' THEN
    IF TG_OP <> 'INSERT' THEN PERFORM public.assert_visit_evidence(OLD.id); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM public.assert_visit_evidence(NEW.id); END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN PERFORM public.assert_visit_evidence(OLD.visit_id); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM public.assert_visit_evidence(NEW.visit_id); END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER visits_evidence AFTER INSERT OR UPDATE OR DELETE ON public.visits
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.visit_evidence_constraint();
CREATE CONSTRAINT TRIGGER visit_check_in_evidence_consistency AFTER INSERT OR UPDATE OR DELETE ON public.visit_check_in_evidence
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.visit_evidence_constraint();

-- TRUNCATE bypasses row triggers and would invalidate QR visits.
CREATE FUNCTION public.reject_evidence_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Use transactional DELETE with deferred integrity checks'
    USING ERRCODE = '23514', CONSTRAINT = 'visit_evidence_no_truncate_check';
END;
$$;
CREATE TRIGGER visit_evidence_no_truncate BEFORE TRUNCATE ON public.visit_check_in_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_evidence_truncate();

CREATE FUNCTION public.sushi_session_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Session is already closed' USING ERRCODE = '23514', CONSTRAINT = 'sushi_sessions_terminal_check';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Session update requires next version' USING ERRCODE = '23514', CONSTRAINT = 'sushi_sessions_next_version_check';
  END IF;
  IF NEW.visit_id IS DISTINCT FROM OLD.visit_id OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'Session origin is immutable' USING ERRCODE = '23514', CONSTRAINT = 'sushi_sessions_origin_check';
  END IF;
  IF NEW.status = 'COMPLETED' THEN NEW.ended_at := clock_timestamp();
  ELSIF NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
    RAISE EXCEPTION 'Completion time belongs to the server' USING ERRCODE = '23514', CONSTRAINT = 'sushi_sessions_server_end_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sushi_sessions_guard BEFORE UPDATE ON public.sushi_sessions
FOR EACH ROW EXECUTE FUNCTION public.sushi_session_update_guard();
CREATE TRIGGER visits_updated_at BEFORE UPDATE ON public.visits
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER sushi_sessions_updated_at BEFORE UPDATE ON public.sushi_sessions
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.check_in_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visit_check_in_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sushi_sessions ENABLE ROW LEVEL SECURITY;
-- No Data API policies: all access in this phase goes through authenticated NestJS.
REVOKE ALL ON FUNCTION public.check_in_code_identity_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_in_evidence_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_visit_evidence(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.visit_evidence_constraint() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_evidence_truncate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sushi_session_update_guard() FROM PUBLIC, anon, authenticated;

-- A supplied creator must have an active membership covering this location.
-- This is an operation-time check, not a requirement to keep that actor active forever.
CREATE FUNCTION public.check_in_code_creator_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE member public.merchant_memberships;
BEGIN
  IF NEW.created_by_membership_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO member FROM public.merchant_memberships WHERE id = NEW.created_by_membership_id FOR SHARE;
  IF NOT FOUND OR member.status <> 'ACTIVE' OR NOT EXISTS (
    SELECT 1 FROM public.restaurant_locations l WHERE l.id = NEW.location_id
      AND l.restaurant_id = member.restaurant_id
      AND (member.scope_type = 'ALL_LOCATIONS' OR EXISTS (
        SELECT 1 FROM public.merchant_membership_locations ml
        WHERE ml.membership_id = member.id AND ml.location_id = l.id))
  ) THEN
    RAISE EXCEPTION 'Creator must have an active membership covering this location'
      USING ERRCODE = '23514', CONSTRAINT = 'check_in_codes_creator_scope_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_in_codes_creator BEFORE INSERT OR UPDATE OF created_by_membership_id ON public.check_in_codes
FOR EACH ROW EXECUTE FUNCTION public.check_in_code_creator_guard();
REVOKE ALL ON FUNCTION public.check_in_code_creator_guard() FROM PUBLIC, anon, authenticated;

COMMIT;
