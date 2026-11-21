alter table public.appointments
  drop constraint appointments_status_check,
  add constraint appointments_status_check check (
    status in ('new', 'awaiting_payment', 'payment_review', 'confirmed', 'completed', 'canceled')
  ),
  add column prepayment_amount numeric(10,2),
  add column payment_expires_at timestamptz,
  add column payment_submitted_at timestamptz,
  add column payment_notified_at timestamptz,
  add column payment_confirmed_at timestamptz,
  add column day_reminder_sent_at timestamptz,
  add column attendance_confirmed_at timestamptz,
  add column review_published_at timestamptz;

alter table public.appointment_photos
  drop constraint appointment_photos_kind_check,
  add constraint appointment_photos_kind_check check (kind in ('before', 'ref', 'review'));

create unique index appointments_active_slot_idx
  on public.appointments (slot_id)
  where status in ('new', 'awaiting_payment', 'payment_review', 'confirmed', 'completed');

create unique index slots_unique_time_idx on public.slots (slot_time);

create index appointments_payment_expiry_idx
  on public.appointments (payment_expires_at)
  where status = 'awaiting_payment';

create index appointments_public_review_idx
  on public.appointments (review_published_at desc, id)
  where review_approved is true and review_rating between 1 and 5;

update public.appointments
set review_published_at = coalesce(review_requested_at, completed_at, created_at, now())
where review_approved is true and review_rating between 1 and 5;

-- Serialize every booking against the same slot, including bookings from the website.
create function public.nailspace_reserve(
  p_slot_id uuid, p_chat_id text, p_name text, p_phone text, p_contact text,
  p_service text, p_comment text, p_price numeric, p_prepayment numeric,
  p_hold_minutes integer
)
returns public.appointments language plpgsql security invoker set search_path = '' as $$
declare
  v_booking public.appointments;
begin
  if p_prepayment is not null and (p_chat_id is null or p_prepayment <= 0 or p_hold_minutes <= 0) then
    raise exception 'Invalid payment configuration';
  end if;

  update public.slots
  set status = 'booked'
  where id = p_slot_id and status = 'available' and slot_time > now();

  if not found then
    select * into v_booking from public.appointments
    where slot_id = p_slot_id and chat_id = p_chat_id
      and status in ('awaiting_payment', 'payment_review');
    return v_booking;
  end if;

  insert into public.appointments (
    slot_id, chat_id, client_name, phone, contact, service, comment, price,
    status, prepayment_amount, payment_expires_at
  ) values (
    p_slot_id, p_chat_id, p_name, p_phone, p_contact, p_service, p_comment, p_price,
    case when p_prepayment is null then 'new' else 'awaiting_payment' end,
    p_prepayment,
    case when p_prepayment is not null then now() + make_interval(mins => p_hold_minutes) end
  ) returning * into v_booking;
  return v_booking;
end;
$$;

create function public.nailspace_expire_holds()
returns bigint language sql security invoker set search_path = '' as $$
  with expired as (
    update public.appointments
    set status = 'canceled'
    where status = 'awaiting_payment' and payment_expires_at <= now()
    returning slot_id
  ), released as (
    update public.slots s set status = 'available'
    from expired e where s.id = e.slot_id and s.status = 'booked'
    returning s.id
  )
  select count(*) from released;
$$;

create function public.nailspace_cancel(p_id uuid, p_chat_id text, p_payment_only boolean)
returns public.appointments language plpgsql security invoker set search_path = '' as $$
declare
  v_booking public.appointments;
begin
  update public.appointments a set status = 'canceled'
  where a.id = p_id and a.status in ('awaiting_payment', 'payment_review', 'new', 'confirmed')
    and (not p_payment_only or a.status = 'payment_review')
    and (p_chat_id is null or (
      a.chat_id = p_chat_id and exists (
        select 1 from public.slots s where s.id = a.slot_id and s.slot_time > now()
      )
    ))
  returning a.* into v_booking;

  if found then
    update public.slots set status = 'available'
    where id = v_booking.slot_id and status = 'booked';
  end if;
  return v_booking;
end;
$$;

