-- BIL-06: audit + touch triggers (AGENTS.md rule 5) and the guards that make a closed period
-- stay closed (docs/12 §6, docs/04 §15). Grants need no change (default privileges from 0001).
--
-- 1. payment.business_date for the payments written before this migration: the IST day of the
--    receipt (nothing could have been closed yet). Done before the guards below exist.
UPDATE public.payment
   SET business_date = (received_at AT TIME ZONE 'Asia/Kolkata')::date;
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.day_close');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.upi_reconciliation');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.upi_reconciliation_item');
--> statement-breakpoint

-- 2. A new payment is never born closed, and it belongs to its own IST day unless the facility has
--    been closed up to that day: then it goes to the day after the last facility close ("payments
--    after close go to the next day"). The shared lock makes a payment wait for a facility close
--    that is committing, so it sees the close (the close takes the same lock exclusively).
CREATE FUNCTION public.hmis_payment_business_date() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  ist date;
  last_closed date;
BEGIN
  IF NEW.day_close_id IS NOT NULL THEN
    RAISE EXCEPTION 'hmis: a new payment cannot belong to a day close' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('dayclose:facility:' || NEW.facility_id::text, 0));
  ist := (NEW.received_at AT TIME ZONE 'Asia/Kolkata')::date;
  SELECT max(close_date) INTO last_closed
    FROM public.day_close
   WHERE facility_id = NEW.facility_id AND kind = 'facility';
  IF last_closed IS NULL OR ist > last_closed THEN
    NEW.business_date := ist;
  ELSE
    NEW.business_date := last_closed + 1;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_payment_business_date BEFORE INSERT ON public.payment
FOR EACH ROW EXECUTE FUNCTION public.hmis_payment_business_date();
--> statement-breakpoint

-- 3. A counted payment is locked: its day close, business day and status never change. A payment
--    gets its day close exactly once, from a user close of the same cashier and facility.
CREATE FUNCTION public.hmis_payment_close_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  c public.day_close%ROWTYPE;
BEGIN
  IF NEW.business_date IS DISTINCT FROM OLD.business_date THEN
    RAISE EXCEPTION 'hmis: payment business day is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.day_close_id IS NOT NULL THEN
    IF NEW.day_close_id IS DISTINCT FROM OLD.day_close_id OR NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'hmis: payment % belongs to a closed day; correct it with a new entry', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.day_close_id IS NOT NULL THEN
    SELECT * INTO c FROM public.day_close WHERE id = NEW.day_close_id;
    IF NOT FOUND OR c.kind <> 'user' OR c.facility_id <> NEW.facility_id
       OR c.user_id IS DISTINCT FROM NEW.received_by THEN
      RAISE EXCEPTION 'hmis: payment % can only be counted by its own cashier''s close', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_payment_close_guard BEFORE UPDATE ON public.payment
FOR EACH ROW EXECUTE FUNCTION public.hmis_payment_close_guard();
--> statement-breakpoint

-- 4. Facility closes run one at a time, in date order, and a close cannot change afterwards,
--    except that a user close is attached once to the facility close that took it in.
CREATE FUNCTION public.hmis_day_close_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  last_closed date;
BEGIN
  IF NEW.facility_close_id IS NOT NULL THEN
    RAISE EXCEPTION 'hmis: a day close is attached to a facility close later' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'facility' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('dayclose:facility:' || NEW.facility_id::text, 0));
    SELECT max(close_date) INTO last_closed
      FROM public.day_close
     WHERE facility_id = NEW.facility_id AND kind = 'facility';
    IF last_closed IS NOT NULL AND NEW.close_date <= last_closed THEN
      RAISE EXCEPTION 'hmis: the facility is already closed up to %', last_closed
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_day_close_insert_guard BEFORE INSERT ON public.day_close
FOR EACH ROW EXECUTE FUNCTION public.hmis_day_close_insert_guard();
--> statement-breakpoint

CREATE FUNCTION public.hmis_day_close_update_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent public.day_close%ROWTYPE;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.close_date IS DISTINCT FROM OLD.close_date OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
     OR NEW.cash_expected_paise IS DISTINCT FROM OLD.cash_expected_paise
     OR NEW.upi_expected_paise IS DISTINCT FROM OLD.upi_expected_paise
     OR NEW.card_expected_paise IS DISTINCT FROM OLD.card_expected_paise
     OR NEW.other_expected_paise IS DISTINCT FROM OLD.other_expected_paise
     OR NEW.cash_counted_paise IS DISTINCT FROM OLD.cash_counted_paise
     OR NEW.difference_paise IS DISTINCT FROM OLD.difference_paise
     OR NEW.difference_reason IS DISTINCT FROM OLD.difference_reason
     OR NEW.denominations IS DISTINCT FROM OLD.denominations
     OR NEW.payment_count IS DISTINCT FROM OLD.payment_count
     OR NEW.pending_acknowledged IS DISTINCT FROM OLD.pending_acknowledged
     OR NEW.note IS DISTINCT FROM OLD.note THEN
    RAISE EXCEPTION 'hmis: a day close cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.facility_close_id IS DISTINCT FROM OLD.facility_close_id
     OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    IF OLD.facility_close_id IS NOT NULL OR OLD.kind <> 'user' THEN
      RAISE EXCEPTION 'hmis: a day close is attached to a facility close only once' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO parent FROM public.day_close WHERE id = NEW.facility_close_id;
    IF NOT FOUND OR parent.kind <> 'facility' OR parent.facility_id <> NEW.facility_id THEN
      RAISE EXCEPTION 'hmis: a user close is attached to a facility close of the same facility' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_day_close_update_guard BEFORE UPDATE ON public.day_close
