-- BIL-01 / BIL-02: audit + touch triggers (AGENTS.md rule 5) and the bill invariants of
-- docs/04 §15.1–2 as a second line of defence behind the app. Grants need no change: the default
-- privileges from 0001 give hmis_app SELECT/INSERT/UPDATE and no DELETE on the new tables.
SELECT public.hmis_register_business_table('public.bill');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.bill_line');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.payment');
--> statement-breakpoint

-- §15.2: a final bill cannot change, except that payments (paid/balance) keep arriving on a bill
-- finalised on credit, and a cancellation (BIL-04) sets status + cancel fields. A cancelled bill
-- is frozen. The number, once given, never changes.
CREATE FUNCTION public.hmis_bill_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'hmis: bill % is cancelled and cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'hmis: bill number is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    RAISE EXCEPTION 'hmis: bill kind, encounter and patient are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'final' THEN
    IF NEW.status NOT IN ('final', 'cancelled')
       OR NEW.payer_id IS DISTINCT FROM OLD.payer_id
       OR NEW.tariff_id IS DISTINCT FROM OLD.tariff_id
       OR NEW.bill_date IS DISTINCT FROM OLD.bill_date
       OR NEW.gross_paise IS DISTINCT FROM OLD.gross_paise
       OR NEW.discount_paise IS DISTINCT FROM OLD.discount_paise
       OR NEW.taxable_paise IS DISTINCT FROM OLD.taxable_paise
       OR NEW.cgst_paise IS DISTINCT FROM OLD.cgst_paise
       OR NEW.sgst_paise IS DISTINCT FROM OLD.sgst_paise
       OR NEW.round_off_paise IS DISTINCT FROM OLD.round_off_paise
       OR NEW.net_paise IS DISTINCT FROM OLD.net_paise
       OR NEW.payer_share_paise IS DISTINCT FROM OLD.payer_share_paise
       OR NEW.patient_share_paise IS DISTINCT FROM OLD.patient_share_paise
       OR NEW.finalized_by IS DISTINCT FROM OLD.finalized_by
       OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
      RAISE EXCEPTION 'hmis: bill % is final; correct it with a credit note', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_bill_guard BEFORE UPDATE ON public.bill
FOR EACH ROW EXECUTE FUNCTION public.hmis_bill_guard();
--> statement-breakpoint

-- Lines are written only while their bill is a draft, and never move to another bill.
CREATE FUNCTION public.hmis_bill_line_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  bill_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.bill_id IS DISTINCT FROM OLD.bill_id THEN
    RAISE EXCEPTION 'hmis: bill_line.bill_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'hmis: a removed bill line cannot change' USING ERRCODE = 'check_violation';
  END IF;
  SELECT b.status INTO bill_status FROM public.bill b WHERE b.id = NEW.bill_id;
  IF bill_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'hmis: bill % is not a draft; its lines cannot change', NEW.bill_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_bill_line_guard BEFORE INSERT OR UPDATE ON public.bill_line
FOR EACH ROW EXECUTE FUNCTION public.hmis_bill_line_guard();
--> statement-breakpoint

-- Payments are immutable money records: only `valid → reversed` (BIL-04) may happen to a row.
-- A payment cannot be taken against a cancelled bill.
CREATE FUNCTION public.hmis_payment_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  bill_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.bill_id IS NOT NULL THEN
      SELECT b.status INTO bill_status FROM public.bill b WHERE b.id = NEW.bill_id;
      IF bill_status = 'cancelled' THEN
        RAISE EXCEPTION 'hmis: bill % is cancelled', NEW.bill_id USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number
     OR NEW.collection_id IS DISTINCT FROM OLD.collection_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
     OR NEW.bill_id IS DISTINCT FROM OLD.bill_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
     OR NEW.upi_ref IS DISTINCT FROM OLD.upi_ref
     OR NEW.card_last4 IS DISTINCT FROM OLD.card_last4
     OR NEW.received_by IS DISTINCT FROM OLD.received_by
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'valid' AND NEW.status = 'reversed')) THEN
    RAISE EXCEPTION 'hmis: payment % is immutable; reverse it instead', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_payment_guard BEFORE INSERT OR UPDATE ON public.payment
FOR EACH ROW EXECUTE FUNCTION public.hmis_payment_guard();
--> statement-breakpoint

-- §15.1 across tables, checked at COMMIT (deferred) so a transaction may write the header and its
-- lines in any order: header sums = active lines; patient share = lines' patient share + round-off;
-- paid = valid payments/refunds against the bill.
CREATE FUNCTION public.hmis_check_bill_totals() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target uuid;
  b public.bill%ROWTYPE;
  l record;
  paid bigint;
BEGIN
  IF TG_TABLE_NAME = 'bill' THEN
    target := NEW.id;
  ELSE
    target := NEW.bill_id;
  END IF;
  IF target IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO b FROM public.bill WHERE id = target;
  SELECT coalesce(sum(amount_paise), 0) AS gross,
         coalesce(sum(discount_paise), 0) AS discount,
         coalesce(sum(taxable_paise), 0) AS taxable,
         coalesce(sum(cgst_paise), 0) AS cgst,
         coalesce(sum(sgst_paise), 0) AS sgst,
         coalesce(sum(payer_share_paise), 0) AS payer,
         coalesce(sum(patient_share_paise), 0) AS patient
    INTO l
    FROM public.bill_line
   WHERE bill_id = target AND status = 'active';
  SELECT coalesce(sum(amount_paise), 0) INTO paid
    FROM public.payment
   WHERE bill_id = target AND status = 'valid' AND kind IN ('payment', 'refund');
  IF b.gross_paise <> l.gross OR b.discount_paise <> l.discount OR b.taxable_paise <> l.taxable
     OR b.cgst_paise <> l.cgst OR b.sgst_paise <> l.sgst OR b.payer_share_paise <> l.payer
     OR b.patient_share_paise <> l.patient + b.round_off_paise THEN
    RAISE EXCEPTION 'hmis: bill % totals do not match its lines', target
      USING ERRCODE = 'check_violation';
  END IF;
  IF b.paid_paise <> paid THEN
    RAISE EXCEPTION 'hmis: bill % paid amount does not match its payments', target
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER hmis_bill_totals AFTER INSERT OR UPDATE ON public.bill
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.hmis_check_bill_totals();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER hmis_bill_totals AFTER INSERT OR UPDATE ON public.bill_line
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.hmis_check_bill_totals();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER hmis_bill_totals AFTER INSERT OR UPDATE ON public.payment
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.hmis_check_bill_totals();
