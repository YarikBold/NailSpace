-- Add daily booking windows for November and December 2026.
INSERT INTO public.slots (slot_time, status)
SELECT (d::date + t::time) AT TIME ZONE 'Europe/Moscow', 'available'
FROM generate_series('2026-11-01'::date, '2026-12-31'::date, interval '1 day') AS days(d)
CROSS JOIN (VALUES ('09:00'::time), ('12:00'::time), ('15:00'::time), ('18:00'::time)) AS times(t)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.slots s
  WHERE s.slot_time = ((d::date + t::time) AT TIME ZONE 'Europe/Moscow')
);
