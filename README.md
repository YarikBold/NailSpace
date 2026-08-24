# 💅 NailSpace — лендинг студии маникюра

Одностраничный сайт-визитка студии маникюра в Липецке с полноценной системой онлайн-записи: свободные окошки из базы данных, CRM-уведомления в Telegram и касса.

## 🚀 Возможности

- **Онлайн-запись** — клиент выбирает услугу (radio-таблетки), дополнительный дизайн, свободное окошко из Supabase и оставляет комментарий
- **Динамические слоты** — свободные окошки подгружаются из таблицы `slots`, при записи слот атомарно бронируется (защита от двойной брони)
- **Маска телефона** `+7 (XXX) XXX-XX-XX` с авто-конвертацией при вставке из буфера (`89001234567` → `+7 (900) 123-45-67`)
- **Авторасчёт стоимости** — плашка с ориентировочной ценой (услуги + дизайн)
- **Telegram CRM** — мастер получает уведомление о новой записи с инлайн-кнопками: Подтвердить / Занести в кассу
- **Журнал в боте** — `/journal` (ближайшие записи, отмена/удаление/касса), `/journal_all` (все заказы), `/cashbox_day|week|month|all` (выручка)
- **Напоминания клиенту-мастеру** за час до подтверждённой записи (cron)

## 🛠 Технологии

- HTML5 + CSS3 (Glassmorphism, адаптив, без фреймворков)
- Vanilla JavaScript
- [Supabase](https://supabase.com) — Postgres БД + Edge Functions (Deno)
- Telegram Bot API

## 📁 Структура

```
├── index.html      # Лендинг + форма записи
├── style.css       # Все стили
├── supabase/
│   └── functions/
│       └── telegram_webhook/
│           └── index.ts   # Edge Function: уведомления, журнал, касса
├── logo.png, bg.png, work1-3.jpg  # Изображения
```

## ⚙️ Настройка Supabase

1. Создать таблицы `slots`, `appointments`, view `cashbox`, таблицу `bot_pending_cash` (см. SQL ниже)
2. Включить RLS с политиками: anon → `SELECT` на slots, `INSERT` на appointments, `UPDATE` slots (только available→booked)
3. Создать Edge Function `telegram_webhook` из файла `supabase/functions/telegram_webhook/index.ts`
4. Установить секреты:

```bash
supabase secrets set TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... NOTIFY_SECRET=...
```

(`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` внедряются автоматически)

5. Привязать Telegram-вебхук:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<PROJECT_REF>.supabase.co/functions/v1/telegram_webhook"
```

6. Настроить крон для напоминаний (например, cron-job.org, каждые 30 минут):
```
GET https://<PROJECT_REF>.supabase.co/functions/v1/telegram_webhook?check_reminders=1
```

## 🔒 Безопасность

- В фронтенде используется только publishable-ключ Supabase (защищено RLS-политиками)
- Токен Telegram-бота хранится в секретах Edge Function
- Команды журнала и кассы отвечают только в чате мастера (`TELEGRAM_CHAT_ID`)

## 📄 Лицензия

MIT
