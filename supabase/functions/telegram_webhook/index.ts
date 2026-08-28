import { createClient } from 'npm:@supabase/supabase-js@2';

// Все значения — из секретов (supabase secrets set ...)
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

const PHOTO_CAPTIONS: Record<string, string> = {
  before: '📷 Исходник ногтей клиента',
  ref: '📸 Референс (как хочет сделать)',
};

const SERVICES = [
  { name: 'Покрытие на свои', price: 600 },
  { name: 'Наращивание 1–5', price: 750 },
  { name: 'Наращивание 5–8', price: 900 },
  { name: 'Коррекция До 5', price: 650 },
  { name: 'Коррекция 5–8', price: 800 },
];

const SLOT_TIMES = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const url = new URL(req.url);

  // ================= КРОН (каждые 30 мин) =================
  if (req.method === 'GET' && url.searchParams.has('check_reminders')) {
    try {
      // --- 1. Утренний дайджест: полный список записей на сегодня (в 09:xx по МСК, один раз) ---
      const mskNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
      const mskHour = mskNow.getHours();
      const mskMinute = mskNow.getMinutes();
      const mskDay = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });

      if (mskHour === 9 && mskMinute < 30) {
        const { data: already } = await supabase.from('bot_digest_log').select('day').eq('day', mskDay).maybeSingle();
        if (!already) {
          const fromIso = mskDay + 'T00:00:00+03:00';
          const toIso = mskDay + 'T23:59:59+03:00';
          const { data: list } = await supabase.from('appointments')
            .select('id, client_name, phone, contact, service, status, slots!inner ( slot_time )')
            .in('status', ['new', 'confirmed'])
            .gte('slots.slot_time', fromIso)
            .lte('slots.slot_time', toIso)
            .order('slot_time', { foreignTable: 'slots', ascending: true });

          let text = `☀️ Доброе утро! Записи на сегодня (${mskDay}):\n`;
          if (!list || list.length === 0) {
            text += '\n📭 Записей на сегодня нет.';
          } else {
            list.forEach((a: any, i: number) => {
              const t = new Date(a.slots.slot_time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
              text += `\n${i + 1}. ${t} — ${a.client_name} | ${a.phone}\n   ✨ ${a.service}`;
            });
            text += `\n\nВсего записей: ${list.length}\n📋 /journal — открыть карточки`;
          }
          await tg('sendMessage', { chat_id: MASTER_CHAT_ID, text: text });
          await supabase.from('bot_digest_log').insert({ day: mskDay });
        }
      }

      // --- 2. Ближайшие записи в течение часа: полные данные + фото ---
      const nowIso = new Date().toISOString();
      const in60Iso = new Date(Date.now() + 60 * 60000).toISOString();
      const { data: nearestList } = await supabase.from('appointments')
        .select('id, client_name, phone, contact, service, comment, price, status, chat_id, slots!inner ( slot_time )')
        .in('status', ['new', 'confirmed'])
        .eq('reminder_sent', false)
        .gte('slots.slot_time', nowIso)
        .lte('slots.slot_time', in60Iso)
        .order('slot_time', { foreignTable: 'slots', ascending: true });

      if (nearestList) {
        for (const nearest of nearestList) {
          const t = new Date(nearest.slots.slot_time).toLocaleString('ru-RU', {
            weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
          });
          
          // Уведомление мастеру
          const text =
            `⏰ *ЧЕРЕЗ ЧАС ЗАПИСЬ!*\n\n` +
            `📅 ${t}\n` +
            `👤 ${nearest.client_name} | 📞 ${nearest.phone}\n` +
            (nearest.contact ? `🔗 Контакт: ${nearest.contact}\n` : '') +
            `✨ ${nearest.service}\n` +
            `💰 ${nearest.price} ₽ · ${statusRu(nearest.status)}\n` +
            `📝 ${nearest.comment || '—'}`;
          await tg('sendMessage', { chat_id: MASTER_CHAT_ID, text: text, parse_mode: 'Markdown' });
          await sendPhotos(MASTER_CHAT_ID, nearest.id);
          
          // Напоминание клиенту
          if (nearest.chat_id) {
            await tg('sendMessage', {
               chat_id: nearest.chat_id,
               text: `🔔 *Напоминание!*\nЧерез час у тебя запись на маникюр:\n\n✨ Услуга: ${nearest.service}\n📅 Время: ${t}\n\nЖдем тебя!`,
               parse_mode: 'Markdown'
            });
          }
          
          
          await supabase.from('appointments').update({ reminder_sent: true }).eq('id', nearest.id);
        }
      }

      // --- 3. Триггер отзывов (спустя 3 часа после начала) ---
      const reviewThresholdIso = new Date(Date.now() - 3 * 60 * 60000).toISOString();
      const { data: forReview } = await supabase.from('appointments')
        .select('id, chat_id, slots!inner ( slot_time )')
        .eq('status', 'confirmed')
        .is('review_requested_at', null)
        .not('chat_id', 'is', null)
        .lte('slots.slot_time', reviewThresholdIso)
        .order('slot_time', { foreignTable: 'slots', ascending: true });
        
      if (forReview) {
         for (const app of forReview) {
            await supabase.from('appointments').update({ review_requested_at: new Date().toISOString() }).eq('id', app.id);
            await tg('sendMessage', {
               chat_id: app.chat_id,
               text: `👋 Привет! Надеюсь, тебе всё понравилось.\nОцени, пожалуйста, как прошла запись от 1 до 5:`,
               reply_markup: { inline_keyboard: [[
                 { text: '1⭐️', callback_data: `creview_star_1_${app.id}` },
                 { text: '2⭐️', callback_data: `creview_star_2_${app.id}` },
                 { text: '3⭐️', callback_data: `creview_star_3_${app.id}` },
                 { text: '4⭐️', callback_data: `creview_star_4_${app.id}` },
                 { text: '5⭐️', callback_data: `creview_star_5_${app.id}` }
               ]] }
            });
         }
      }

      return json({ success: true });
    } catch (err: any) {
      return json({ error: err.message }, 500);
    }
  }

  // ================= НАСТРОЙКА КОМАНД БОТА =================
  if (req.method === 'GET' && url.searchParams.has('setup_commands')) {
    try {
      // Для всех пользователей (клиентов) — пустой список команд (скрываем команды BotFather)
      await tg('setMyCommands', {
        commands: [],
        scope: { type: 'all_private_chats' }
      });

      // Для мастера — полный набор команд
      await tg('setMyCommands', {
        commands: [
          { command: 'start', description: 'Перезапустить бот' },
          { command: 'journal', description: 'Ближайшие записи' },
          { command: 'journal_all', description: 'Все заказы (ближайшие + завершённые)' },
          { command: 'slots', description: 'Управление окошками' },
          { command: 'slots_week', description: 'Добавить окошки на неделю' },
          { command: 'cashbox_day', description: 'Касса за день' },
          { command: 'cashbox_week', description: 'Касса за неделю' },
          { command: 'cashbox_month', description: 'Касса за месяц' },
          { command: 'cashbox_all', description: 'Касса за всё время' },
        ],
        scope: { type: 'chat', chat_id: Number(MASTER_CHAT_ID) }
      });

      return json({ success: true, message: 'Commands configured: empty for clients, full for master' });
    } catch (err: any) {
      return json({ error: err.message }, 500);
    }
  }

  // ================= DEBUG WEBHOOK =================
  if (req.method === 'GET' && url.searchParams.has('check_webhook')) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
      const data = await res.json();
      return json(data);
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
          `🔗 Контакт${update.contactType ? ` (${update.contactType})` : ''}: ${update.contact || '—'}\n` +
          `✨ *Услуга:* ${update.service}\n` +
          `📅 *Время:* ${update.slotTime}\n` +
          `💰 *Стоимость:* ${update.price} ₽\n` +
          `📝 *Комментарий:* ${update.comment || '—'}`;

        await tg('sendMessage', {
          chat_id: MASTER_CHAT_ID,
          text: text,
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

      // ---- Фото от мастера (когда функция ждёт фото) ----
      if (update.message?.photo) {
        const chatId = String(update.message.chat.id);
        const isMaster = chatId === String(MASTER_CHAT_ID);
        
        // Фото для отзыва (клиент)
        const { data: pendRev } = await supabase.from('bot_pending_review')
          .select('appointment_id, step').eq('chat_id', chatId).maybeSingle();
        if (pendRev?.step === 'photo' && !isMaster) {
           const fileId = update.message.photo[update.message.photo.length - 1].file_id;
           await supabase.from('appointment_photos').insert({ appointment_id: pendRev.appointment_id, kind: 'review', file_id: fileId });
           await supabase.from('bot_pending_review').delete().eq('chat_id', chatId);
           await tg('sendMessage', { chat_id: chatId, text: 'Супер! Отзыв с фото сохранен. Ждем тебя снова! 💅' });
           await tg('sendMessage', { chat_id: MASTER_CHAT_ID, text: `⭐️ Получен новый отзыв (с фото) от клиента!` });
           return json({ success: true });
        }

        const { data: pend } = await supabase.from('bot_pending_photo')
          .select('appointment_id, kind').eq('chat_id', chatId).maybeSingle();

        if (pend) {
          const fileId = update.message.photo[update.message.photo.length - 1].file_id;
          // заменяем фото этого типа, если оно уже было
          await supabase.from('appointment_photos')
            .delete().eq('appointment_id', pend.appointment_id).eq('kind', pend.kind);
          await supabase.from('appointment_photos')
            .insert({ appointment_id: pend.appointment_id, kind: pend.kind, file_id: fileId });

          if (!isMaster) {
            if (pend.kind === 'before') {
               await supabase.from('bot_pending_photo').update({ kind: 'ref' }).eq('chat_id', chatId);
               await tg('sendMessage', { 
                   chat_id: chatId, 
                   text: 'Принято! 👌\nТеперь можешь прислать фото-референс (дизайн, который хочешь сделать).\n\n📸 *Пришли фото* или нажми пропустить.',
                   parse_mode: 'Markdown',
                   reply_markup: { inline_keyboard: [[{ text: '⏭ Пропустить', callback_data: `cphoto_skip_ref_${pend.appointment_id}` }]] }
               });
            } else {
               await supabase.from('bot_pending_photo').delete().eq('chat_id', chatId);
               await tg('sendMessage', { chat_id: chatId, text: 'Супер! Все фото сохранены. До встречи! 👋' });
               await tg('sendMessage', { chat_id: MASTER_CHAT_ID, text: `🖼 Клиент добавил фото к записи!` });
            }
          } else {
            await supabase.from('bot_pending_photo').delete().eq('chat_id', chatId);
            await tg('sendMessage', {
              chat_id: chatId,
              text: `✅ ${PHOTO_CAPTIONS[pend.kind] || pend.kind} — сохранено!\nОткрываю карточку записи…`,
            });
            await sendCardWithPhotos(chatId, pend.appointment_id);
          }
        }
        return json({ success: true });
      }

      // ---- Текст: команды, ввод суммы, отмена ожидания фото ----
      if (update.message?.text) {
        const chatId = String(update.message.chat.id);
        const isMaster = chatId === String(MASTER_CHAT_ID);
        const cmd = update.message.text.trim().toLowerCase().split('@')[0];

        if (!isMaster) {
           try {
         // Ввод текста (в т.ч. текстовый отзыв)
         const { data: pendRev } = await supabase.from('bot_pending_review')
           .select('appointment_id, step').eq('chat_id', chatId).maybeSingle();
         if (pendRev?.step === 'text') {
            await supabase.from('appointments').update({ review_text: update.message.text }).eq('id', pendRev.appointment_id);
            await supabase.from('bot_pending_review').update({ step: 'photo' }).eq('chat_id', chatId);
            await tg('sendMessage', {
               chat_id: chatId,
               text: `Спасибо за комментарий! 📝\n\nМожешь прикрепить фото готового маникюра (просто отправь фото) или пропустить:`,
               reply_markup: { inline_keyboard: [[{ text: '⏭ Пропустить', callback_data: `creview_skip_photo_${pendRev.appointment_id}` }]] }
            });
            return json({ success: true });
         }

             // Клиентский режим
             const { data: pendBook } = await supabase.from('bot_pending_booking').select('*').eq('chat_id', chatId).maybeSingle();
             if (pendBook && pendBook.step === 'name') {
               const name = update.message.text.trim();
               await supabase.from('bot_pending_booking').update({ client_name: name, step: 'phone' }).eq('chat_id', chatId);
               await tg('sendMessage', {
                 chat_id: chatId,
                 text: `Отлично, ${name}! Теперь поделись своим номером телефона для связи (нажми кнопку ниже):`,
                 reply_markup: { keyboard: [[{ text: '📱 Поделиться контактом', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
               });
             } else {
               const { data: pastApps } = await supabase.from('appointments').select('id').eq('chat_id', chatId).limit(1);
               const hasPast = pastApps && pastApps.length > 0;
               const kb: any[] = [
                 [{ text: '📅 Записаться', web_app: { url: 'https://yarikbold.github.io/NailSpace/miniapp/' } }],
                 [{ text: '📋 Мои записи', callback_data: 'cbook_my' }]
               ];
               if (hasPast) {
                 kb.push([{ text: '🔄 Повторная запись', web_app: { url: 'https://yarikbold.github.io/NailSpace/miniapp/' } }]);
               }
               await tg('sendMessage', {
                 chat_id: chatId,
                 text: '👋 Привет! Я бот NailSpace.\nЗдесь ты можешь записаться на маникюр или посмотреть свои активные записи.',
                 reply_markup: { inline_keyboard: kb },
               });
             }
             return json({ success: true });
           } catch (err: any) {
             await tg('sendMessage', { chat_id: MASTER_CHAT_ID, text: `⚠️ Ошибка у клиента ${chatId}:\n${err.message}` });
             return json({ success: true });
           }
        }

        // Ввод нового контакта (режим редактирования)
        const { data: pendEdit } = await supabase.from('bot_pending_edit')
          .select('appointment_id, field').eq('chat_id', chatId).maybeSingle();
        if (pendEdit?.field === 'contact') {
          const newContact = update.message.text.trim();
          await supabase.from('appointments').update({ contact: newContact }).eq('id', pendEdit.appointment_id);
          await supabase.from('bot_pending_edit').delete().eq('chat_id', chatId);
          await tg('sendMessage', { chat_id: chatId, text: `✅ Контакт обновлён → ${newContact}` });
          await sendCardWithPhotos(chatId, pendEdit.appointment_id);
          return json({ success: true });
        }

        // Ввод итоговой суммы для кассы
        const { data: pendCash } = await supabase.from('bot_pending_cash')
          .select('appointment_id').eq('chat_id', chatId).maybeSingle();

        if (pendCash?.appointment_id) {
          const numMatch = update.message.text.replaceAll(',', '.').match(/\d+(?:\.\d{1,2})?/);
          if (!numMatch) {
            await tg('sendMessage', { chat_id: chatId, text: '⚠️ Пришли сумму числом, например: 750' });
            return json({ success: true });
          }
          const amountStr = numMatch[0];
          const card = await buildCard(pendCash.appointment_id);
          if (!card) {
            await supabase.from('bot_pending_cash').delete().eq('chat_id', chatId);
            return json({ success: true });
          }
          await tg('sendMessage', {
            chat_id: chatId,
            text: `💰 *Подтверди занесение в кассу*\n\n${card.text}\n\n💵 К оплате: *${amountStr} ₽*`,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[
              { text: `✅ Внести ${amountStr} ₽`, callback_data: `cashok_${pendCash.appointment_id}_${amountStr}` },
              { text: '❌ Отмена', callback_data: 'cashno' },
            ]] },
          });
          return json({ success: true });
        }

        if (cmd === '/start' || cmd === '/help') {
          await tg('sendMessage', {
            chat_id: chatId,
            text: '👋 Бот NailSpace\n\n📋 /journal — ближайшие записи\n📋 /journal_all — все заказы\n' +
                  '📅 /slots — управление окошками\n⚡ /slots_week — добавить на неделю\n' +
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

        if (cmd === '/slots') {
          const g = buildSlotsGrid();
          await tg('sendMessage', { chat_id: chatId, text: g.text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: g.keyboard } });
          return json({ success: true });
        }

        if (cmd === '/slots_week') {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `⚡ *Выбери интервал для создания окошек на 7 дней:*\n(Создаются с 9:00 до 20:00, существующие пропускаются)`,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: '1 час (9:00, 10:00...)', callback_data: 'sweek_60' }],
              [{ text: '1.5 часа (9:00, 10:30...)', callback_data: 'sweek_90' }],
              [{ text: '2 часа (10:00, 12:00...)', callback_data: 'sweek_120' }],
              [{ text: '❌ Отмена', callback_data: 'sweek_no' }]
            ] },
          });
          return json({ success: true });
        }

        // Мастер в режиме «жду фото», но прислал текст (не команду)
        const { data: pendPhoto } = await supabase.from('bot_pending_photo')
          .select('kind').eq('chat_id', chatId).maybeSingle();
        if (pendPhoto) {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `📷 Жду фото! Пришли снимок (или нажми «❌ Отмена» в сообщении с запросом).`,
          });
          return json({ success: true });
        }
      }

      // ---- Контакт ----
      if (update.message?.contact) {
        const chatId = String(update.message.chat.id);
        const contact = update.message.contact;
        const phone = contact.phone_number;

        const { data: pendBook } = await supabase.from('bot_pending_booking').select('*').eq('chat_id', chatId).maybeSingle();
        if (pendBook && pendBook.step === 'phone') {
          // Завершаем запись
          const { data: claimed } = await supabase.from('slots').update({ status: 'booked' }).eq('id', pendBook.slot_id).eq('status', 'available').select();
          if (!claimed || claimed.length === 0) {
             await tg('sendMessage', { chat_id: chatId, text: '❌ Извини, это окошко уже заняли. Нажми /start, чтобы выбрать другое.', reply_markup: { remove_keyboard: true } });
             await supabase.from('bot_pending_booking').delete().eq('chat_id', chatId);
             return json({ success: true });
          }
          
          const svc = SERVICES[pendBook.service_idx];
          const tgUsername = update.message.from?.username ? `@${update.message.from.username}` : null;
          const newApp = {
            slot_id: pendBook.slot_id,
            client_name: pendBook.client_name,
            phone: phone,
            contact: tgUsername,
            service: svc.name + ` (Стоимость: ${svc.price} ₽)`,
            price: svc.price,
            status: 'new',
            chat_id: chatId,
          };
          const { data: appIns } = await supabase.from('appointments').insert(newApp).select().single();
          
          await tg('sendMessage', { chat_id: chatId, text: '✅ Контакт получен!', reply_markup: { remove_keyboard: true } });
          await supabase.from('bot_pending_booking').delete().eq('chat_id', chatId);

          if (appIns) {
            const card = await buildCard(appIns.id);
            if (card) {
               await tg('sendMessage', { chat_id: MASTER_CHAT_ID, text: `🔔 *НОВАЯ ЗАПИСЬ ИЗ БОТА!*\n\n${card.text}`, parse_mode: 'Markdown', reply_markup: { inline_keyboard: card.keyboard } });
            }
            
            await supabase.from('bot_pending_photo').upsert({ chat_id: String(chatId), appointment_id: appIns.id, kind: 'before' });
            await tg('sendMessage', { 
                chat_id: chatId, 
                text: '✅ Запись успешно создана! 🎉\n\nМожешь прислать фото твоих ногтей сейчас (исходник), чтобы мастер заранее оценил работу.\n\n📸 *Пришли фото* или нажми кнопку ниже, чтобы пропустить.', 
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⏭ Пропустить', callback_data: `cphoto_skip_before_${appIns.id}` }]] }
            });
          }
        }
        return json({ success: true });
      }

      // ---- Кнопки ----
      if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message.chat.id;
        const messageId = cb.message.message_id;
        const isMaster = String(chatId) === String(MASTER_CHAT_ID);

        // ===== Клиентские кнопки =====
        if (!isMaster) {
           if (cb.data === 'cbook_start') {
             await answerCallbackQuery(cb.id, '');
             const kb = SERVICES.map((s, i) => [{ text: `${s.name} · ${s.price} ₽`, callback_data: `cbook_svc_${i}` }]);
             await editMessageText(chatId, messageId, '✨ *Выбери услугу:*', kb);
             return json({ success: true });
           }
           if (cb.data === 'cbook_repeat') {
             await answerCallbackQuery(cb.id, '');
             const { data: past } = await supabase.from('appointments').select('client_name, phone').eq('chat_id', String(chatId)).order('created_at', { ascending: false }).limit(1);
             if (past && past.length > 0) {
                // Вместо прямого выбора дня, сохраняем данные и кидаем на выбор услуги
                await supabase.from('bot_pending_booking').upsert({ chat_id: String(chatId), client_name: past[0].client_name, step: 'repeat_svc' });
                const kb = SERVICES.map((s, i) => [{ text: `${s.name} · ${s.price} ₽`, callback_data: `cbook_svc_${i}` }]);
                await editMessageText(chatId, messageId, '🔄 *Повторная запись*\n\n✨ *Выбери услугу:*', kb);
             } else {
                const kb = SERVICES.map((s, i) => [{ text: `${s.name} · ${s.price} ₽`, callback_data: `cbook_svc_${i}` }]);
                await editMessageText(chatId, messageId, '✨ *Выбери услугу:*', kb);
             }
             return json({ success: true });
           }
           if (cb.data.startsWith('cbook_svc_')) {
             const idx = Number(cb.data.split('_')[2]);
             await supabase.from('bot_pending_booking').upsert({ chat_id: String(chatId), service_idx: idx });
             await answerCallbackQuery(cb.id, '');
             const days = await buildClientDays();
             await editMessageText(chatId, messageId, days.text, days.keyboard);
             return json({ success: true });
           }
           if (cb.data === 'cbook_days') {
             await answerCallbackQuery(cb.id, '');
             const days = await buildClientDays();
             await editMessageText(chatId, messageId, days.text, days.keyboard);
             return json({ success: true });
           }
           if (cb.data.startsWith('cbook_day_')) {
             const day = cb.data.split('_')[2];
             await answerCallbackQuery(cb.id, '');
             const slots = await buildClientSlots(day);
             await editMessageText(chatId, messageId, slots.text, slots.keyboard);
             return json({ success: true });
           }
           if (cb.data.startsWith('cbook_time_')) {
             const slotId = cb.data.split('_')[2];
             const { data: pend } = await supabase.from('bot_pending_booking').select('*').eq('chat_id', String(chatId)).maybeSingle();
             
             if (pend?.step === 'repeat_day') {
                const { data: past } = await supabase.from('appointments').select('phone').eq('chat_id', String(chatId)).order('created_at', { ascending: false }).limit(1);
                if (past && past.length > 0) {
                   await supabase.from('bot_pending_booking').update({ slot_id: slotId, step: 'phone' }).eq('chat_id', String(chatId));
                   const phone = past[0].phone;
                   const { data: claimed } = await supabase.from('slots').update({ status: 'booked' }).eq('id', slotId).eq('status', 'available').select();
                   if (!claimed || claimed.length === 0) {
                      await answerCallbackQuery(cb.id, '❌ Извини, окошко заняли.');
                      await editMessageText(chatId, messageId, '❌ Извини, это окошко уже заняли. Нажми /start, чтобы выбрать другое.', []);
                      await supabase.from('bot_pending_booking').delete().eq('chat_id', String(chatId));
                      return json({ success: true });
                   }
                   const svc = SERVICES[pend.service_idx || 0];
                   const tgUsername = update.callback_query.from?.username ? `@${update.callback_query.from.username}` : null;
                   const newApp = { slot_id: slotId, client_name: pend.client_name, phone: phone, contact: tgUsername, service: svc.name + ` (Стоимость: ${svc.price} ₽)`, price: svc.price, status: 'new', chat_id: String(chatId) };
                   const { data: appIns } = await supabase.from('appointments').insert(newApp).select().single();
                   await answerCallbackQuery(cb.id, '✅ Запись создана!');
                   await supabase.from('bot_pending_booking').delete().eq('chat_id', String(chatId));
                   
                   if (appIns) {
                     const card = await buildCard(appIns.id);
                     if (card) await tg('sendMessage', { chat_id: MASTER_CHAT_ID, text: `🔔 *НОВАЯ ЗАПИСЬ ИЗ БОТА (Повторная)!*\n\n${card.text}`, parse_mode: 'Markdown', reply_markup: { inline_keyboard: card.keyboard } });
                     
                     await editMessageText(chatId, messageId, `✅ Запись успешно создана! 🎉\n\nУслуга: ${svc.name}\n\nМожешь прислать фото твоих ногтей сейчас (исходник), чтобы мастер заранее оценил работу.\n\n📸 *Пришли фото* или нажми кнопку ниже, чтобы пропустить.`, [[{ text: '⏭ Пропустить', callback_data: `cphoto_skip_before_${appIns.id}` }]]);
                     await supabase.from('bot_pending_photo').upsert({ chat_id: String(chatId), appointment_id: appIns.id, kind: 'before' });
                   }
                   return json({ success: true });
                }
             }

             await supabase.from('bot_pending_booking').update({ slot_id: slotId, step: 'name' }).eq('chat_id', String(chatId));
             await answerCallbackQuery(cb.id, '');
             await tg('sendMessage', {
               chat_id: chatId,
               text: '👤 Напиши свое Имя и Фамилию в чат 👇',
             });
             return json({ success: true });
           }
           if (cb.data === 'cbook_my') {
             await answerCallbackQuery(cb.id, '');
             await tg('sendMessage', {
               chat_id: chatId,
               text: 'Пожалуйста, используй новую кнопку «📋 Мои записи» в главном меню бота (/start), чтобы открыть список записей.'
             });
             return json({ success: true });
           }
           if (cb.data.startsWith('cbook_cancel_')) {
             const appId = cb.data.split('_')[2];
             const { data: app } = await supabase.from('appointments').select('status, slot_id').eq('id', appId).eq('chat_id', String(chatId)).single();
             if (app && ['new', 'confirmed'].includes(app.status)) {
               await supabase.from('appointments').update({ status: 'canceled' }).eq('id', appId);
               if (app.slot_id) await supabase.from('slots').update({ status: 'available' }).eq('id', app.slot_id);
               await answerCallbackQuery(cb.id, '❌ Запись отменена');
               const my = await buildClientAppointments(String(chatId));
               await editMessageText(chatId, messageId, my.text, my.keyboard);
               await tg('sendMessage', { chat_id: MASTER_CHAT_ID, text: `⚠️ Клиент самостоятельно отменил запись!` });
             }
             return json({ success: true });
           }

           if (cb.data === 'cbook_menu') {
             await answerCallbackQuery(cb.id, '');
             const { data: pastApps } = await supabase.from('appointments').select('id').eq('chat_id', String(chatId)).limit(1);
             const hasPast = pastApps && pastApps.length > 0;
             const kb = [
               [{ text: '📅 Записаться', callback_data: 'cbook_start' }],
               [{ text: '📋 Мои записи', callback_data: 'cbook_my' }]
             ];
             if (hasPast) kb.push([{ text: '🔄 Повторная запись', callback_data: 'cbook_repeat' }]);
             await editMessageText(chatId, messageId, '👋 Главное меню:\nЗдесь ты можешь записаться на маникюр или посмотреть свои активные записи.', kb);
             return json({ success: true });
           }
           const parts = cb.data.split('_');
           const action = parts[0];
           
           if (action === 'cphoto') {
              if (parts[1] === 'skip') {
                  const kind = parts[2];
                  const appId = parts[3];
                  if (kind === 'before') {
                      await supabase.from('bot_pending_photo').update({ kind: 'ref' }).eq('chat_id', String(chatId));
                      await editMessageText(chatId, messageId, 'Пропущено. \nТеперь можешь прислать фото-референс (дизайн, который хочешь сделать).\n\n📸 *Пришли фото* или нажми пропустить.', [[{ text: '⏭ Пропустить', callback_data: `cphoto_skip_ref_${appId}` }]]);
                  } else {
                      await supabase.from('bot_pending_photo').delete().eq('chat_id', String(chatId));
                      await editMessageText(chatId, messageId, 'Все фото пропущены. До встречи! 👋', []);
                  }
                  await answerCallbackQuery(cb.id, '');
                  return json({ success: true });
              }
           }
           if (action === 'creview') {
             const sub = parts[1]; // star or skip
             if (sub === 'star') {
                const rating = Number(parts[2]);
                const appId = parts[3];
                await supabase.from('appointments').update({ review_rating: rating }).eq('id', appId);
                await supabase.from('bot_pending_review').upsert({ chat_id: String(chatId), appointment_id: appId, rating: rating, step: 'text' });
                await editMessageText(chatId, messageId, `⭐️ Спасибо за оценку (${rating}/5)!\n\nЕсли хочешь, напиши текстовый отзыв (просто отправь текст сообщением) или нажми пропустить:`, [[{ text: '⏭ Пропустить', callback_data: `creview_skip_text_${appId}` }]]);
                await answerCallbackQuery(cb.id, '');
                return json({ success: true });
             }
             if (sub === 'skip') {
                const step = parts[2];
                const appId = parts[3];
                if (step === 'text') {
                   await supabase.from('bot_pending_review').update({ step: 'photo' }).eq('chat_id', String(chatId));
                   await editMessageText(chatId, messageId, 'Пропущено.\n\nМожешь прикрепить фото готового маникюра (просто отправь фото) или пропустить:', [[{ text: '⏭ Пропустить', callback_data: `creview_skip_photo_${appId}` }]]);
                } else if (step === 'photo') {
                   await supabase.from('bot_pending_review').delete().eq('chat_id', String(chatId));
                   await editMessageText(chatId, messageId, 'Спасибо! Отзыв сохранен. Ждем тебя снова! 💅', []);
                   await tg('sendMessage', { chat_id: MASTER_CHAT_ID, text: `⭐️ Получен новый отзыв от клиента!` });
                }
                await answerCallbackQuery(cb.id, '');
                return json({ success: true });
             }
           }
           
           return json({ success: true });
        }

        // ===== Мастер =====
        // Навигация
        if (cb.data === 'back_journal') {
          await answerCallbackQuery(cb.id, '');
          const j = await buildJournal();
          await editMessageText(chatId, messageId, j.text, j.keyboard);
          return json({ success: true });
        }
        if (cb.data === 'all_journal') {
          await answerCallbackQuery(cb.id, '');
          const m = await buildAllMenu();
          await editMessageText(chatId, messageId, m.text, m.keyboard);
          return json({ success: true });
        }
        if (cb.data === 'upcoming_list') {
          await answerCallbackQuery(cb.id, '');
          const j = await buildJournal();
          await editMessageText(chatId, messageId, j.text, j.keyboard);
          return json({ success: true });
        }
        if (cb.data === 'completed_list') {
          await answerCallbackQuery(cb.id, '');
          const c = await buildCompleted();
          await editMessageText(chatId, messageId, c.text, c.keyboard);
          return json({ success: true });
        }
        if (cb.data === 'cashno') {
          await supabase.from('bot_pending_cash').delete().eq('chat_id', String(chatId));
          await answerCallbackQuery(cb.id, 'Отменено');
          return json({ success: true });
        }
        if (cb.data === 'photono') {
          await supabase.from('bot_pending_photo').delete().eq('chat_id', String(chatId));
          await answerCallbackQuery(cb.id, 'Отменено');
          return json({ success: true });
        }
        if (cb.data === 'editno') {
          await supabase.from('bot_pending_edit').delete().eq('chat_id', String(chatId));
          await answerCallbackQuery(cb.id, 'Отменено');
          return json({ success: true });
        }

        // ===== Управление слотами =====
        if (cb.data === 'sb') {
          await answerCallbackQuery(cb.id, '');
          const g = buildSlotsGrid();
          await editMessageText(chatId, messageId, g.text, g.keyboard);
          return json({ success: true });
        }
        if (cb.data.startsWith('sd_')) {
          const day = cb.data.slice(3);
          await answerCallbackQuery(cb.id, '');
          const h = await buildSlotHours(day);
          await editMessageText(chatId, messageId, h.text, h.keyboard);
          return json({ success: true });
        }
        if (cb.data.startsWith('st_')) {
          const [, day, timeStr] = cb.data.split('_');
          const slotTime = `${day}T${timeStr}:00+03:00`;
          const { data: ex } = await supabase.from('slots').select('id, status').eq('slot_time', slotTime).maybeSingle();
          if (ex) {
            if (ex.status === 'booked') {
              await answerCallbackQuery(cb.id, '🔒 Окошко занято — нельзя убрать');
            } else {
              await supabase.from('slots').delete().eq('id', ex.id);
              await answerCallbackQuery(cb.id, `🗑 ${timeStr} удалено`);
            }
          } else {
            await supabase.from('slots').insert({ slot_time: slotTime, status: 'available' });
            await answerCallbackQuery(cb.id, `✅ ${timeStr} добавлено`);
          }
          const h = await buildSlotHours(day);
          await editMessageText(chatId, messageId, h.text, h.keyboard);
          return json({ success: true });
        }
        if (cb.data.startsWith('sweek_')) {
          const intervalStr = cb.data.split('_')[1];
          if (intervalStr === 'no') {
            await answerCallbackQuery(cb.id, 'Отменено');
            await editMessageText(chatId, messageId, '❌ Отменено', []);
            return json({ success: true });
          }

          const intervalMins = Number(intervalStr);
          if ([60, 90, 120].includes(intervalMins)) {
            const hoursAndMins: {h: number, m: number}[] = [];
            let currentMins = 9 * 60; // 9:00
            const endMins = 20 * 60; // 20:00
            
            while (currentMins <= endMins) {
              const h = Math.floor(currentMins / 60);
              const m = currentMins % 60;
              hoursAndMins.push({ h, m });
              currentMins += intervalMins;
            }
            
            const mskToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
            const inserts: any[] = [];
            for (let i = 0; i < 7; i++) {
              const d = new Date(mskToday + 'T12:00:00+03:00');
              d.setDate(d.getDate() + i);
              const ds = d.toISOString().slice(0, 10);
              for (const time of hoursAndMins) {
                inserts.push({ slot_time: `${ds}T${String(time.h).padStart(2, '0')}:${String(time.m).padStart(2, '0')}:00+03:00`, status: 'available' });
              }
            }
            
            const { data: existing } = await supabase.from('slots').select('slot_time').in('slot_time', inserts.map(s => s.slot_time));
            const existSet = new Set((existing || []).map(s => s.slot_time));
            const newSlots = inserts.filter(s => !existSet.has(s.slot_time));
            if (newSlots.length) await supabase.from('slots').insert(newSlots);
            await answerCallbackQuery(cb.id, `✅ Создано ${newSlots.length} окошек`);
            const lbl = intervalMins === 60 ? '1 час' : intervalMins === 90 ? '1.5 часа' : '2 часа';
            await editMessageText(chatId, messageId, `✅ Создано *${newSlots.length}* окошек на 7 дней\nИнтервал: ${lbl}\n(пропущено ${inserts.length - newSlots.length} существующих)`, []);
            return json({ success: true });
          }
        }

        // ===== Редактирование записи =====
        if (cb.data === 'etb') {
          const { data: pe } = await supabase.from('bot_pending_edit').select('appointment_id').eq('chat_id', String(chatId)).maybeSingle();
          await supabase.from('bot_pending_edit').delete().eq('chat_id', String(chatId));
          if (pe) {
            const menu = await buildEditMenu(pe.appointment_id);
            if (menu) await editMessageText(chatId, messageId, menu.text, menu.keyboard);
          }
          await answerCallbackQuery(cb.id, '');
          return json({ success: true });
        }

        // Действия
        const parts = cb.data.split('_');
        const action = parts[0];
        const appointmentId = parts[1];
        if (!appointmentId) return json({ success: true });

        // Меню редактирования
        if (action === 'edit') {
          await answerCallbackQuery(cb.id, '');
          const menu = await buildEditMenu(appointmentId);
          if (menu) await editMessageText(chatId, messageId, menu.text, menu.keyboard);
          return json({ success: true });
        }

        // Смена времени: показать дни
        if (action === 'et') {
          await supabase.from('bot_pending_edit').upsert({ chat_id: String(chatId), appointment_id: appointmentId, field: 'time' });
          await answerCallbackQuery(cb.id, '');
          const days = await buildEditTimeDays();
          await editMessageText(chatId, messageId, days.text, days.keyboard);
          return json({ success: true });
        }
        // Смена времени: показать слоты дня
        if (action === 'etd') {
          const day = parts[1];
          await answerCallbackQuery(cb.id, '');
          const slots = await buildEditTimeSlots(day);
          await editMessageText(chatId, messageId, slots.text, slots.keyboard);
          return json({ success: true });
        }
        // Смена времени: подтвердить
        if (action === 'ets') {
          const newSlotId = parts[1];
          const { data: pe } = await supabase.from('bot_pending_edit').select('appointment_id').eq('chat_id', String(chatId)).maybeSingle();
          if (!pe) { await answerCallbackQuery(cb.id, 'Ошибка: нет контекста'); return json({ success: true }); }
          const { data: oldApp } = await supabase.from('appointments').select('slot_id').eq('id', pe.appointment_id).single();
          // Занимаем новый слот
          const { data: claimed } = await supabase.from('slots').update({ status: 'booked' }).eq('id', newSlotId).eq('status', 'available').select();
          if (!claimed || claimed.length === 0) {
            await answerCallbackQuery(cb.id, 'Это окошко уже занято'); return json({ success: true });
          }
          // Освобождаем старый слот
          if (oldApp?.slot_id) await supabase.from('slots').update({ status: 'available' }).eq('id', oldApp.slot_id);
          await supabase.from('appointments').update({ slot_id: newSlotId }).eq('id', pe.appointment_id);
          await supabase.from('bot_pending_edit').delete().eq('chat_id', String(chatId));
          await answerCallbackQuery(cb.id, '✅ Время изменено');
          const card = await buildCard(pe.appointment_id);
          if (card) await editMessageText(chatId, messageId, card.text, card.keyboard);
          return json({ success: true });
        }

        // Смена услуги: показать список
        if (action === 'es') {
          await answerCallbackQuery(cb.id, '');
          const kb = SERVICES.map((s, i) => [{ text: `${s.name} · ${s.price} ₽`, callback_data: `esk_${appointmentId}_${i}` }]);
          kb.push([{ text: '⬅ Назад', callback_data: `edit_${appointmentId}` }]);
          await editMessageText(chatId, messageId, '✨ *Выбери новую услугу:*', kb);
          return json({ success: true });
        }
        // Смена услуги: подтвердить
        if (action === 'esk') {
          const idx = Number(parts[2]);
          const svc = SERVICES[idx];
          if (!svc) { await answerCallbackQuery(cb.id, 'Ошибка'); return json({ success: true }); }
          await supabase.from('appointments').update({ service: svc.name + ` (Стоимость: ${svc.price} ₽)`, price: svc.price }).eq('id', appointmentId);
          await answerCallbackQuery(cb.id, `✅ Услуга → ${svc.name}`);
          const card = await buildCard(appointmentId);
          if (card) await editMessageText(chatId, messageId, card.text, card.keyboard);
          return json({ success: true });
        }

        // Смена контакта: ждём текст
        if (action === 'ec') {
          await supabase.from('bot_pending_edit').upsert({ chat_id: String(chatId), appointment_id: appointmentId, field: 'contact' });
          await answerCallbackQuery(cb.id, '');
          await tg('sendMessage', {
            chat_id: chatId,
            text: '👤 Напиши новый контакт клиента (например: Телеграм — @username)',
            reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'editno' }]] },
          });
          return json({ success: true });
        }

        if (action === 'view') {
          await answerCallbackQuery(cb.id, '');
          const card = await buildCard(appointmentId);
          if (!card) return json({ success: true });
          await editMessageText(chatId, messageId, card.text, card.keyboard);
          await sendPhotos(chatId, appointmentId);
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
          const { data: existing } = await supabase.from('appointments')
            .select('status, chat_id, review_requested_at').eq('id', appointmentId).single();
          const updateData: any = { status: 'completed', price: Number(amount) };
          if (!existing || existing.status !== 'completed') {
            updateData.completed_at = new Date().toISOString();
          }
          
          if (existing?.chat_id && !existing.review_requested_at) {
             updateData.review_requested_at = new Date().toISOString();
             await tg('sendMessage', {
                chat_id: existing.chat_id,
                text: `👋 Привет! Надеюсь, тебе всё понравилось.\nОцени, пожалуйста, как прошла запись от 1 до 5:`,
                reply_markup: { inline_keyboard: [[
                  { text: '1⭐️', callback_data: `creview_star_1_${appointmentId}` },
                  { text: '2⭐️', callback_data: `creview_star_2_${appointmentId}` },
                  { text: '3⭐️', callback_data: `creview_star_3_${appointmentId}` },
                  { text: '4⭐️', callback_data: `creview_star_4_${appointmentId}` },
                  { text: '5⭐️', callback_data: `creview_star_5_${appointmentId}` }
                ]] }
             });
          }

          await supabase.from('appointments').update(updateData).eq('id', appointmentId);
          await supabase.from('bot_pending_cash').delete().eq('chat_id', String(chatId));
          await answerCallbackQuery(cb.id, `Внесено в кассу: ${amount} ₽ 💰`);
          const m = await buildAllMenu();
          await editMessageText(chatId, messageId, m.text, m.keyboard);
          return json({ success: true });
        }

        // Запрос фото: исходник / референс
        if (action === 'photo') {
          const kind = parts[1] === 'ref' ? 'ref' : 'before';
          const photoApptId = parts.slice(2).join('_');
          await answerCallbackQuery(cb.id, '');
          await supabase.from('bot_pending_photo').upsert({
            chat_id: String(chatId), appointment_id: photoApptId, kind: kind,
          });
          await tg('sendMessage', {
            chat_id: chatId,
            text: `📷 Пришли фото «${PHOTO_CAPTIONS[kind]}».\nЕсли фото этого типа уже есть — оно заменится.`,
            reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'photono' }]] },
          });
          return json({ success: true });
        }

        // Удалить фото конкретного типа
        if (action === 'delphoto') {
          const delKind = parts[1] === 'ref' ? 'ref' : 'before';
          const delPhotoApptId = parts.slice(2).join('_');
          await supabase.from('appointment_photos')
            .delete().eq('appointment_id', delPhotoApptId).eq('kind', delKind);
          await answerCallbackQuery(cb.id, 'Фото удалено 🗑');
          const card = await buildCard(delPhotoApptId);
          if (card) await editMessageText(chatId, messageId, card.text, card.keyboard);
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

// Карточка записи: контакт, статусы фото, кнопки управления
async function buildCard(id: string) {
  const { data: a } = await supabase.from('appointments')
    .select('id, client_name, phone, contact, service, comment, price, status, slots!inner ( slot_time )')
    .eq('id', id).single();
  if (!a) return null;

  const { data: photos } = await supabase.from('appointment_photos')
    .select('kind').eq('appointment_id', id);
  const hasBefore = (photos || []).some(p => p.kind === 'before');
  const hasRef = (photos || []).some(p => p.kind === 'ref');

  const time = new Date(a.slots.slot_time).toLocaleString('ru-RU', {
    weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
  });

  const text =
    `📋 *ЗАПИСЬ*\n` +
    `📅 ${time}\n` +
    `👤 ${a.client_name} | 📞 ${a.phone}\n` +
    `🔗 Контакт: ${a.contact || '—'}\n` +
    `✨ ${a.service}\n` +
    `💰 Ориентир: ${a.price} ₽\n` +
    `📝 ${a.comment || '—'}\n` +
    `📷 Фото «исходник»: ${hasBefore ? '✅ есть' : '❌ нет'}\n` +
    `📸 Референс: ${hasRef ? '✅ есть' : '❌ нет'}\n` +
    `Статус: ${statusRu(a.status)}`;

  const keyboard: any[] = [];
  if (a.status === 'new') keyboard.push([{ text: '✅ Подтвердить', callback_data: `confirm_${id}` }]);
  if (a.status === 'new' || a.status === 'confirmed') {
    keyboard.push([{ text: '💰 Занести в кассу', callback_data: `cash_${id}` }]);
    keyboard.push([{ text: '✏️ Редактировать', callback_data: `edit_${id}` }]);
  }
  if (a.status === 'completed') {
    // Завершённые записи: удаление, изменение стоимости
    keyboard.push([
      { text: '🗑 Удалить запись', callback_data: `delete_${id}` },
      { text: '💰 Изменить стоимость', callback_data: `cash_${id}` },
    ]);
  } else {
    // Активные записи: фото + отмена/удаление
    keyboard.push([
      { text: `📷 ${hasBefore ? 'Сменить' : 'Добавить'} исходник`, callback_data: `photo_before_${id}` },
      { text: `📸 ${hasRef ? 'Сменить' : 'Добавить'} референс`, callback_data: `photo_ref_${id}` },
    ]);
    const delPhotoRow: any[] = [];
    if (hasBefore) delPhotoRow.push({ text: '🗑 Удалить исходник', callback_data: `delphoto_before_${id}` });
    if (hasRef) delPhotoRow.push({ text: '🗑 Удалить референс', callback_data: `delphoto_ref_${id}` });
    if (delPhotoRow.length) keyboard.push(delPhotoRow);
    keyboard.push([
      { text: '❌ Отменить', callback_data: `cancel_${id}` },
      { text: '🗑 Удалить', callback_data: `delete_${id}` },
    ]);
  }
  keyboard.push([{
    text: a.status === 'completed' ? '⬅ К завершённым' : '⬅ К журналу',
    callback_data: a.status === 'completed' ? 'completed_list' : 'back_journal',
  }]);

  return { text, keyboard };
}

// Отправить сохранённые фото записи
async function sendPhotos(chatId: string | number, id: string) {
  const { data: photos } = await supabase.from('appointment_photos')
    .select('kind, file_id').eq('appointment_id', id);
  for (const p of photos || []) {
    await tg('sendPhoto', {
      chat_id: chatId,
      photo: p.file_id,
      caption: PHOTO_CAPTIONS[p.kind] || '',
    });
  }
}

// Карточка + фото одним сообщением (используется после добавления фото)
async function sendCardWithPhotos(chatId: string | number, id: string) {
  const card = await buildCard(id);
  if (!card) return;
  await tg('sendMessage', {
    chat_id: chatId,
    text: card.text,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: card.keyboard },
  });
  await sendPhotos(chatId, id);
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
    `👇 Нажми на запись, чтобы открыть карточку и фото`;

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

// ===== Управление слотами: сетка 14 дней =====
function buildSlotsGrid() {
  const keyboard: any[] = [];
  const mskToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  for (let i = 0; i < 14; i++) {
    const d = new Date(mskToday + 'T12:00:00+03:00');
    d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' });
    if (i % 2 === 0) keyboard.push([]);
    keyboard[keyboard.length - 1].push({ text: label, callback_data: `sd_${ds}` });
  }
  return { text: '📅 *УПРАВЛЕНИЕ ОКОШКАМИ*\nВыбери день, чтобы добавить/убрать время:', keyboard };
}

// ===== Управление слотами: часы конкретного дня =====
async function buildSlotHours(day: string) {
  const fromIso = day + 'T00:00:00+03:00';
  const toIso = day + 'T23:59:59+03:00';
  const { data: slots } = await supabase.from('slots')
    .select('id, slot_time, status').gte('slot_time', fromIso).lte('slot_time', toIso).order('slot_time');
  const existing = new Map<string, any>();
  (slots || []).forEach(s => {
    const timeStr = new Date(s.slot_time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    existing.set(timeStr, s);
  });
  const keyboard: any[] = [];
  SLOT_TIMES.forEach((timeStr, i) => {
    const slot = existing.get(timeStr);
    let label = timeStr;
    if (slot?.status === 'booked') label += ' 🔒';
    else if (slot?.status === 'available') label += ' ✅';
    if (i % 3 === 0) keyboard.push([]);
    keyboard[keyboard.length - 1].push({ text: label, callback_data: `st_${day}_${timeStr}` });
  });
  keyboard.push([{ text: '⬅ К дням', callback_data: 'sb' }]);
  const dayRu = new Date(day + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  return { text: `📅 *${dayRu}*\n✅ свободно · 🔒 занято\nНажми на время, чтобы добавить/убрать:`, keyboard };
}

// ===== Меню редактирования записи =====
async function buildEditMenu(id: string) {
  const { data: a } = await supabase.from('appointments')
    .select('id, client_name, service, slots!inner ( slot_time )').eq('id', id).single();
  if (!a) return null;
  const time = new Date(a.slots.slot_time).toLocaleString('ru-RU', {
    weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
  });
  return {
    text: `✏️ *ЧТО ИЗМЕНИТЬ?*\n\n📋 ${a.client_name}, ${time}\n✨ ${a.service}`,
    keyboard: [
      [{ text: '📅 Время', callback_data: `et_${id}` }, { text: '✨ Услугу', callback_data: `es_${id}` }, { text: '👤 Контакт', callback_data: `ec_${id}` }],
      [{ text: '⬅ Назад к карточке', callback_data: `view_${id}` }],
    ],
  };
}

// ===== Редактирование: дни со свободными слотами =====
async function buildEditTimeDays() {
  const now = new Date().toISOString();
  const in14 = new Date(Date.now() + 14 * 86400000).toISOString();
  const { data: slots } = await supabase.from('slots')
    .select('slot_time').eq('status', 'available').gte('slot_time', now).lte('slot_time', in14).order('slot_time');
  const days = [...new Set((slots || []).map(s =>
    new Date(s.slot_time).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' })
  ))];
  if (!days.length) return { text: '📅 Нет свободных окошек на ближайшие 14 дней', keyboard: [[{ text: '⬅ Назад', callback_data: 'etb' }]] };
  const keyboard: any[] = [];
  days.forEach((d, i) => {
    const label = new Date(d + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' });
    if (i % 2 === 0) keyboard.push([]);
    keyboard[keyboard.length - 1].push({ text: label, callback_data: `etd_${d}` });
  });
  keyboard.push([{ text: '⬅ Назад', callback_data: 'etb' }]);
  return { text: '📅 *Выбери новый день:*', keyboard };
}

// ===== Редактирование: слоты конкретного дня =====
async function buildEditTimeSlots(day: string) {
  const fromIso = day + 'T00:00:00+03:00';
  const toIso = day + 'T23:59:59+03:00';
  const { data: slots } = await supabase.from('slots')
    .select('id, slot_time').eq('status', 'available').gte('slot_time', fromIso).lte('slot_time', toIso).order('slot_time');
  if (!slots || !slots.length) return { text: '📅 На этот день нет свободных окошек', keyboard: [[{ text: '⬅ Назад', callback_data: 'etb' }]] };
  const dayRu = new Date(day + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const keyboard: any[] = [];
  slots.forEach((s, i) => {
    const time = new Date(s.slot_time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    if (i % 3 === 0) keyboard.push([]);
    keyboard[keyboard.length - 1].push({ text: time, callback_data: `ets_${s.id}` });
  });
  keyboard.push([{ text: '⬅ Назад', callback_data: 'etb' }]);
  return { text: `📅 *${dayRu}* — свободные окошки:`, keyboard };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}

// ===== Клиент: Дни со свободными слотами =====
async function buildClientDays() {
  const now = new Date().toISOString();
  const in14 = new Date(Date.now() + 14 * 86400000).toISOString();
  const { data: slots } = await supabase.from('slots')
    .select('slot_time').eq('status', 'available').gte('slot_time', now).lte('slot_time', in14).order('slot_time');
  const days = [...new Set((slots || []).map(s =>
    new Date(s.slot_time).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' })
  ))];
  if (!days.length) return { text: '📅 К сожалению, свободных окошек на ближайшие 14 дней нет.', keyboard: [[{ text: '⬅ В главное меню', callback_data: 'cbook_start' }]] };
  
  const keyboard: any[] = [];
  days.forEach((d, i) => {
    const label = new Date(d + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' });
    if (i % 2 === 0) keyboard.push([]);
    keyboard[keyboard.length - 1].push({ text: label, callback_data: `cbook_day_${d}` });
  });
  keyboard.push([{ text: '❌ Отмена', callback_data: 'cbook_start' }]);
  return { text: '📅 *Выбери день:*', keyboard };
}

// ===== Клиент: Слоты конкретного дня =====
async function buildClientSlots(day: string) {
  const fromIso = day + 'T00:00:00+03:00';
  const toIso = day + 'T23:59:59+03:00';
  const { data: slots } = await supabase.from('slots')
    .select('id, slot_time').eq('status', 'available').gte('slot_time', fromIso).lte('slot_time', toIso).order('slot_time');
  if (!slots || !slots.length) return { text: '📅 На этот день окошки уже разобрали', keyboard: [[{ text: '⬅ К выбору дня', callback_data: 'cbook_days' }]] };
  
  const dayRu = new Date(day + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const keyboard: any[] = [];
  slots.forEach((s, i) => {
    const time = new Date(s.slot_time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    if (i % 3 === 0) keyboard.push([]);
    keyboard[keyboard.length - 1].push({ text: time, callback_data: `cbook_time_${s.id}` });
  });
  keyboard.push([{ text: '⬅ К выбору дня', callback_data: 'cbook_days' }]);
  return { text: `📅 *${dayRu}* — выбери время:`, keyboard };
}

// ===== Клиент: Мои записи =====
async function buildClientAppointments(chatId: string) {
  // Активные записи
  const { data: apps } = await supabase.from('appointments')
    .select('id, service, price, status, slots!inner ( slot_time )')
    .eq('chat_id', chatId)
    .in('status', ['new', 'confirmed'])
    .gte('slots.slot_time', new Date().toISOString())
    .order('slots(slot_time)');

  // Завершенные записи без отзыва
  const { data: noReviewApps } = await supabase.from('appointments')
    .select('id, service, price, status, slots!inner ( slot_time )')
    .eq('chat_id', chatId)
    .eq('status', 'completed')
    .is('review_rating', null)
    .order('slots(slot_time)', { ascending: false })
    .limit(3);
  
  if ((!apps || !apps.length) && (!noReviewApps || !noReviewApps.length)) return { text: 'У тебя пока нет активных записей. Вызови /start, чтобы записаться.', keyboard: [] };
  
  let text = '📋 *Твои записи:*\n\n';
  const keyboard: any[] = [];
  let counter = 1;

  if (apps && apps.length > 0) {
     apps.forEach((a: any) => {
       const time = new Date(a.slots.slot_time).toLocaleString('ru-RU', {
         weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'
       });
       text += `*${counter}.* ${time}\nУслуга: ${a.service}\nСтатус: ${statusRu(a.status)}\n\n`;
       keyboard.push([{ text: `❌ Отменить №${counter}`, callback_data: `cbook_cancel_${a.id}` }]);
       counter++;
     });
  }

  if (noReviewApps && noReviewApps.length > 0) {
     text += `\n⭐️ *Ждут твоей оценки:*\n\n`;
     noReviewApps.forEach((a: any) => {
       const time = new Date(a.slots.slot_time).toLocaleString('ru-RU', {
         weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'
       });
       text += `*${counter}.* ${time}\nУслуга: ${a.service}\n`;
       
       // Для отзыва просто перенаправим их на флоу запроса отзыва
       keyboard.push([
          { text: `1⭐️`, callback_data: `creview_star_1_${a.id}` },
          { text: `2⭐️`, callback_data: `creview_star_2_${a.id}` },
          { text: `3⭐️`, callback_data: `creview_star_3_${a.id}` },
          { text: `4⭐️`, callback_data: `creview_star_4_${a.id}` },
          { text: `5⭐️`, callback_data: `creview_star_5_${a.id}` }
       ]);
       counter++;
     });
  }

  keyboard.push([{ text: '⬅ В главное меню', callback_data: 'cbook_menu' }]);
  return { text, keyboard };
}

async function tg(method: string, payload: unknown) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => 'unknown error');
    console.error(`Telegram API error [${method}]:`, res.status, err);
  }
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
