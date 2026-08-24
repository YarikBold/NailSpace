import { createClient } from 'npm:@supabase/supabase-js@2';

// Все значения берутся из секретов Edge Function (supabase secrets set ...)
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!; // внедряется автоматически
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; // внедряется автоматически
const MASTER_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID')!;
const NOTIFY_SECRET = Deno.env.get('NOTIFY_SECRET')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notify-secret',
};

// Ожидание ввода суммы: chat_id -> appointment_id (хранится в БД)
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const url = new URL(req.url);

  // ================= НАПОМИНАНИЯ (крон каждые 30 мин) =================
  if (req.method === 'GET' || url.searchParams.has('check_reminders')) {
    try {
      const now = new Date();
      const fromTime = new Date(now.getTime() + 50 * 60000).toISOString();
      const toTime = new Date(now.getTime() + 70 * 60000).toISOString();

      const { data: upcoming, error } = await supabase
        .from('appointments')
        .select('id, client_name, phone, service, slots!inner ( slot_time )')
        .eq('status', 'confirmed')
        .eq('reminder_sent', false)
        .gte('slots.slot_time', fromTime)
        .lte('slots.slot_time', toTime);

      if (error) return json({ error: error.message }, 500);

      for (const app of upcoming || []) {
        const t = new Date((app.slots as any).slot_time).toLocaleTimeString('ru-RU', {
          hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
        });
        await tg('sendMessage', {
          chat_id: MASTER_CHAT_ID,
          text: `⏰ *НАПОМИНАНИЕ!* В ${t}:\n👤 ${app.client_name} | 📞 ${app.phone}\n✨ ${app.service}`,
          parse_mode: 'Markdown',
        });
        await supabase.from('appointments').update({ reminder_sent: true }).eq('id', app.id);
      }
      return json({ success: true, reminders_sent: (upcoming || []).length });
    } catch (err: any) {
      return json({ error: err.message }, 500);
    }
  }

  // ================= POST =================
  if (req.method === 'POST') {
    try {
      const update = await req.json();

      // ---- Новая заявка с сайта ----
      if (update.action === 'new_appointment') {
        if (req.headers.get('x-notify-secret') !== NOTIFY_SECRET) {
          return json({ error: 'Unauthorized' }, 401);
        }
        const text =
          `💅 *НОВАЯ ЗАПИСЬ В NAILSPACE*\n\n` +
          `👤 *Клиент:* ${update.clientName}\n` +
          `📞 *Телефон:* ${update.phone}\n` +
          `✨ *Услуга:* ${update.service}\n` +
          `📅 *Время:* ${update.slotTime}\n` +
          `💰 *Стоимость:* ${update.price} ₽\n` +
          `📝 *Комментарий:* ${update.comment || '—'}`;

        await tg('sendMessage', {
          chat_id: MASTER_CHAT_ID,
          text,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Подтвердить', callback_data: `confirm_${update.appointmentId}` },
              { text: '💰 Занести в кассу', callback_data: `cash_${update.appointmentId}` },
            ]],
          },
        });
        return json({ success: true, sent: true });
      }

      // ---- Команды мастера (чужие чаты игнорируются) ----
      if (update.message?.text) {
        const chatId = String(update.message.chat.id);
        if (chatId !== String(MASTER_CHAT_ID)) return json({ success: true });
        const cmd = update.message.text.trim().toLowerCase().split('@')[0];

        // Ввод итоговой суммы для занесения в кассу
        const { data: pend } = await supabase
          .from('bot_pending_cash')
          .select('appointment_id').eq('chat_id', chatId).maybeSingle();

        if (pend?.appointment_id) {
          const numMatch = update.message.text.replace(',', '.').match(/\d+(?:\.\d{1,2})?/);
          if (!numMatch) {
            await tg('sendMessage', { chat_id: chatId, text: '⚠️ Пришли сумму числом, например: 750' });
            return json({ success: true });
          }
          const amountStr = numMatch[0];
          const card = await buildCard(pend.appointment_id);
          if (!card) {
            await supabase.from('bot_pending_cash').delete().eq('chat_id', chatId);
            return json({ success: true });
          }
          await tg('sendMessage', {
            chat_id: chatId,
            text: `💰 *Подтверди занесение в кассу*\n\n${card.text}\n\n💵 К оплате: *${amountStr} ₽*`,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[
              { text: `✅ Внести ${amountStr} ₽`, callback_data: `cashok_${pend.appointment_id}_${amountStr}` },
              { text: '❌ Отмена', callback_data: 'cashno' },
            ]] },
          });
          return json({ success: true });
        }

        if (cmd === '/start' || cmd === '/help') {
          await tg('sendMessage', {
            chat_id: chatId,
            text: '👋 Бот NailSpace\n\n📋 /journal — ближайшие записи\n📋 /journal_all — все заказы (ближайшие + завершённые)\n' +
                  '💰 /cashbox_day · /cashbox_week · /cashbox_month · /cashbox_all',
          });
          return json({ success: true });
        }

        if (cmd === '/journal') {
          const j = await buildJournal();
          const payload: any = { chat_id: chatId, text: j.text, parse_mode: 'Markdown' };
          if (j.keyboard) payload.reply_markup = { inline_keyboard: j.keyboard };
          await tg('sendMessage', payload);
          return json({ success: true });
        }

        if (cmd === '/journal_all') {
          const m = await buildAllMenu();
          await tg('sendMessage', {
            chat_id: chatId, text: m.text, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: m.keyboard },
          });
          return json({ success: true });
        }

        if (cmd.startsWith('/cashbox')) {
          const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
          let fromIso: string | null = null;
          let title = 'ЗА ВСЁ ВРЕМЯ';
          if (cmd === '/cashbox_day')   { fromIso = day + 'T00:00:00+03:00'; title = 'СЕГОДНЯ'; }
          if (cmd === '/cashbox_week')  { fromIso = new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }) + 'T00:00:00+03:00'; title = 'ЗА 7 ДНЕЙ'; }
          if (cmd === '/cashbox_month') { fromIso = day.slice(0, 7) + '-01T00:00:00+03:00'; title = 'ЗА МЕСЯЦ'; }

          let q = supabase.from('appointments')
            .select('client_name, service, price, completed_at')
            .eq('status', 'completed');
          if (fromIso) q = q.gte('completed_at', fromIso);
          const { data: rows } = await q.order('completed_at', { ascending: false });

          const list = rows || [];
          const total = list.reduce((s, a) => s + Number(a.price || 0), 0);
          let text = `💰 *КАССА — ${title}*\nВыполнено заказов: *${list.length}*\nИтого: *${total} ₽*`;
          list.slice(0, 30).forEach(a => {
            text += `\n• ${a.completed_at ? new Date(a.completed_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—'} — ${a.client_name} — ${a.price} ₽`;
          });
          if (list.length > 30) text += `\n…и ещё ${list.length - 30}`;
          await tg('sendMessage', { chat_id: chatId, text: text, parse_mode: 'Markdown' });
          return json({ success: true });
        }
      }

      // ---- Кнопки ----
      if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message.chat.id;
        const messageId = cb.message.message_id;

        // Навигация (без id в callback_data)
        if (cb.data === 'back_journal') {
          const j = await buildJournal();
          await editMessageText(chatId, messageId, j.text, j.keyboard);
          return json({ success: true });
        }
        if (cb.data === 'all_journal') {
          const m = await buildAllMenu();
          await editMessageText(chatId, messageId, m.text, m.keyboard);
          return json({ success: true });
        }
        if (cb.data === 'upcoming_list') {
          const j = await buildJournal();
          await editMessageText(chatId, messageId, j.text, j.keyboard);
          return json({ success: true });
        }
        if (cb.data === 'completed_list') {
          const c = await buildCompleted();
          await editMessageText(chatId, messageId, c.text, c.keyboard);
          return json({ success: true });
        }
        if (cb.data === 'cashno') {
          const { data: pend } = await supabase
            .from('bot_pending_cash')
            .select('appointment_id').eq('chat_id', String(chatId)).maybeSingle();
          if (pend) {
            await supabase.from('bot_pending_cash').delete().eq('chat_id', String(chatId));
            const card = await buildCard(pend.appointment_id);
            if (card) {
              await editMessageText(chatId, messageId, card.text, card.keyboard);
              await answerCallbackQuery(cb.id, 'Возврат к записи');
              return json({ success: true });
            }
          }
          await answerCallbackQuery(cb.id, 'Отменено');
          return json({ success: true });
        }

        // Действия с записью
        const parts = cb.data.split('_');
        const action = parts[0];
        const appointmentId = parts[1];
        if (!appointmentId) return json({ success: true });

        if (action === 'view') {
          const card = await buildCard(appointmentId);
          if (!card) return json({ success: true });
          await editMessageText(chatId, messageId, card.text, card.keyboard);
          return json({ success: true });
        }

        if (action === 'cash') {
          await supabase.from('bot_pending_cash')
            .upsert({ chat_id: String(chatId), appointment_id: appointmentId });
          const card = await buildCard(appointmentId);
          await tg('sendMessage', {
            chat_id: chatId,
            text: `💵 *Введи итоговую сумму* для записи:\n${card ? card.text : ''}\n\nПришли число, например: 750`,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'cashno' }]] },
          });
          return json({ success: true });
        }

        if (action === 'cashok') {
          const amount = parts[2];
          await supabase.from('appointments').update({
            status: 'completed',
            price: Number(amount),
            completed_at: new Date().toISOString(),
          }).eq('id', appointmentId);
          await supabase.from('bot_pending_cash').delete().eq('chat_id', String(chatId));
          await answerCallbackQuery(cb.id, `Внесено в кассу: ${amount} ₽ 💰`);
          const m = await buildAllMenu();
          await editMessageText(chatId, messageId, m.text, m.keyboard);
          return json({ success: true });
        }

        if (action === 'confirm') {
          const { error } = await supabase.from('appointments')
            .update({ status: 'confirmed' }).eq('id', appointmentId);
          if (error) {
            await answerCallbackQuery(cb.id, 'Ошибка БД: ' + error.message);
            return json({ error: error.message }, 500);
          }
          await answerCallbackQuery(cb.id, 'Запись подтверждена ✅');
          const card = await buildCard(appointmentId);
          if (card) await editMessageText(chatId, messageId, card.text, card.keyboard);
          return json({ success: true });
        }

        if (action === 'cancel') {
          const { data: app } = await supabase.from('appointments')
            .select('slot_id').eq('id', appointmentId).single();
          await supabase.from('appointments').update({ status: 'canceled' }).eq('id', appointmentId);
          if (app?.slot_id) await supabase.from('slots').update({ status: 'available' }).eq('id', app.slot_id);
          await answerCallbackQuery(cb.id, 'Запись отменена ❌');
          const card = await buildCard(appointmentId);
          if (card) await editMessageText(chatId, messageId, card.text, card.keyboard);
          return json({ success: true });
        }

        if (action === 'delete') {
          const { data: app } = await supabase.from('appointments')
            .select('status, slot_id').eq('id', appointmentId).single();
          await supabase.from('appointments').delete().eq('id', appointmentId);
          if (app?.slot_id) await supabase.from('slots').update({ status: 'available' }).eq('id', app.slot_id);
          await answerCallbackQuery(cb.id, 'Запись удалена 🗑');
          if (app?.status === 'completed') {
            const c = await buildCompleted();
            await editMessageText(chatId, messageId, c.text, c.keyboard);
          } else {
            const j = await buildJournal();
            await editMessageText(chatId, messageId, j.text, j.keyboard);
          }
          return json({ success: true });
        }

        return json({ success: true });
      }

      return json({ success: true });
    } catch (err: any) {
      return json({ error: err.message }, 500);
    }
  }

  return new Response('Method Not Allowed', { status: 405 });
});

