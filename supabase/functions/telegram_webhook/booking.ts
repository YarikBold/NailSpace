import { BOT_TOKEN, MASTER_CHAT_ID, SUPABASE_URL, corsHeaders, json, supabase, tg, validateInitData } from './telegram.ts';

const address = Deno.env.get('NAILSPACE_ADDRESS')?.trim();
const entryDetails = [
  ['Подъезд', Deno.env.get('NAILSPACE_ENTRANCE')],
  ['Этаж', Deno.env.get('NAILSPACE_FLOOR')],
  ['Квартира', Deno.env.get('NAILSPACE_APARTMENT')],
  ['Домофон', Deno.env.get('NAILSPACE_INTERCOM')],
].flatMap(([label, value]) => label && value?.trim() ? [[label, value.trim()]] : []);
export const ADDRESS = address && [address, ...entryDetails.map(([label, value]) => `${label}: ${value}`)].join('\n');
const latitude = Number(Deno.env.get('NAILSPACE_LATITUDE'));
const longitude = Number(Deno.env.get('NAILSPACE_LONGITUDE'));
const location = Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
const amount = Number(Deno.env.get('NAILSPACE_PREPAYMENT_AMOUNT'));
const details = Deno.env.get('NAILSPACE_PAYMENT_DETAILS')?.trim();
const recipient = Deno.env.get('NAILSPACE_PAYMENT_RECIPIENT')?.trim();
const bank = Deno.env.get('NAILSPACE_PAYMENT_BANK')?.trim();
const holdMinutes = 30;
const miniAppUrl = 'https://yarikbold.github.io/NailSpace/miniapp/';
const activeStates = ['new', 'confirmed', 'awaiting_payment', 'payment_review'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dayMs = 86_400_000;

export function paymentSettings() {
  return Number.isFinite(amount) && amount > 0 && amount <= 1_000_000 && details && details.length <= 256 && bank
    ? { amount, details, recipient, bank } : null;
}

export function formatMoscow(time: string) {
  return new Date(time).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
  });
}

const dateKey = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
const slotTime = (row: any) => (Array.isArray(row.slots) ? row.slots[0] : row.slots)?.slot_time;
const slotVersion = (time: string) => Math.floor(Date.parse(time) / 1000).toString(36);
const clean = (value: unknown, limit: number) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const money = (value: number) => new Intl.NumberFormat('ru-RU').format(value) + ' ₽';

export async function expireHolds() {
  const { error } = await supabase.rpc('nailspace_expire_holds');
  if (error) throw error;
}

export async function reserveBooking(input: {
  slotId: string; chatId?: string; name: string; phone: string; contact?: string | null;
  service: string; comment?: string; price: number;
}) {
  await expireHolds();
  const payment = input.chatId ? paymentSettings() : null;
  if (input.chatId && !payment) throw new Error('Предоплата пока недоступна. Напишите мастеру.');
  const { data, error } = await supabase.rpc('nailspace_reserve', {
    p_slot_id: input.slotId, p_chat_id: input.chatId ?? null, p_name: input.name, p_phone: input.phone,
    p_contact: input.contact ?? null, p_service: input.service, p_comment: input.comment || null,
    p_price: input.price, p_prepayment: payment?.amount ?? null, p_hold_minutes: holdMinutes,
  });
  if (error) throw error;
  return data?.id ? data : null;
}

function richTable(rows: string[][]) {
  return {
    type: 'table', is_striped: true, is_compact: true,
    cells: rows.map(([label, value]) => [{ text: { type: 'bold', text: label } }, { text: value }]),
  };
}

