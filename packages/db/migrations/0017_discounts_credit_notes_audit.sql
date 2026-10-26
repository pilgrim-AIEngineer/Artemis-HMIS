-- BIL-03 / BIL-04: audit + touch triggers (AGENTS.md rule 5) and the guards of docs/04 §15.2 and
-- §15.8: credit notes and approvals are immutable, a bill is cancelled only when credited in full,
-- and a refund is a negative payment against a final bill that has an approval on record and can
-- never take the money paid on the bill below zero. Grants need no change (default privileges).
SELECT public.hmis_register_business_table('public.approval');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.bill_discount');
--> statement-breakpoint
SELECT public.hmis_register_business_table('public.credit_note');
--> statement-breakpoint

-- Approvals and credit notes are written once. Corrections are new rows (rule 4).
CREATE FUNCTION public.hmis_immutable_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'hmis: % rows are immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_approval_immutable BEFORE UPDATE ON public.approval
FOR EACH ROW EXECUTE FUNCTION public.hmis_immutable_row();
--> statement-breakpoint
CREATE TRIGGER hmis_credit_note_immutable BEFORE UPDATE ON public.credit_note
FOR EACH ROW EXECUTE FUNCTION public.hmis_immutable_row();
--> statement-breakpoint

-- A credit note is issued against a final bill of the same patient and encounter.
CREATE FUNCTION public.hmis_credit_note_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  b public.bill%ROWTYPE;
BEGIN
  SELECT * INTO b FROM public.bill WHERE id = NEW.bill_id;
  IF b.status IS DISTINCT FROM 'final'
     OR b.facility_id <> NEW.facility_id
     OR b.patient_id <> NEW.patient_id
     OR b.encounter_id <> NEW.encounter_id THEN
    RAISE EXCEPTION 'hmis: a credit note needs a final bill of the same patient' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_credit_note_guard BEFORE INSERT ON public.credit_note
FOR EACH ROW EXECUTE FUNCTION public.hmis_credit_note_guard();
--> statement-breakpoint

-- Discount records exist only on a draft; once written only their cancel fields change.
CREATE FUNCTION public.hmis_bill_discount_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  bill_status text;
BEGIN
  SELECT b.status INTO bill_status FROM public.bill b WHERE b.id = NEW.bill_id;
  IF bill_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'hmis: bill % is not a draft; its discounts cannot change', NEW.bill_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'cancelled'
       OR NEW.bill_id IS DISTINCT FROM OLD.bill_id
       OR NEW.bill_line_id IS DISTINCT FROM OLD.bill_line_id
       OR NEW.mode IS DISTINCT FROM OLD.mode
       OR NEW.percent_bp IS DISTINCT FROM OLD.percent_bp
       OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
       OR NEW.reason_code_id IS DISTINCT FROM OLD.reason_code_id
       OR NEW.reason_text IS DISTINCT FROM OLD.reason_text
       OR NEW.approval_id IS DISTINCT FROM OLD.approval_id THEN
      RAISE EXCEPTION 'hmis: discount % is immutable; cancel it instead', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER hmis_bill_discount_guard BEFORE INSERT OR UPDATE ON public.bill_discount
FOR EACH ROW EXECUTE FUNCTION public.hmis_bill_discount_guard();
--> statement-breakpoint

-- Bill guard (replaces 0015): credits only grow, and a final bill is cancelled exactly when its
-- credit notes cover the whole patient share.
CREATE OR REPLACE FUNCTION public.hmis_bill_guard() RETURNS trigger
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
    IF NEW.credited_paise < OLD.credited_paise THEN
      RAISE EXCEPTION 'hmis: bill % credit cannot be taken back', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.status = 'cancelled' OR NEW.credited_paise <> OLD.credited_paise)
       AND (NEW.status = 'cancelled') <> (NEW.credited_paise = NEW.patient_share_paise) THEN
      RAISE EXCEPTION 'hmis: bill % is cancelled only when credited in full', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Payment guard (replaces 0015): the refund fields are immutable too; a refund goes against a final
-- bill, with its approval and credit note on that bill, and never exceeds the money paid on it.
CREATE OR REPLACE FUNCTION public.hmis_payment_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  bill_status text;
  paid_so_far bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.bill_id IS NOT NULL THEN
      SELECT b.status INTO bill_status FROM public.bill b WHERE b.id = NEW.bill_id;
      IF bill_status = 'cancelled' THEN
        RAISE EXCEPTION 'hmis: bill % is cancelled', NEW.bill_id USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.kind = 'refund' THEN
      IF bill_status IS DISTINCT FROM 'final' THEN
        RAISE EXCEPTION 'hmis: only a final bill can be refunded' USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.approval a
                      WHERE a.id = NEW.approval_id AND a.bill_id = NEW.bill_id
                        AND a.facility_id = NEW.facility_id) THEN
        RAISE EXCEPTION 'hmis: a refund needs an approval on the same bill' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.credit_note_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.credit_note c WHERE c.id = NEW.credit_note_id AND c.bill_id = NEW.bill_id) THEN
        RAISE EXCEPTION 'hmis: the credit note belongs to another bill' USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum(p.amount_paise), 0) INTO paid_so_far
        FROM public.payment p
       WHERE p.bill_id = NEW.bill_id AND p.status = 'valid' AND p.kind IN ('payment', 'refund');
      IF paid_so_far + NEW.amount_paise < 0 THEN
        RAISE EXCEPTION 'hmis: a refund cannot exceed the amount paid on the bill'
          USING ERRCODE = 'check_violation';
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
     OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
     OR NEW.credit_note_id IS DISTINCT FROM OLD.credit_note_id
     OR NEW.reason_code_id IS DISTINCT FROM OLD.reason_code_id
     OR NEW.reason_text IS DISTINCT FROM OLD.reason_text
     OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'valid' AND NEW.status = 'reversed')) THEN
    RAISE EXCEPTION 'hmis: payment % is immutable; reverse it instead', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- §15.1 across tables (replaces 0015): also the credited amount and its tax equal the credit notes.
CREATE OR REPLACE FUNCTION public.hmis_check_bill_totals() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target uuid;
  b public.bill%ROWTYPE;
  l record;
  c record;
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
  SELECT coalesce(sum(amount_paise), 0) AS amount,
         coalesce(sum(cgst_paise), 0) AS cgst,
         coalesce(sum(sgst_paise), 0) AS sgst
    INTO c
    FROM public.credit_note
   WHERE bill_id = target;
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
  IF b.credited_paise <> c.amount OR b.credited_cgst_paise <> c.cgst OR b.credited_sgst_paise <> c.sgst THEN
    RAISE EXCEPTION 'hmis: bill % credited amount does not match its credit notes', target
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER hmis_bill_totals AFTER INSERT ON public.credit_note
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.hmis_check_bill_totals();
