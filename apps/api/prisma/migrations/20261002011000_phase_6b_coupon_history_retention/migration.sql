BEGIN;

-- Preserve the evidence that freezes a published benefit. Removing both Coupon
-- and Origin must not unlock a surviving definition or reset maxAwardsPerUser.
-- A full, explicit maintenance deletion of the benefit graph (used only by
-- isolated test cleanup here) leaves no definition to reuse. No business DELETE
-- endpoint exists. Deferred checking permits either graph deletion order.
CREATE FUNCTION public.enforce_coupon_history_retention() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.rewards WHERE id = (OLD.eligibility_snapshot->>'rewardId')::uuid) THEN
    RAISE EXCEPTION 'Coupon history cannot be removed while its published reward exists'
      USING ERRCODE = '23514', CONSTRAINT = 'coupons_history_retention_check';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER coupons_history_retention AFTER DELETE ON public.coupons
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_coupon_history_retention();
REVOKE ALL ON FUNCTION public.enforce_coupon_history_retention() FROM PUBLIC, anon, authenticated;

COMMIT;