export async function sendPaymentMessage(chatId: string, booking: any) {
  const config = paymentSettings();
  if (!config || booking.status === 'payment_review') {
    await tg('sendMessage', { chat_id: chatId, text: config
      ? 'Мастер уже проверяет предоплату. Подтверждение придёт сюда.'
      : 'Реквизиты временно недоступны. Напиши мастеру.' });
    return;
  }
  const copyValue = /^\+?\d[\d\s()-]+$/.test(config.details) ? config.details.replace(/[^\d+]/g, '') : config.details;
  const keyboard = [
    [{ text: 'Скопировать номер', copy_text: { text: copyValue } }],
    [{ text: '✅ Я перевела', callback_data: `pay_sent_${booking.id}` }],
    [{ text: 'Отменить и освободить время', callback_data: `cbook_cancel_${booking.id}` }],
  ];
  const rows = [['Банк', config.bank], ['Телефон', config.details]];
  if (config.recipient) rows.push(['Получатель', config.recipient]);
  const title = `💳 Предоплата · ${money(booking.prepayment_amount)}`;
  const note = `Окошко удерживается до ${formatMoscow(booking.payment_expires_at)} (МСК). После перевода нажми «Я перевела».`;
  const options = { chat_id: chatId, reply_markup: { inline_keyboard: keyboard }, protect_content: true };
  const rich = await tg('sendRichMessage', {
    ...options, rich_message: { blocks: [
      { type: 'paragraph', text: { type: 'bold', text: title } },
      richTable(rows),
      { type: 'paragraph', text: note },
    ] },
  });
  if (!rich?.ok) await tg('sendMessage', { ...options, text: [title, rows.map(row => row.join(': ')).join('\n'), note].join('\n\n') });
}

async function sendAddressReminder(row: any) {
  const time = `${formatMoscow(slotTime(row))} (МСК)`;
  const rows = [['Время', time], ['Услуга', row.service], ['Адрес', address!], ...entryDetails];
  const title = '💅 Завтра у тебя запись на маникюр';
  const note = 'Подтверди, пожалуйста, что придёшь.';
  const keyboard: { text: string; callback_data?: string; url?: string }[][] = [
    [{ text: '✅ Я приду', callback_data: `attend_${row.id}_${slotVersion(slotTime(row))}` }],
  ];
  if (location) keyboard.push([{
    text: 'Открыть в Яндекс Картах',
    url: `https://yandex.ru/maps/?pt=${location.longitude},${location.latitude}&z=18&l=map`,
  }]);
  const options = {
    chat_id: row.chat_id,
    reply_markup: { inline_keyboard: keyboard },
    protect_content: true,
  };
  const map = location ? [{ type: 'map', location, zoom: 17, width: 600, height: 330 }] : [];
  const rich = await tg('sendRichMessage', {
    ...options, rich_message: { blocks: [
      ...map, { type: 'paragraph', text: { type: 'bold', text: title } },
      richTable(rows), { type: 'paragraph', text: note },
    ] },
  });
  if (rich?.ok) return true;
  if (location) await tg('sendVenue', {
    chat_id: row.chat_id, ...location, title: 'NailSpace', address,
    disable_notification: true, protect_content: true,
  });
  const plain = await tg('sendMessage', { ...options, text: [title, rows.map(row => row.join(': ')).join('\n'), note].join('\n\n') });
  return Boolean(plain?.ok);
}

async function notifyPayment(booking: any) {
  if (booking.payment_notified_at) return;
  const claimedAt = new Date().toISOString();
  const { data: claim, error } = await supabase.from('appointments').update({ payment_notified_at: claimedAt })
    .eq('id', booking.id).eq('status', 'payment_review').is('payment_notified_at', null).select('id').maybeSingle();
  if (error) throw error;
  if (!claim) return;
  let delivered = false;
  try {
    const sent = await tg('sendMessage', {
      chat_id: MASTER_CHAT_ID,
      text: `💳 Клиентка сообщила о переводе ${money(booking.prepayment_amount)}.\n\nКлиент: ${booking.client_name}\nКонтакт: ${booking.contact || booking.phone}\nУслуга: ${booking.service}\nВремя: ${formatMoscow(slotTime(booking))} (МСК)\n\nПроверь поступление в своём банке.`,
      reply_markup: { inline_keyboard: [[
        { text: '✅ Подтвердить оплату', callback_data: `payok_${booking.id}` },
        { text: '❌ Отклонить и открыть слот', callback_data: `payno_${booking.id}` },
      ]] },
    });
    delivered = Boolean(sent?.ok);
  } finally {
    if (!delivered) await supabase.from('appointments').update({ payment_notified_at: null })
      .eq('id', booking.id).eq('payment_notified_at', claimedAt);
  }
}

