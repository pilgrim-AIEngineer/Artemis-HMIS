-- #11: number_series counters only move forward and a row never changes identity, so a buggy or
-- hostile UPDATE cannot make the next bill/receipt number repeat a legal number. A deliberate
-- reset is a privileged path: the table owner (migration role) disables this trigger explicitly.
CREATE OR REPLACE FUNCTION public.hmis_number_series_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key OR NEW.fy IS DISTINCT FROM OLD.fy THEN
    RAISE EXCEPTION 'hmis: number_series key and fy are immutable';
  END IF;
  IF NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION 'hmis: number_series.next_value is monotonic (% -> %)', OLD.next_value, NEW.next_value;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER number_series_guard
  BEFORE UPDATE ON public.number_series
  FOR EACH ROW EXECUTE FUNCTION public.hmis_number_series_guard();
