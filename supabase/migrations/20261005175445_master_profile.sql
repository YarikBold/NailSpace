create table public.master_profile (id integer primary key check (id=1), description text not null);
alter table public.master_profile enable row level security;
revoke all on public.master_profile from anon, authenticated;
grant select on public.master_profile to anon, authenticated;
grant all on public.master_profile to service_role;
create policy "Public profile read" on public.master_profile for select to anon, authenticated using (true);
insert into public.master_profile values (1,'Всем привет, я начинающий мастер маникюра, принимаю на дому, готова вам доставить комфортную атмосферу и красивые новые ноготочки');
