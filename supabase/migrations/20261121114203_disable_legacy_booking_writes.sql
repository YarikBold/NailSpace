-- Apply after GitHub Pages switches to the server-side booking API.
revoke insert, update, delete on public.appointments, public.slots from public, anon, authenticated;
drop policy if exists appointments_insert on public.appointments;
drop policy if exists slots_book on public.slots;