/* ================= HELPERS ================= */

const statusRu = (s: string) =>
  ({ new: '🆕 новая', confirmed: '✅ подтверждена', completed: '💰 в кассе', canceled: '❌ отменена' }[s] || s);

// Карточка записи с кнопками по статусу
async function buildCard(id: string) {
  const { data: a } = await supabase.from('appointments')
    .select('id, client_name, phone, service, comment, price, status, slots!inner ( slot_time )')
    .eq('id', id).single();
  if (!a) return null;

  const time = new Date(a.slots.slot_time).toLocaleString('ru-RU', {
    weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
  });

  const text =
    `📋 *ЗАПИСЬ*\n` +
    `📅 ${time}\n` +
    `👤 ${a.client_name} | 📞 ${a.phone}\n` +
    `✨ ${a.service}\n` +
    `💰 Ориентир: ${a.price} ₽\n` +
    `📝 ${a.comment || '—'}\n` +
    `Статус: ${statusRu(a.status)}`;

  const keyboard: any[] = [];
  if (a.status === 'new') keyboard.push([{ text: '✅ Подтвердить', callback_data: `confirm_${id}` }]);
  if (a.status === 'new' || a.status === 'confirmed')
    keyboard.push([{ text: '💰 Занести в кассу', callback_data: `cash_${id}` }]);
  if (a.status !== 'completed')
    keyboard.push([
      { text: '❌ Отменить', callback_data: `cancel_${id}` },
      { text: '🗑 Удалить', callback_data: `delete_${id}` },
    ]);
  else
    keyboard.push([{ text: '🗑 Удалить', callback_data: `delete_${id}` }]);

  keyboard.push([{
    text: a.status === 'completed' ? '⬅ К завершённым' : '⬅ К журналу',
    callback_data: a.status === 'completed' ? 'completed_list' : 'back_journal',
  }]);

  return { text, keyboard };
}