export async function retryPaymentNotices() {
  const { data, error } = await supabase.from('appointments')
    .select('id, client_name, phone, contact, service, prepayment_amount, payment_notified_at, slots!inner(slot_time)')
    .eq('status', 'payment_review').is('payment_notified_at', null)
    .gt('slots.slot_time', new Date().toISOString()).limit(25);
  if (error) throw error;
  for (const row of data) await notifyPayment(row);
}

export async function submitPayment(id: string, chatId: string) {
  if (!uuid.test(id)) return false;
  const { error } = await supabase.rpc('nailspace_payment', { p_id: id, p_chat_id: chatId });
  if (error) throw error;
  const { data, error: lookupError } = await supabase.from('appointments')
    .select('id, client_name, phone, contact, service, prepayment_amount, payment_notified_at, slots!inner(slot_time)')
    .eq('id', id).eq('chat_id', chatId).eq('status', 'payment_review').maybeSingle();
  if (lookupError) throw lookupError;
  if (!data) {
    await expireHolds();
    return false;
  }
  await notifyPayment(data).catch(error => console.error('Could not send payment notice', error));
  return true;
}

export async function approvePayment(id: string) {
  if (!uuid.test(id)) return false;
  const { data, error } = await supabase.rpc('nailspace_payment', { p_id: id, p_chat_id: null });
  if (error) throw error;
  if (!data?.id) return false;
  const slot = await supabase.from('slots').select('slot_time').eq('id', data.slot_id).single();
  const time = slot.data ? ` на ${formatMoscow(slot.data.slot_time)} (МСК)` : '';
  await tg('sendMessage', { chat_id: data.chat_id, text: `✅ Предоплата подтверждена. Ты записана${time}! До встречи 💅` });
  if (data.phone !== 'Telegram') {
    await supabase.from('bot_pending_photo').upsert({ chat_id: data.chat_id, appointment_id: data.id, kind: 'before' });
    await tg('sendMessage', {
      chat_id: data.chat_id,
      text: 'Можешь прислать фото ногтей, чтобы мастер заранее оценила работу.',
      reply_markup: { inline_keyboard: [[{ text: 'Пропустить', callback_data: `cphoto_skip_before_${data.id}` }]] },
    });
  }
  return true;
}

export async function cancelBooking(id: string, chatId?: string, paymentOnly = false) {
  if (!uuid.test(id)) return null;
  const { data, error } = await supabase.rpc('nailspace_cancel', { p_id: id, p_chat_id: chatId ?? null, p_payment_only: paymentOnly });
  if (error) throw error;
  if (!data?.id) return null;
  if (chatId && data.payment_submitted_at) {
    await tg('sendMessage', {
      chat_id: MASTER_CHAT_ID,
      text: `Клиентка ${data.client_name} отменила запись после сообщения о переводе. Проверь перевод и свяжись с ней: ${data.contact || data.phone}.`,
    });
  } else if (chatId && data.prepayment_amount == null) {
    await tg('sendMessage', { chat_id: MASTER_CHAT_ID, text: `Клиентка ${data.client_name} отменила запись на услугу «${data.service}».` });
  } else if (!chatId && data.chat_id) {
    await tg('sendMessage', {
      chat_id: data.chat_id,
      text: paymentOnly ? '❌ Мастер не подтвердила предоплату. Окошко снова свободно. Если ты уже перевела деньги, напиши мастеру.'
        : '❌ Мастер отменила запись. Если ты уже перевела предоплату, напиши мастеру.',
    });
  }
  return data;
}