create function public.nailspace_delete_booking(p_id uuid)
returns public.appointments language plpgsql security invoker set search_path = '' as $$
declare
  v_booking public.appointments;
begin
  delete from public.appointments where id = p_id returning * into v_booking;
  if found and v_booking.status in ('new', 'awaiting_payment', 'payment_review', 'confirmed', 'completed') then
    update public.slots set status = 'available'
    where id = v_booking.slot_id and status = 'booked';
  end if;
  return v_booking;
end;
$$;

create function public.nailspace_move_booking(p_id uuid, p_slot_id uuid, p_chat_id text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_slot_id uuid;
begin
  select slot_id into v_slot_id from public.appointments
  where id = p_id and status in ('new', 'confirmed')
    and (p_chat_id is null or (chat_id = p_chat_id and exists (
      select 1 from public.slots s where s.id = slot_id and s.slot_time > now()
    )))
  for update;
  if not found then
    return false;
  end if;

  update public.slots set status = 'booked'
  where id = p_slot_id and status = 'available' and slot_time > now();
  if not found then
    return false;
  end if;

  update public.appointments
  set slot_id = p_slot_id, reminder_sent = false, day_reminder_sent_at = null, attendance_confirmed_at = null
  where id = p_id;
  update public.slots set status = 'available' where id = v_slot_id and status = 'booked';
  return true;
end;
$$;

create function public.nailspace_payment(p_id uuid, p_chat_id text)
returns public.appointments language sql security invoker set search_path = '' as $$
  update public.appointments a
  set status = case when p_chat_id is null then 'confirmed' else 'payment_review' end,
      payment_submitted_at = case when p_chat_id is null then a.payment_submitted_at else now() end,
      payment_confirmed_at = case when p_chat_id is null then now() end
  where a.id = p_id
    and exists (select 1 from public.slots s where s.id = a.slot_id and s.slot_time > now())
    and (
      (p_chat_id is null and a.status = 'payment_review')
      or (a.chat_id = p_chat_id and a.status = 'awaiting_payment' and a.payment_expires_at > now())
    )
  returning a.*;
$$;

create function public.nailspace_review_summary()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'count', count(*),
    'average', round(avg(review_rating), 1),
    'services', coalesce(jsonb_agg(distinct service order by service), '[]'::jsonb)
  )
  from public.appointments
  where review_approved is true and review_rating between 1 and 5;
$$;

create function public.nailspace_publish_review(
  p_id uuid, p_chat_id text, p_rating integer, p_text text, p_keep_text boolean, p_photo text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.appointments a
  set review_rating = p_rating,
      review_text = case when p_keep_text then a.review_text else nullif(p_text, '') end,
      review_approved = true,
      review_published_at = now()
  where a.id = p_id and a.chat_id = p_chat_id and p_rating between 1 and 5
    and a.review_published_at is null and a.review_approved is not false
    and (a.status = 'completed' or (a.status = 'confirmed' and exists (
      select 1 from public.slots s where s.id = a.slot_id and s.slot_time <= now() - interval '3 hours'
    )));
  if not found then
    return false;
  end if;
  if p_photo is not null then
    delete from public.appointment_photos where appointment_id = p_id and kind = 'review';
    insert into public.appointment_photos (appointment_id, kind, file_id) values (p_id, 'review', p_photo);
  end if;
  return true;
end;
$$;

revoke all on function public.nailspace_reserve(uuid, text, text, text, text, text, text, numeric, numeric, integer),
  public.nailspace_expire_holds(), public.nailspace_cancel(uuid, text, boolean),
  public.nailspace_delete_booking(uuid), public.nailspace_move_booking(uuid, uuid, text), public.nailspace_payment(uuid, text),
  public.nailspace_review_summary(), public.nailspace_publish_review(uuid, text, integer, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.nailspace_reserve(uuid, text, text, text, text, text, text, numeric, numeric, integer),
  public.nailspace_expire_holds(), public.nailspace_cancel(uuid, text, boolean),
  public.nailspace_delete_booking(uuid), public.nailspace_move_booking(uuid, uuid, text), public.nailspace_payment(uuid, text),
  public.nailspace_review_summary(), public.nailspace_publish_review(uuid, text, integer, text, boolean, text)
  to service_role;