// Ближайшие записи (new + confirmed)
async function buildJournal() {
  const { data: apps, error } = await supabase.from('appointments')
    .select('id, client_name, phone, service, price, status, slots!inner ( slot_time )')
    .in('status', ['new', 'confirmed'])
    .gte('slots.slot_time', new Date().toISOString())
    .order('slot_time', { foreignTable: 'slots', ascending: true })
    .limit(10);

  if (error) return { text: 'Ошибка БД: ' + error.message, keyboard: null };
  if (!apps || apps.length === 0) return { text: '📭 Ближайших записей нет.', keyboard: null };

  const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU', {
    weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
  });
  const mark = (s: string) => (s === 'confirmed' ? '✅' : '🆕');

  const nearest = apps[0];
  let text =
    `⏱ *БЛИЖАЙШАЯ ЗАПИСЬ*\n` +
    `📅 ${fmt(nearest.slots.slot_time)}\n` +
    `👤 ${nearest.client_name} | 📞 ${nearest.phone}\n` +
    `✨ ${nearest.service}\n` +
    `💰 ${nearest.price || '—'} ₽ · ${mark(nearest.status)} ${nearest.status === 'confirmed' ? 'подтверждена' : 'новая'}\n\n` +
    `👇 Нажми на запись, чтобы открыть карточку`;

  const keyboard: any[] = [[
    { text: `🔍 ${fmt(nearest.slots.slot_time)} — ${nearest.client_name}`, callback_data: `view_${nearest.id}` },
  ]];
  apps.slice(1).forEach((a: any) => {
    keyboard.push([{ text: `🔍 ${fmt(a.slots.slot_time)} — ${a.client_name}`, callback_data: `view_${a.id}` }]);
  });
  return { text, keyboard };
}

