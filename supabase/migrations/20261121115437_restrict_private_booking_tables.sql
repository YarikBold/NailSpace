-- The website and the mini app access booking records through the Edge Function.
alter table public.appointments enable row level security;
alter table public.bot_pending_booking enable row level security;
alter table public.bot_pending_edit enable row level security;
alter table public.bot_pending_review enable row level security;

revoke all on table public.appointments, public.bot_pending_booking,
  public.bot_pending_edit, public.bot_pending_review
  from public, anon, authenticated;
grant select, insert, update, delete on table public.appointments, public.bot_pending_booking,
  public.bot_pending_edit, public.bot_pending_review
  to service_role;

alter view public.cashbox set (security_invoker = true);
revoke all on table public.cashbox from public, anon, authenticated;
grant select on table public.cashbox to service_role;