FOR EACH ROW EXECUTE FUNCTION public.hmis_day_close_update_guard();
--> statement-breakpoint

-- 5. Docs/12 §9: a close matches the sum of its payments exactly. Checked at COMMIT (deferred):
--    a user close against the payments stamped with it, a facility close against the user closes
--    attached to it. Refunds are negative amounts; deposit adjustments move no money.
CREATE FUNCTION public.hmis_check_day_close_totals() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  s record;
BEGIN
  IF NEW.kind = 'user' THEN
    SELECT coalesce(sum(amount_paise) FILTER (WHERE mode = 'cash'), 0) AS cash,
           coalesce(sum(amount_paise) FILTER (WHERE mode = 'upi'), 0) AS upi,
           coalesce(sum(amount_paise) FILTER (WHERE mode = 'card'), 0) AS card,
           coalesce(sum(amount_paise) FILTER (WHERE mode NOT IN ('cash', 'upi', 'card')), 0) AS other,
           count(*) AS n
      INTO s
      FROM public.payment
     WHERE day_close_id = NEW.id AND status = 'valid' AND kind <> 'deposit_adjustment';
    IF NEW.cash_expected_paise <> s.cash OR NEW.upi_expected_paise <> s.upi
       OR NEW.card_expected_paise <> s.card OR NEW.other_expected_paise <> s.other
       OR NEW.payment_count <> s.n THEN
      RAISE EXCEPTION 'hmis: day close % does not match its payments', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT coalesce(sum(cash_expected_paise), 0) AS cash,
           coalesce(sum(upi_expected_paise), 0) AS upi,
           coalesce(sum(card_expected_paise), 0) AS card,
           coalesce(sum(other_expected_paise), 0) AS other,
           coalesce(sum(cash_counted_paise), 0) AS counted,
           coalesce(sum(payment_count), 0) AS n
      INTO s
      FROM public.day_close
     WHERE facility_close_id = NEW.id;
    IF NEW.cash_expected_paise <> s.cash OR NEW.upi_expected_paise <> s.upi
       OR NEW.card_expected_paise <> s.card OR NEW.other_expected_paise <> s.other
       OR NEW.cash_counted_paise <> s.counted OR NEW.payment_count <> s.n THEN
      RAISE EXCEPTION 'hmis: facility close % does not match its user closes', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER hmis_day_close_totals AFTER INSERT ON public.day_close
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.hmis_check_day_close_totals();
--> statement-breakpoint

-- 6. UPI reconciliation: a reconciled day is frozen; ticked receipts are UPI receipts of that
--    business day of the same facility, and only on an open reconciliation.
CREATE FUNCTION public.hmis_upi_reconciliation_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'reconciled'
     OR NEW.recon_date IS DISTINCT FROM OLD.recon_date
     OR NEW.facility_id IS DISTINCT FROM OLD.facility_id THEN
    RAISE EXCEPTION 'hmis: a reconciled UPI day cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_upi_reconciliation_guard BEFORE UPDATE ON public.upi_reconciliation
FOR EACH ROW EXECUTE FUNCTION public.hmis_upi_reconciliation_guard();
--> statement-breakpoint

CREATE FUNCTION public.hmis_upi_reconciliation_item_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  r public.upi_reconciliation%ROWTYPE;
  p public.payment%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.reconciliation_id IS DISTINCT FROM OLD.reconciliation_id
                           OR NEW.payment_id IS DISTINCT FROM OLD.payment_id) THEN
    RAISE EXCEPTION 'hmis: a reconciliation item cannot move' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO r FROM public.upi_reconciliation WHERE id = NEW.reconciliation_id;
  SELECT * INTO p FROM public.payment WHERE id = NEW.payment_id;
  IF r.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'hmis: the UPI reconciliation is not open' USING ERRCODE = 'check_violation';
  END IF;
  IF p.mode IS DISTINCT FROM 'upi' OR p.facility_id <> r.facility_id
     OR p.business_date <> r.recon_date OR NEW.facility_id <> r.facility_id THEN
    RAISE EXCEPTION 'hmis: only UPI receipts of the reconciled day can be ticked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_upi_reconciliation_item_guard BEFORE INSERT OR UPDATE ON public.upi_reconciliation_item
FOR EACH ROW EXECUTE FUNCTION public.hmis_upi_reconciliation_item_guard();