// Меню «все заказы»
async function buildAllMenu() {
  const { count: upcoming } = await supabase.from('appointments')
    .select('id, slots!inner ( slot_time )', { count: 'exact', head: true })
    .in('status', ['new', 'confirmed'])
    .gte('slots.slot_time', new Date().toISOString());

  const { count: done } = await supabase.from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'completed');

  const text = `📋 *ЖУРНАЛ ЗАПИСЕЙ*\n\n🆕 Будущих записей: *${upcoming ?? 0}*\n💰 Завершённых: *${done ?? 0}*\n\n👇 Выбери раздел`;
  const keyboard = [
    [{ text: `📅 Ближайшие (${upcoming ?? 0})`, callback_data: 'upcoming_list' }],
    [{ text: `💰 Завершённые (${done ?? 0})`, callback_data: 'completed_list' }],
  ];
  return { text, keyboard };
}

// Завершённые заказы
async function buildCompleted() {
  const { data: rows, error } = await supabase.from('appointments')
    .select('id, client_name, price, completed_at')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(20);

  if (error) return { text: 'Ошибка БД: ' + error.message, keyboard: null };
  if (!rows || rows.length === 0) return { text: '💰 Завершённых заказов нет.', keyboard: null };

  let text = `💰 *ЗАВЕРШЁННЫЕ ЗАКАЗЫ (${rows.length})*\n\n👇 Нажми на заказ, чтобы открыть полностью`;
  const keyboard = rows.map(r => [{
    text: `🔍 ${r.completed_at ? new Date(r.completed_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—'} — ${r.client_name} — ${r.price} ₽`,
    callback_data: `view_${r.id}`,
  }]);
  keyboard.push([{ text: '⬅ В общий журнал', callback_data: 'all_journal' }]);
  return { text, keyboard };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}

async function tg(method: string, payload: unknown) {
  await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  await tg('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: true });
}

async function editMessageText(chatId: number, messageId: number, text: string, keyboard: any[]) {
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'Markdown',
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
}