export async function remindTomorrow() {
  if (!ADDRESS) return;
  const now = new Date();
  const inOneDay = new Date(now.getTime() + dayMs);
  const tomorrow = dateKey(inOneDay);
  const { data, error } = await supabase.from('appointments')
    .select('id, slot_id, chat_id, service, slots!inner(slot_time)').eq('status', 'confirmed')
    .not('chat_id', 'is', null).is('day_reminder_sent_at', null)
    .gte('slots.slot_time', tomorrow + 'T00:00:00+03:00').lte('slots.slot_time', inOneDay.toISOString());
  if (error) throw error;
  for (const row of data) {
    const claimedAt = new Date().toISOString();
    const { data: claim, error: claimError } = await supabase.from('appointments').update({ day_reminder_sent_at: claimedAt })
      .eq('id', row.id).eq('slot_id', row.slot_id).eq('status', 'confirmed').is('day_reminder_sent_at', null).select('id').maybeSingle();
    if (claimError) throw claimError;
    if (!claim) continue;
    let delivered = false;
    try {
      delivered = await sendAddressReminder(row);
    } finally {
      if (!delivered) await supabase.from('appointments').update({ day_reminder_sent_at: null })
        .eq('id', row.id).eq('day_reminder_sent_at', claimedAt);
    }
  }
}

export async function confirmAttendance(id: string, chatId: string, version: string) {
  if (!uuid.test(id)) return null;
  const { data, error } = await supabase.from('appointments').select('id, slot_id, client_name, attendance_confirmed_at, slots!inner(slot_time)')
    .eq('id', id).eq('chat_id', chatId).eq('status', 'confirmed')
    .gt('slots.slot_time', new Date().toISOString()).maybeSingle();
  if (error) throw error;
  if (!data || slotVersion(slotTime(data)) !== version) return null;
  if (data.attendance_confirmed_at) return true;
  const { data: result, error: updateError } = await supabase.from('appointments')
    .update({ attendance_confirmed_at: new Date().toISOString() }).eq('id', id).eq('chat_id', chatId)
    .eq('slot_id', data.slot_id).eq('status', 'confirmed').is('attendance_confirmed_at', null).select('id').maybeSingle();
  if (updateError) throw updateError;
  if (result) await tg('sendMessage', {
    chat_id: MASTER_CHAT_ID, text: `✅ ${data.client_name} подтвердила визит на ${formatMoscow(slotTime(data))} (МСК).`,
  });
  return true;
}

export async function requestReview(id: string, chatId: string) {
  const result = await tg('sendMessage', {
    chat_id: chatId,
    text: '💅 Как прошёл визит? Поставь оценку от 1 до 5. По желанию добавь текст или фото в публичный отзыв.',
    reply_markup: { inline_keyboard: [
      [1, 2, 3, 4, 5].map(rating => ({ text: `${rating} ⭐`, callback_data: `creview_star_${rating}_${id}` })),
    ] },
  });
  return Boolean(result?.ok);
}

export async function reviewEligibility(id: string, chatId: string) {
  if (!uuid.test(id)) return false;
  const { data, error } = await supabase.from('appointments')
    .select('status, slots!inner(slot_time)').eq('id', id).eq('chat_id', chatId)
    .is('review_published_at', null).not('review_approved', 'is', false).in('status', ['completed', 'confirmed']).maybeSingle();
  if (error) throw error;
  return Boolean(data && (data.status === 'completed' || Date.parse(slotTime(data)) <= Date.now() - 3 * 3_600_000));
}

export async function publishReview(id: string, chatId: string, rating: number, text?: string, photo?: string) {
  if (!uuid.test(id) || !Number.isInteger(rating) || rating < 1 || rating > 5) return false;
  const { data, error } = await supabase.rpc('nailspace_publish_review', {
    p_id: id, p_chat_id: chatId, p_rating: rating, p_text: text ?? null, p_keep_text: text === undefined, p_photo: photo ?? null,
  });
  if (error) throw error;
  if (data) await tg('sendMessage', { chat_id: MASTER_CHAT_ID, text: `⭐ Новый отзыв в профиле · ${rating}/5` });
  return Boolean(data);
}

export async function reviewPhoto(id: string) {
  if (!uuid.test(id)) return new Response(null, { status: 404 });
  const { data } = await supabase.from('appointment_photos').select('file_id, appointments!inner(review_approved)')
    .eq('appointment_id', id).eq('kind', 'review').eq('appointments.review_approved', true).limit(1).maybeSingle();
  if (!data) return new Response(null, { status: 404 });
  const info = await tg('getFile', { file_id: data.file_id });
  if (!info?.result?.file_path) return new Response(null, { status: 404 });
  const image = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`);
  if (!image.ok) return new Response(null, { status: 404 });
  return new Response(image.body, { headers: { ...corsHeaders, 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300' } });
}

export async function bookingApi(update: any) {
  const action = update.action;
  if (action === 'review_summary') {
    const { data, error } = await supabase.rpc('nailspace_review_summary');
    if (error) throw error;
    return json(data);
  }
  if (action === 'reviews') {
    const rating = Number(update.rating);
    const page = Math.min(Math.max(Number.isInteger(update.page) ? update.page : 0, 0), 1000);
    const size = 12;
    let query = supabase.from('appointments').select('id, service, review_rating, review_text, review_published_at, appointment_photos(kind)')
      .eq('review_approved', true).gte('review_rating', 1).lte('review_rating', 5)
      .eq('appointment_photos.kind', 'review');
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5) query = query.eq('review_rating', rating);
    if (typeof update.service === 'string' && update.service) query = query.eq('service', update.service);
    if (update.sort === 'highest' || update.sort === 'lowest') {
      query = query.order('review_rating', { ascending: update.sort === 'lowest' });
    }
    const { data, error } = await query.order('review_published_at', { ascending: false, nullsFirst: false })
      .order('id').range(page * size, page * size + size);
    if (error) throw error;
    return json({ more: data.length > size, reviews: data.slice(0, size).map(({ appointment_photos, ...row }) => ({
      ...row, hasPhoto: appointment_photos.length > 0,
    })) });
  }
  if (action === 'available_slots') {
    await expireHolds();
    const { data, error } = await supabase.from('slots').select('id, slot_time')
      .eq('status', 'available').gt('slot_time', new Date().toISOString()).order('slot_time');
    if (error) throw error;
    return json({ slots: data });
  }
  if (action === 'website_booking') {
    const name = clean(update.name, 120);
    const phone = clean(update.phone, 30);
    const service = clean(update.service, 250);
    const price = Number(update.price);
    if (!uuid.test(update.slotId || '') || !name || !/^\+7 \(\d{3}\) \d{3}-\d{2}-\d{2}$/.test(phone)
      || !service || !Number.isFinite(price) || price < 0 || price > 1_000_000) return json({ error: 'Проверьте данные записи.' }, 400);
    const booking = await reserveBooking({ slotId: update.slotId, name, phone, service, price,
      contact: clean(update.contact, 200), comment: clean(update.comment, 1200) });
    if (!booking) return slotUnavailable();
    const slot = await supabase.from('slots').select('slot_time').eq('id', booking.slot_id).single();
    await tg('sendMessage', {
      chat_id: MASTER_CHAT_ID,
      text: `💅 Новая запись с сайта\n\nКлиент: ${name}\nТелефон: ${phone}\nУслуга: ${service}\n${slot.data ? formatMoscow(slot.data.slot_time) : ''}`,
      reply_markup: { inline_keyboard: [[{ text: 'Открыть карточку', callback_data: `view_${booking.id}` }]] },
    }).catch(() => console.error('Could not send website booking notice', booking.id));
    return json({ id: booking.id });
  }

  if (!['client_booking', 'client_bookings', 'client_pay', 'client_cancel', 'client_move', 'client_review'].includes(action)) return null;
  const user = await validateInitData(update.initData);
  if (!user) return json({ error: 'Откройте приложение в Telegram или запустите его заново.' }, 401);
  const chatId = String(user.id);
  if (action === 'client_booking') {
    if (!paymentSettings()) return json({ error: 'Предоплата пока недоступна. Напишите мастеру.' }, 503);
    if (!uuid.test(update.slotId || '') || !uuid.test(update.serviceId || '')) return json({ error: 'Выберите услугу и время.' }, 400);
    const { data: service, error } = await supabase.from('services').select('name, price_min')
      .eq('id', update.serviceId).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!service) return json({ error: 'Услуга больше недоступна.' }, 409);
    const photoPrefix = `${SUPABASE_URL}/storage/v1/object/public/photos/`;
    const photos = Array.isArray(update.photos) ? update.photos.slice(0, 3).filter((url: unknown) =>
      typeof url === 'string' && url.startsWith(photoPrefix) && /^ref_[\w.-]+$/.test(url.slice(photoPrefix.length))) : [];
    const comment = [clean(update.comment, 1000), ...(photos.length ? ['Фото-референсы:', ...photos] : [])].filter(Boolean).join('\n');
    const booking = await reserveBooking({ slotId: update.slotId, chatId,
      name: clean([user.first_name, user.last_name].filter(Boolean).join(' '), 120) || 'Клиент из Telegram',
      phone: 'Telegram', contact: user.username ? '@' + user.username : null, service: service.name, comment, price: service.price_min,
    });
    if (!booking) return slotUnavailable();
    return json({ booking: { id: booking.id, status: booking.status, service: booking.service,
      payment_expires_at: booking.payment_expires_at, prepayment_amount: booking.prepayment_amount }, payment: paymentSettings() });
  }
  if (action === 'client_bookings') {
    await expireHolds();
    const now = new Date();
    const reviewBefore = new Date(now.getTime() - 3 * 3_600_000).toISOString();
    const fields = 'id, service, price, status, prepayment_amount, payment_expires_at, payment_submitted_at, slots!inner(slot_time)';
    const [active, past] = await Promise.all([
      supabase.from('appointments').select(fields).eq('chat_id', chatId).in('status', activeStates)
        .gt('slots.slot_time', now.toISOString()).order('slots(slot_time)').limit(50),
      supabase.from('appointments').select('id, service, status, review_rating, review_text, slots!inner(slot_time)').eq('chat_id', chatId)
        .is('review_published_at', null).not('review_approved', 'is', false)
        .in('status', ['completed', 'confirmed'])
        .lte('slots.slot_time', now.toISOString()).order('slots(slot_time)', { ascending: false }).limit(50),
    ]);
    if (active.error || past.error) throw active.error || past.error;
    return json({
      bookings: active.data.map(row => ({ ...row, slotTime: slotTime(row) })),
      reviewable: past.data.filter(row => row.status === 'completed' || slotTime(row) <= reviewBefore)
        .map(row => ({ id: row.id, service: row.service, slotTime: slotTime(row), rating: row.review_rating, text: row.review_text })),
      payment: active.data.some(row => row.status === 'awaiting_payment') ? paymentSettings() : null,
    });
  }
  const id = update.appointmentId;
  if (!uuid.test(id || '')) return json({ error: 'Запись не найдена.' }, 404);
  if (action === 'client_pay') {
    return await submitPayment(id, chatId) ? json({ success: true })
      : json({ error: 'Резерв истёк или запись уже обработана. Если перевод уже сделан, напишите мастеру.' }, 409);
  }
  if (action === 'client_cancel') {
    return await cancelBooking(id, chatId) ? json({ success: true }) : json({ error: 'Запись уже закрыта.' }, 409);
  }
  if (action === 'client_move') {
    if (!uuid.test(update.slotId || '')) return slotUnavailable();
    await expireHolds();
    const { data, error } = await supabase.rpc('nailspace_move_booking', { p_id: id, p_slot_id: update.slotId, p_chat_id: chatId });
    if (error) throw error;
    if (!data) return slotUnavailable();
    const moved = await supabase.from('appointments').select('client_name, service, slots!inner(slot_time)').eq('id', id).single();
    if (moved.data) await tg('sendMessage', {
      chat_id: MASTER_CHAT_ID,
      text: `🔄 ${moved.data.client_name} перенесла запись «${moved.data.service}» на ${formatMoscow(slotTime(moved.data))} (МСК).`,
    });
    return json({ success: true });
  }
  if (!Number.isInteger(update.rating) || update.rating < 1 || update.rating > 5) return json({ error: 'Выберите оценку от 1 до 5.' }, 400);
  return await publishReview(id, chatId, update.rating, clean(update.text, 1200))
    ? json({ success: true }) : json({ error: 'Отзыв уже опубликован или эта запись пока недоступна для отзыва.' }, 409);
}

function slotUnavailable() {
  return json({ error: 'Окошко уже занято или прошло. Выберите другое время.' }, 409);
}
