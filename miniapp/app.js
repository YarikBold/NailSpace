// Initialization
Telegram.WebApp.ready();
Telegram.WebApp.expand();

// Theme setup based on Telegram
const tgColor = Telegram.WebApp.themeParams.bg_color;
// if (tgColor) {
//     document.documentElement.style.setProperty('--bg-main', tgColor);
// }

// Supabase Connection
const SUPABASE_URL = 'https://dteggoslnxkwzjbsfuul.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_3IXLnsQe-1mNTV9AA-SINg_F7zNnUnj';
const EDGE_FUNCTION_URL = SUPABASE_URL + '/functions/v1/telegram_webhook';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// State
const state = {
    services: [],
    selectedService: null,
    slots: [],
    availableMonths: [],
    currentMonth: null,
    selectedDay: null,
    selectedSlot: null,
    photos: [],
    transferAppointment: null,
    myBookings: [],
    reviewable: [],
    paymentConfig: null,
    currentPayment: null,
    paymentTimer: null,
    reviewPage: 0,
    reviewRequest: 0,
    reviewReturnScreen: 'services'
};

function setAppStatus(message, type = '') {
    const el = document.getElementById('appStatus');
    if (!el) return;
    el.textContent = message || '';
    el.className = `app-status${type ? ' ' + type : ''}`;
    el.hidden = !message;
}

const bookingStatus = {
    new: 'Ожидает подтверждения',
    confirmed: 'Подтверждена',
    awaiting_payment: 'Ожидает перевода',
    payment_review: 'Предоплата на проверке',
    completed: 'Завершена',
    canceled: 'Отменена',
};

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[ch]);
const dateInMoscow = value => new Date(value).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
});
const serviceLabel = value => String(value).replace(/ \(Стоимость: .*\)$/, '');
const currency = value => new Intl.NumberFormat('ru-RU').format(value) + ' ₽';

async function api(action, extra = {}, signed = true) {
    const response = await fetch(EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(signed ? { initData: Telegram.WebApp.initData } : {}), ...extra }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(result.error || 'Не удалось связаться с NailSpace. Попробуйте ещё раз.');
        error.status = response.status;
        throw error;
    }
    return result;
}

// App Logic
const app = {
    init: async function() {
        const urlParams = new URLSearchParams(window.location.search);
        const screenParam = urlParams.get('screen') || Telegram.WebApp.initDataUnsafe?.start_param;
      if (screenParam === 'master') {
            this.showScreen('master');
            await this.loadMasterCabinet();
        } else if (screenParam === 'my_bookings') {
            this.showScreen('my-bookings');
            await this.loadMyBookings();
            await this.loadData();
        } else {
            this.showScreen('services');
            await this.loadData();
        }
        this.setupEvents();
    },

    showScreen: function(screenId) {
        clearInterval(state.paymentTimer);
        window.scrollTo(0, 0);
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(`screen-${screenId}`).classList.add('active');
        
        const header = document.getElementById('mainHeader');
        if (screenId === 'services' || screenId === 'my-bookings') {
            header.style.display = 'flex';
        } else {
            header.style.display = 'none';
        }
        
        this.updateStickyFooter(screenId);
    },

    loadMasterCabinet: async function(activeSection = 'bookings') {
        const panel = document.getElementById('masterPanel');
        const payments = activeSection === 'payments';
        document.getElementById('masterOverview').hidden = payments;
        this.setMasterDrawerActive(activeSection);
        this.setMasterTitle(activeSection);
        panel.innerHTML = '<p class="slots-loading">Загружаем записи…</p>';
        try {
            const result = await this.masterRequest('master_list', { kind: activeSection });
            if (!payments) this.renderMasterOverview(result.appointments.filter(a => a.status !== 'payment_review'));
            if (!result.appointments.length) {
                panel.innerHTML = payments ? '<p class="slots-loading">Предоплат на проверке пока нет.</p>' : '<p class="slots-loading">Ближайших записей нет.</p>';
                return;
            }
            panel.innerHTML = result.appointments.map(a => {
                const slot = Array.isArray(a.slots) ? a.slots[0] : a.slots;
                const isPayment = a.status === 'payment_review';
                const actions = isPayment ? `
                    <button class="btn-primary" onclick="event.stopPropagation(); app.masterAction('${a.id}','approve_payment')">Подтвердить оплату</button>
                    <button class="btn-secondary" onclick="event.stopPropagation(); app.masterAction('${a.id}','reject_payment')">Отклонить и открыть слот</button>` : `
                    ${a.status === 'new' ? `<button class="btn-primary" onclick="event.stopPropagation(); app.masterAction('${a.id}','confirm')">Подтвердить</button>` : ''}
                    <button class="btn-secondary" onclick="event.stopPropagation(); app.masterAction('${a.id}','cancel')">Отменить</button>
                    <button class="btn-secondary" onclick="event.stopPropagation(); app.masterCash('${a.id}', '${a.price ?? 0}')">В кассу</button>`;
                return `<article class="master-booking" onclick="app.openMasterDetail('${a.id}')">
                    <strong>${dateInMoscow(slot.slot_time)} · ${escapeHtml(a.client_name)}</strong><div>${escapeHtml(a.service)}</div>
                    <small>${escapeHtml(a.phone)} · ${bookingStatus[a.status]}</small>
                    ${isPayment ? `<div class="booking-status">Перевод ${currency(a.prepayment_amount)}</div>` : ''}
                    ${a.attendance_confirmed_at ? '<div class="booking-status is-confirmed">Клиентка подтвердила визит</div>' : ''}
                    <div class="master-actions">${actions}</div></article>`;
            }).join('');
        } catch (error) {
            panel.textContent = error.message;
        }
    },

    renderMasterOverview: function(appointments) {
        const overview = document.getElementById('masterOverview');
        if (!overview) return;
        const now = Date.now();
        const rows = appointments.map(a => {
            const slot = Array.isArray(a.slots) ? a.slots[0] : a.slots;
            return { ...a, time: new Date(slot.slot_time).getTime() };
        }).sort((a, b) => a.time - b.time);
        const current = rows.find(a => a.time <= now && a.time + 3 * 60 * 60 * 1000 > now);
        const next = rows.find(a => a.time > now);
        const item = current || next;
        if (!item) { overview.innerHTML = ''; return; }
        const label = current ? 'Сейчас идёт запись' : 'Ближайшая запись';
        const date = new Date(item.time).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
        const remaining = Math.max(0, item.time - now);
        const left = current ? 'идёт сейчас' : `через ${Math.floor(remaining / 3600000)} ч ${Math.floor((remaining % 3600000) / 60000)} мин`;
        overview.innerHTML = `<div class="master-overview" onclick="app.openMasterDetail('${item.id}')"><strong>${label}</strong><div>${date} · ${escapeHtml(item.client_name)}</div><small>${escapeHtml(item.service)} · ${left}</small></div>`;
    },

    showMasterSection: function(section) {
        this.setMasterDrawer(false);
        this.setMasterDrawerActive(section);
        this.setMasterTitle(section);
        if (section === 'cash') this.loadMasterCash();
        else if (section === 'slots') this.loadMasterSlots();
        else if (section === 'profile') this.loadMasterProfile();
        else this.loadMasterCabinet(section);
    },

    setMasterDrawer: function(open) {
        const drawer = document.getElementById('masterDrawer');
        const button = document.getElementById('masterBurger');
        if (!drawer) return;
        drawer.hidden = !open;
        if (button) {
            button.setAttribute('aria-expanded', String(open));
            button.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
        }
    },

    setMasterTitle: function(section) {
        const title = document.getElementById('masterTitle');
        if (!title) return;
        const labels = { upcoming: 'ближайшая запись', bookings: 'записи', payments: 'предоплаты', cash: 'касса', slots: 'свободные окошки', profile: 'профиль' };
        title.textContent = `Кабинет мастера — ${labels[section] || 'записи'}`;
    },

    toggleMasterDrawer: function(event) {
        if (event) event.stopPropagation();
        const drawer = document.getElementById('masterDrawer');
        this.setMasterDrawer(Boolean(drawer && drawer.hidden));
    },

    setMasterDrawerActive: function(section) {
        document.querySelectorAll('[data-master-section]').forEach(button => {
            const active = button.dataset.masterSection === section;
            button.classList.toggle('active', active);
            if (active) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
    },

    loadMasterSlots: async function() {
        const panel = document.getElementById('masterPanel');
        if (!panel) return;
        panel.innerHTML = '<p class="slots-loading">Загружаю свободные окна…</p>';
        try {
            const result = await this.masterRequest('master_slots', { kind: 'list' });
            this.renderMasterSlots(result.slots || []);
        } catch (e) {
            panel.innerHTML = '<p class="slots-loading">Не удалось загрузить окна.</p>';
        }
    },

    renderMasterSlots: function(rows) {
        const panel = document.getElementById('masterPanel');
        const grouped = {};
        rows.forEach(row => {
            const d = new Date(row.slot_time);
            const key = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
            (grouped[key] ||= []).push(d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }));
        });
        const today = new Date();
        let month = new Date(today.getFullYear(), today.getMonth(), 1);
        const render = () => {
            const year = month.getFullYear();
            const monthIndex = month.getMonth();
            const firstDay = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
            const days = new Date(year, monthIndex + 1, 0).getDate();
            const monthLabel = month.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
            const cells = Array(firstDay).fill('<span class="master-slot-day is-empty"></span>');
            for (let day = 1; day <= days; day += 1) {
                const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const hasSlots = Boolean(grouped[key]?.length);
                cells.push(`<button class="master-slot-day${hasSlots ? ' has-slots' : ''}" data-slot-date="${key}" type="button">${day}</button>`);
            }
            panel.innerHTML = `<section class="master-slot-manager"><div class="master-slot-manager-head"><div><span class="eyebrow">свободные окна</span><h3>Добавить время</h3></div><div class="master-slot-month-nav"><button type="button" data-slot-prev aria-label="Предыдущий месяц">‹</button><strong>${monthLabel}</strong><button type="button" data-slot-next aria-label="Следующий месяц">›</button></div></div><div class="master-slot-weekdays"><span>пн</span><span>вт</span><span>ср</span><span>чт</span><span>пт</span><span>сб</span><span>вс</span></div><div class="master-slot-calendar">${cells.join('')}</div><div class="master-slot-editor" id="masterSlotEditor"><p>Выберите день в календаре</p></div></section>`;
            panel.querySelector('[data-slot-prev]').onclick = () => { month = new Date(year, monthIndex - 1, 1); render(); };
            panel.querySelector('[data-slot-next]').onclick = () => { month = new Date(year, monthIndex + 1, 1); render(); };
            panel.querySelectorAll('[data-slot-date]').forEach(button => { button.onclick = () => this.renderMasterSlotEditor(button.dataset.slotDate, grouped[button.dataset.slotDate] || []); });
        };
        render();
    },

    renderMasterSlotEditor: function(dateKey, existing) {
        const editor = document.getElementById('masterSlotEditor');
        if (!editor) return;
        const date = new Date(`${dateKey}T12:00:00`);
        const label = date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
        const options = [];
        for (let minutes = 9 * 60; minutes <= 20 * 60; minutes += 30) options.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
        editor.innerHTML = `<div class="master-slot-editor-head"><strong>${label}</strong><span>Нажмите на время, чтобы добавить свободное окно</span></div><div class="master-slot-times">${options.map(time => `<button type="button" class="slot-pill${existing.includes(time) ? ' selected is-added' : ''}" data-slot-time="${time}" ${existing.includes(time) ? 'disabled' : ''}><span>${time}</span>${existing.includes(time) ? '<small>добавлено</small>' : ''}</button>`).join('')}</div><div class="master-custom-time"><label for="masterCustomTime">Своё время</label><div><input id="masterCustomTime" type="time" step="1800" value="09:00"><button type="button" class="btn-secondary" id="masterCustomTimeAdd">Добавить</button></div></div><p class="master-slot-hint">После сохранения окно сразу появится в календаре клиентов.</p>`;
        editor.querySelectorAll('[data-slot-time]:not([disabled])').forEach(button => { button.onclick = () => this.addMasterSlot(dateKey, button.dataset.slotTime, button); });
        editor.querySelector('#masterCustomTimeAdd').onclick = () => this.addMasterSlot(dateKey, editor.querySelector('#masterCustomTime').value, editor.querySelector('#masterCustomTimeAdd'));
    },

    addMasterSlot: async function(dateKey, time, button) {
        if (!/^\d{2}:\d{2}$/.test(time || '')) return alert('Выберите время');
        const original = button.innerHTML;
        button.disabled = true;
        button.classList.add('is-saving');
        button.innerHTML = 'Сохраняю…';
        try {
            await this.masterRequest('master_slots', { kind: 'add', date: dateKey, time });
            await this.loadMasterSlots();
        } catch (e) {
            button.disabled = false;
            button.classList.remove('is-saving');
            button.innerHTML = original;
            alert(e.message);
        }
    },

    masterRequest: async function(action, extra = {}) {
        return api(action, extra);
    },

    loadMasterProfile: async function() {
        const panel = document.getElementById('masterPanel');
        document.getElementById('masterOverview').hidden = true;
        panel.innerHTML = '<p role="status">Загружаю профиль…</p>';
        try {
            const data = await this.masterRequest('master_profile', { kind: 'get' });
            panel.innerHTML = '<section class="details-section profile-editor profile-hero"><span class="eyebrow">личный кабинет</span><h3>Профиль мастера</h3><p class="profile-subtitle">Эти данные видят клиенты в mini app.</p><form id="profileDescriptionForm"><label for="profileDescription">Описание</label><textarea id="profileDescription" maxlength="2000" aria-label="Описание мастера"></textarea><div class="profile-form-footer"><span class="profile-counter" id="profileCounter">0 / 2000</span><button class="btn-primary">Сохранить</button></div></form></section><section class="details-section profile-editor"><div class="profile-section-head"><div><span class="eyebrow">витрина</span><h3>Услуги</h3></div><span class="profile-section-note">Зажмите карточку и перетащите</span></div><div id="profileServices" class="profile-services-list"></div><button type="button" class="btn-primary profile-save-order" id="profileSaveOrder" hidden>Сохранить порядок</button><form id="profileServiceForm" class="profile-add-form"><label>Новая услуга<input name="name" maxlength="150" placeholder="Например, маникюр с укреплением" required></label><div class="profile-fields"><label>Цена от, ₽<input name="price_min" type="number" min="0" step="1" required></label><label>Цена до, ₽<input name="price_max" type="number" min="0" step="1" required></label><label>Длительность, ч<input name="duration_hours" type="number" min="0.25" max="24" step="0.25" value="3" required></label></div><button class="btn-secondary">＋ Добавить услугу</button></form></section><section class="details-section profile-editor"><div class="profile-section-head"><div><span class="eyebrow">галерея</span><h3>Портфолио</h3></div><span class="profile-section-note">До 10 МБ на фото</span></div><div id="profilePhotos" class="profile-photos"></div><label class="btn-secondary profile-upload">＋ Добавить фотографию<input id="profilePhotoInput" type="file" accept="image/jpeg,image/png,image/webp" hidden></label><p class="master-slot-hint">JPG, PNG или WebP</p></section>';
            document.getElementById('profileDescription').value = data.profile.description;
            const description = document.getElementById('profileDescription');
            const counter = document.getElementById('profileCounter');
            const updateCounter = () => { counter.textContent = `${description.value.length} / 2000`; };
            description.oninput = updateCounter; updateCounter();
            this.profileServicesDraft = data.services.slice();
            this.profileServicesDirty = false;
            this.renderProfileServices();
            document.getElementById('profileSaveOrder').onclick = event => this.saveProfileOrder(event.currentTarget);
            const photos = document.getElementById('profilePhotos');
            data.photos.forEach(photo => {
                const row = document.createElement('div');
                const image = document.createElement('img'); image.src = this.portfolioUrl(photo.file_url); image.alt = 'Работа мастера'; image.loading = 'lazy';
                const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn-secondary'; remove.textContent = 'Убрать';
                remove.onclick = () => this.saveProfileChange({ kind: 'remove_photo', id: photo.id }, remove);
                row.append(image, remove); photos.append(row);
            });
            document.getElementById('profileDescriptionForm').onsubmit = event => {
                event.preventDefault();
                this.saveProfileChange({ kind: 'description', description: document.getElementById('profileDescription').value }, event.target.querySelector('button'));
            };
            document.getElementById('profileServiceForm').onsubmit = event => {
                event.preventDefault();
                this.saveProfileChange({ kind: 'add_service', ...Object.fromEntries(new FormData(event.target)) }, event.target.querySelector('button'));
            };
            document.getElementById('profilePhotoInput').onchange = async event => {
                const file = event.target.files[0]; if (!file) return;
                if (file.size > 10 * 1024 * 1024) return setAppStatus('Фотография должна быть до 10 МБ', 'error');
                event.target.disabled = true; setAppStatus('Загружаю фотографию…');
                try {
                    const upload = await this.masterRequest('master_profile', { kind: 'photo_upload', mime: file.type });
                    const { error } = await sb.storage.from('photos').uploadToSignedUrl(upload.path, upload.token, file);
                    if (error) throw error;
                    await this.masterRequest('master_profile', { kind: 'add_photo', path: upload.path });
                    await this.loadMasterProfile(); setAppStatus('Фотография добавлена');
                } catch (error) { event.target.disabled = false; setAppStatus(error.message === 'The related resource does not exist' ? 'Не найдено хранилище фотографий. Повтори загрузку через несколько секунд.' : (error.message || 'Не удалось добавить фотографию'), 'error'); }
            };
        } catch (error) { panel.textContent = error.message; }
    },

    saveProfileChange: async function(values, button) {
        button.disabled = true; setAppStatus('Сохраняю…');
        try {
            await this.masterRequest('master_profile', values);
            await this.loadMasterProfile(); setAppStatus('Изменения сохранены');
        } catch (error) { button.disabled = false; setAppStatus(error.message, 'error'); }
    },

    renderProfileServices: function() {
        const services = document.getElementById('profileServices');
        if (!services) return;
        services.innerHTML = '';
        this.profileServicesDraft.forEach((service, index) => {
            const row = document.createElement('div'); row.className = 'profile-service-row'; row.draggable = true; row.dataset.serviceId = service.id;
            const order = document.createElement('div'); order.className = 'profile-service-order';
            const grip = document.createElement('span'); grip.className = 'profile-service-grip'; grip.textContent = '☷'; grip.title = 'Зажмите и перетащите';
            const up = document.createElement('button'); up.type = 'button'; up.className = 'profile-order-btn'; up.textContent = '↑'; up.title = 'Поднять выше'; up.disabled = index === 0;
            const down = document.createElement('button'); down.type = 'button'; down.className = 'profile-order-btn'; down.textContent = '↓'; down.title = 'Опустить ниже'; down.disabled = index === this.profileServicesDraft.length - 1;
            up.onclick = () => this.shiftProfileService(index, -1); down.onclick = () => this.shiftProfileService(index, 1);
            order.append(grip, up, down);
            const text = document.createElement('div'); text.className = 'profile-service-copy';
            const name = document.createElement('strong'); name.textContent = service.name;
            const meta = document.createElement('small'); meta.textContent = `${service.price_min}–${service.price_max} ₽ · ${service.duration_hours} ч`;
            text.append(name, meta);
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn-secondary'; remove.textContent = 'Убрать';
            remove.onclick = () => this.saveProfileChange({ kind: 'remove_service', id: service.id }, remove);
            row.append(order, text, remove); services.append(row);
            row.ondragstart = () => { this.profileDragIndex = index; row.classList.add('is-dragging'); };
            row.ondragend = () => { this.profileDragIndex = null; row.classList.remove('is-dragging'); };
            row.ondragover = event => { event.preventDefault(); row.classList.add('is-drag-over'); };
            row.ondragleave = () => row.classList.remove('is-drag-over');
            row.ondrop = event => { event.preventDefault(); row.classList.remove('is-drag-over'); this.dropProfileService(index); };
        });
        const save = document.getElementById('profileSaveOrder');
        if (save) save.hidden = !this.profileServicesDirty;
    },

    shiftProfileService: function(index, direction) {
        const next = index + direction;
        if (next < 0 || next >= this.profileServicesDraft.length) return;
        [this.profileServicesDraft[index], this.profileServicesDraft[next]] = [this.profileServicesDraft[next], this.profileServicesDraft[index]];
        this.profileServicesDirty = true; this.renderProfileServices();
    },

    dropProfileService: function(targetIndex) {
        const from = this.profileDragIndex;
        if (from === null || from === undefined || from === targetIndex) return;
        const [moved] = this.profileServicesDraft.splice(from, 1);
        this.profileServicesDraft.splice(targetIndex, 0, moved);
        this.profileServicesDirty = true; this.renderProfileServices();
    },

    saveProfileOrder: async function(button) {
        button.disabled = true; setAppStatus('Сохраняю порядок…');
        try { await this.masterRequest('master_profile', { kind: 'reorder_services', order: this.profileServicesDraft.map(service => service.id) }); this.profileServicesDirty = false; this.renderProfileServices(); setAppStatus('Порядок услуг сохранён'); }
        catch (error) { button.disabled = false; setAppStatus(error.message || 'Не удалось сохранить порядок', 'error'); }
    },

    portfolioUrl: function(value) {
        return /^https:\/\//.test(value) ? value : '../' + value;
    },

    masterAction: async function(id, kind) {
        if (kind === 'reject_payment' && !confirm('Отклонить предоплату и освободить время?')) return;
        try {
            await this.masterRequest('master_action', { appointmentId: id, kind });
            const activeSection = document.querySelector('[data-master-section].active')?.dataset.masterSection;
            await this.loadMasterCabinet(activeSection || 'bookings');
        } catch (error) {
            alert(error.message);
        }
    },

    masterCash: async function(id, defaultAmount) {
        const amount = prompt('Итоговая сумма:', defaultAmount);
        if (amount === null) return;
        try { await this.masterRequest('master_action', { appointmentId: id, kind: 'cash', amount }); await this.loadMasterCabinet(); } catch (e) { alert(e.message); }
    },

    openMasterDetail: async function(id) {
        const modal = document.getElementById('masterModal');
        const content = document.getElementById('masterDetailContent');
        modal.hidden = false;
        content.innerHTML = '<p class="slots-loading">Загружаю карточку…</p>';
        try {
            const { appointment } = await this.masterRequest('master_detail', { appointmentId: id });
            const slot = Array.isArray(appointment.slots) ? appointment.slots[0] : appointment.slots;
            const date = new Date(slot.slot_time).toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
            const comment = appointment.comment || '';
            const beforeUrl = (comment.match(/Фото Исходник: (https:\/\/\S+)/) || [])[1];
            const refUrl = (comment.match(/Фото Референс: (https:\/\/\S+)/) || [])[1];
            const photos = appointment.photos || [];
            const beforeFile = photos.find(photo => photo.kind === 'before')?.file_id;
            const refFile = photos.find(photo => photo.kind === 'ref')?.file_id;
            const source = beforeUrl || (beforeFile ? '' : null);
            const reference = refUrl || (refFile ? '' : null);
            const sourceBlock = source ? `<div class="client-photo-card"><div class="client-photo-label">Исходник</div><img class="master-detail-photo" src="${source}" alt="Исходник ногтей клиента"></div>` : beforeFile ? `<div class="client-photo-card"><div class="client-photo-label">Исходник</div><div class="master-photo-loading" id="masterPhotoBefore">Загружаю фото…</div></div>` : '';
            const referenceBlock = reference ? `<div class="client-photo-card"><div class="client-photo-label">Референс</div><img class="master-detail-photo" src="${reference}" alt="Референс дизайна"></div>` : refFile ? `<div class="client-photo-card"><div class="client-photo-label">Референс</div><div class="master-photo-loading" id="masterPhotoRef">Загружаю фото…</div></div>` : '';
            const photoGrid = sourceBlock || referenceBlock ? `<div class="client-photo-grid">${sourceBlock}${referenceBlock}</div>` : '';
            content.innerHTML = `<article class="client-card"><div class="client-status-row"><span class="client-status">${bookingStatus[appointment.status]}</span></div><div class="client-card-top"><div><span class="eyebrow">карточка клиента</span><h2>${escapeHtml(appointment.client_name)}</h2></div></div><div class="client-meta"><span><i class="client-meta-icon icon-calendar"></i><b>Дата</b><em>${date}</em></span><span><i class="client-meta-icon icon-service"></i><b>Услуга</b><em>${escapeHtml(appointment.service)}</em></span><span><i class="client-meta-icon icon-money"></i><b>Стоимость</b><em>${appointment.price || 0} ₽</em></span><span><i class="client-meta-icon icon-phone"></i><b>Телефон</b><em>${escapeHtml(appointment.phone)}</em></span>${appointment.contact ? `<span><i class="client-meta-icon icon-contact"></i><b>Контакт</b><em>${escapeHtml(appointment.contact)}</em></span>` : ''}</div>${comment.replace(/Фото (Исходник|Референс): https:\/\/\S+/g, '').trim() ? `<p class="client-comment">${escapeHtml(comment.replace(/Фото (Исходник|Референс): https:\/\/\S+/g, '').trim())}</p>` : ''}${photoGrid}<div class="master-photo-actions"><label class="btn-secondary">Добавить исходник<input type="file" accept="image/*" hidden onchange="app.addMasterPhoto(event, 'before', '${id}')"></label><label class="btn-secondary">Добавить референс<input type="file" accept="image/*" hidden onchange="app.addMasterPhoto(event, 'ref', '${id}')"></label></div></article>`;
            if (beforeFile && !beforeUrl) this.loadMasterPhoto(beforeFile, 'masterPhotoBefore');
            if (refFile && !refUrl) this.loadMasterPhoto(refFile, 'masterPhotoRef');
        } catch (e) { content.innerHTML = '<p class="slots-loading">Не удалось загрузить карточку.</p>'; }
    },

    loadMasterPhoto: async function(fileId, targetId) {
        try {
            const response = await fetch(EDGE_FUNCTION_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }, body: JSON.stringify({ action: 'master_photo', initData: Telegram.WebApp.initData, fileId }) });
            if (!response.ok) throw new Error('Фото недоступно');
            const image = document.createElement('img'); image.className = 'master-detail-photo'; image.alt = 'Фото клиента'; image.src = URL.createObjectURL(await response.blob());
            document.getElementById(targetId)?.replaceWith(image);
        } catch (error) { const target = document.getElementById(targetId); if (target) target.textContent = 'Не удалось загрузить фото'; }
    },

    closeMasterDetail: function() { document.getElementById('masterModal').hidden = true; },

    addMasterPhoto: async function(event, kind, appointmentId) {
        const file = event.target.files[0];
        if (!file) return;
        const path = `master/${appointmentId}/${kind}_${Date.now()}_${file.name.replace(/[^a-z0-9._-]/gi, '_')}`;
        const { error } = await sb.storage.from('photos').upload(path, file, { upsert: true });
        if (error) return alert('Не удалось загрузить фото.');
        const { data } = sb.storage.from('photos').getPublicUrl(path);
        try { await this.masterRequest('master_add_photo', { appointmentId, kind, url: data.publicUrl }); await this.openMasterDetail(appointmentId); } catch (e) { alert(e.message); }
    },

    loadMasterCash: async function() {
        const panel = document.getElementById('masterPanel');
        document.getElementById('masterOverview').hidden = false;
        this.setMasterDrawerActive('cash');
        this.setMasterTitle('cash');
        try {
            const result = await this.masterRequest('master_cash');
            panel.innerHTML = `<div class="master-booking"><strong>Общий доход: ${result.total} ₽</strong><small>Завершённых записей: ${result.rows.length}</small></div>` + result.rows.map(row => `<article class="master-booking"><strong>${escapeHtml(row.client_name)} · ${row.price} ₽</strong><div>${row.service}</div><small>${row.completed_at ? new Date(row.completed_at).toLocaleString('ru-RU') : '—'}</small></article>`).join('');
        } catch (e) { panel.innerHTML = '<p class="slots-loading">Не удалось загрузить кассу.</p>'; }
    },

    openMyBookings: async function() {
        this.showScreen('my-bookings');
        await this.loadMyBookings();
    },

    loadMyBookings: async function() {
        const list = document.getElementById('myBookingsList');
        list.innerHTML = '<p class="slots-loading">Загружаем записи…</p>';
        try {
            const { bookings, reviewable, payment } = await api('client_bookings');
            state.myBookings = bookings;
            state.reviewable = reviewable;
            state.paymentConfig = payment;
            const cards = bookings.map(a => {
                const paymentPending = a.status === 'awaiting_payment' || a.status === 'payment_review';
                const primary = paymentPending
                    ? `<button type="button" class="btn-primary flow-wide" onclick="app.resumePayment('${a.id}')">${a.status === 'awaiting_payment' ? 'Перейти к предоплате' : 'Статус предоплаты'}</button>`
                    : `<button type="button" class="btn-primary flow-wide" onclick="app.startTransfer('${a.id}')">Перенести запись</button>`;
                return `<article class="flow-card">
                    <h3>${escapeHtml(a.service)}</h3><p>${dateInMoscow(a.slotTime)} · ${currency(a.price)}</p>
                    <p class="booking-status ${a.status === 'confirmed' ? 'is-confirmed' : ''}">${bookingStatus[a.status]}</p>
                    ${primary}
                    <button type="button" class="btn-secondary flow-wide" onclick="app.cancelBooking('${a.id}', this)">Отменить запись</button>
                </article>`;
            }).join('');
            const reviews = reviewable.map(a => `<article class="flow-card">
                <h3>${escapeHtml(a.service)}</h3><p>${dateInMoscow(a.slotTime)}</p>
                <button type="button" class="btn-secondary flow-wide" onclick="app.openReviewForm('${a.id}')">Оставить отзыв</button>
            </article>`).join('');
            list.innerHTML = `${cards || '<p class="slots-loading">У вас пока нет активных записей.</p>'}
                ${reviews ? '<h3 class="past-bookings-title">Прошедшие визиты</h3>' + reviews : ''}
                <button type="button" class="btn-primary flow-wide" onclick="app.showScreen('services')">Записаться</button>`;
        } catch (error) {
            list.textContent = error.message;
        }
    },

    startTransfer: async function(id) {
        const booking = state.myBookings.find(entry => entry.id === id);
        if (!booking) return;
        state.transferAppointment = booking;
        state.selectedService = { name: booking.service, price_min: booking.price || 0, price_max: booking.price || 0, duration_hours: 0 };
        await this.openCalendar();
    },

    leaveCalendar: function() {
        if (state.transferAppointment) {
            state.transferAppointment = null;
            state.selectedService = null;
            this.openMyBookings();
        } else {
            this.showScreen('services');
        }
    },

    cancelBooking: async function(id, btn) {
        const booking = state.myBookings.find(entry => entry.id === id);
        const submitted = booking?.payment_submitted_at || state.currentPayment?.id === id && state.currentPayment.status === 'payment_review';
        const prompt = submitted
            ? 'Отменить запись и освободить время? Если уже перевели деньги, свяжитесь с мастером.'
            : 'Отменить запись и освободить время?';
        if (!confirm(prompt)) return;
        btn.disabled = true;
        try {
            await api('client_cancel', { appointmentId: id });
            state.currentPayment = null;
            await this.openMyBookings();
        } catch (error) {
            alert(error.message);
        } finally {
            btn.disabled = false;
        }
    },

    resumePayment: function(id) {
        const booking = state.myBookings.find(entry => entry.id === id);
        if (booking) this.showPayment(booking, state.paymentConfig);
    },

    showPayment: function(booking, payment) {
        state.currentPayment = booking;
        this.showScreen('payment');
        const awaiting = booking.status === 'awaiting_payment';
        document.getElementById('paymentTitle').textContent = awaiting ? 'Предоплата' : 'На проверке';
        document.getElementById('paymentService').textContent = booking.service;
        document.getElementById('paymentTime').textContent = dateInMoscow(booking.slotTime) + ' (МСК)';
        document.getElementById('paymentDetails').hidden = !awaiting || !payment;
        document.getElementById('paymentCopyStatus').textContent = '';
        const status = document.getElementById('paymentStatus');
        const cancel = document.getElementById('paymentCancel');
        cancel.textContent = awaiting ? 'Отменить и освободить время' : 'Отменить запись';
        if (!awaiting) {
            status.textContent = 'Мастер проверяет перевод. Подтверждение записи придёт в Telegram.';
            return;
        }
        if (!payment) {
            status.textContent = 'Реквизиты пока недоступны. Напишите мастеру.';
            return;
        }
        document.getElementById('paymentAmount').textContent = currency(booking.prepayment_amount);
        document.getElementById('paymentRecipient').textContent = payment.recipient;
        document.getElementById('paymentBank').textContent = payment.bank;
        document.getElementById('paymentNumber').value = payment.details;
        const tick = () => {
            const remaining = Math.ceil((Date.parse(booking.payment_expires_at) - Date.now()) / 1000);
            if (remaining <= 0) {
                clearInterval(state.paymentTimer);
                document.getElementById('paymentDetails').hidden = true;
                cancel.textContent = 'К моим записям';
                status.textContent = 'Время резерва истекло. Если перевод уже сделан, напишите мастеру.';
                return;
            }
            const minutes = Math.ceil(remaining / 60);
            const text = `Окошко удерживается до ${dateInMoscow(booking.payment_expires_at)} (МСК). Осталось около ${minutes} мин.`;
            if (status.textContent !== text) status.textContent = text;
        };
        state.paymentTimer = setInterval(tick, 1000);
        tick();
    },

    copyPayment: async function() {
        const input = document.getElementById('paymentNumber');
        const status = document.getElementById('paymentCopyStatus');
        try {
            if (!navigator.clipboard?.writeText) throw new Error();
            await navigator.clipboard.writeText(input.value);
            status.textContent = 'Реквизиты скопированы';
        } catch {
            input.focus();
            input.select();
            input.setSelectionRange(0, input.value.length);
            let copied = false;
            try { copied = document.execCommand('copy'); } catch {}
            status.textContent = copied ? 'Реквизиты скопированы' : 'Реквизиты выделены. Нажмите «Копировать».';
        }
    },

    submitPayment: async function() {
        const booking = state.currentPayment;
        const button = document.getElementById('paymentSend');
        button.disabled = true;
        try {
            await api('client_pay', { appointmentId: booking.id });
            this.showPayment({ ...booking, status: 'payment_review' });
        } catch (error) {
            alert(error.message);
            if (error.status === 409) await this.openMyBookings();
        } finally {
            button.disabled = false;
        }
    },

    cancelCurrentPayment: function() {
        const booking = state.currentPayment;
        if (booking.status === 'awaiting_payment' && Date.parse(booking.payment_expires_at) <= Date.now()) return this.openMyBookings();
        return this.cancelBooking(booking.id, document.getElementById('paymentCancel'));
    },

    loadReviewSummary: async function() {
        try {
            const summary = await api('review_summary', {}, false);
            document.getElementById('ratingAverage').textContent = summary.average ? String(summary.average).replace('.', ',') : '';
            document.getElementById('ratingCount').textContent = summary.count ? `Отзывы · ${summary.count}` : 'Отзывы';
            document.getElementById('reviewsSummary').textContent = summary.count ? `★ ${summary.average} из 5 · ${summary.count}` : '';
            const filter = document.getElementById('reviewServiceFilter');
            const selected = filter.value;
            filter.replaceChildren(new Option('Все', ''), ...summary.services.map(service => new Option(serviceLabel(service), service)));
            filter.value = [...filter.options].some(option => option.value === selected) ? selected : '';
        } catch (error) {
            console.error('Не удалось загрузить рейтинг', error);
        }
    },

    openReviews: async function() {
        const screen = document.querySelector('.screen.active')?.id;
        state.reviewReturnScreen = ['screen-my-bookings', 'screen-write-review'].includes(screen) ? 'my-bookings' : 'services';
        this.showScreen('reviews');
        await Promise.all([this.loadReviewSummary(), this.loadReviews()]);
    },

    closeReviews: function() {
        if (state.reviewReturnScreen === 'my-bookings') this.openMyBookings();
        else this.showScreen('services');
    },

    loadReviews: async function(append = false) {
        const request = ++state.reviewRequest;
        const page = append ? state.reviewPage + 1 : 0;
        const list = document.getElementById('reviewsList');
        const more = document.getElementById('moreReviews');
        more.hidden = true;
        if (!append) list.innerHTML = '<p class="slots-loading">Загружаем отзывы…</p>';
        try {
            const { reviews, more: hasMore } = await api('reviews', {
                page,
                rating: document.getElementById('reviewRatingFilter').value,
                service: document.getElementById('reviewServiceFilter').value,
                sort: document.getElementById('reviewSort').value,
            }, false);
            if (request !== state.reviewRequest) return;
            const rows = reviews.map(review => `<article class="flow-card review-card">
                <div class="review-card-top"><span class="review-score" aria-label="${review.review_rating} из 5">${'★'.repeat(review.review_rating)}${'☆'.repeat(5 - review.review_rating)}</span><time datetime="${review.review_published_at}">${new Date(review.review_published_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' })}</time></div>
                <h3>${escapeHtml(serviceLabel(review.service))}</h3>
                ${review.review_text ? `<p>${escapeHtml(review.review_text)}</p>` : ''}
                ${review.hasPhoto ? `<img class="review-photo" loading="lazy" alt="Фото маникюра из отзыва" src="${EDGE_FUNCTION_URL}?review_photo=${encodeURIComponent(review.id)}">` : ''}
            </article>`).join('');
            if (append) list.insertAdjacentHTML('beforeend', rows);
            else list.innerHTML = rows || '<p class="slots-loading">По этим фильтрам отзывов пока нет.</p>';
            state.reviewPage = page;
            more.hidden = !hasMore;
        } catch (error) {
            if (request !== state.reviewRequest) return;
            if (append) {
                more.hidden = false;
                alert(error.message);
            } else {
                list.textContent = error.message;
            }
        }
    },

    openReviewForm: function(id) {
        const booking = state.reviewable.find(entry => entry.id === id);
        if (!booking) return;
        const form = document.getElementById('reviewForm');
        form.reset();
        const previousRating = form.querySelector(`input[name="rating"][value="${Number(booking.rating)}"]`);
        if (previousRating) previousRating.checked = true;
        form.elements.text.value = booking.text || '';
        document.getElementById('reviewService').textContent = booking.service;
        document.getElementById('reviewTime').textContent = dateInMoscow(booking.slotTime);
        document.getElementById('reviewFormStatus').textContent = '';
        form.onsubmit = async event => {
            event.preventDefault();
            const button = form.querySelector('button[type="submit"]');
            const data = new FormData(form);
            button.disabled = true;
            try {
                await api('client_review', { appointmentId: id, rating: Number(data.get('rating')), text: data.get('text') });
                document.getElementById('reviewRatingFilter').value = '';
                document.getElementById('reviewServiceFilter').value = '';
                document.getElementById('reviewSort').value = 'newest';
                setAppStatus('Отзыв опубликован', 'success');
                await this.openReviews();
            } catch (error) {
                document.getElementById('reviewFormStatus').textContent = error.message;
            } finally {
                button.disabled = false;
            }
        };
        this.showScreen('write-review');
    },

    loadData: async function() {
        setAppStatus('Загружаю услуги…');
        // Load services
        const { data: srvData, error: servicesError } = await sb.from('services').select('*').eq('is_active', true).order('sort_order');
        if (servicesError) {
            setAppStatus('Не удалось загрузить данные. Проверь соединение и попробуй ещё раз.', 'error');
            return;
        }
        if (srvData) {
            state.services = srvData;
            document.getElementById('servicesCount').textContent = srvData.length;
            this.renderServices();
        }

        const { data: profileData } = await sb.from('master_profile').select('description').eq('id', 1).maybeSingle();
        if (profileData?.description) document.querySelector('.master-desc').textContent = profileData.description;

        // Load portfolio photos
        const { data: photoData } = await sb.from('portfolio_photos').select('*').order('sort_order');
        if (photoData) {
            const gallery = document.getElementById('portfolioGallery');
            gallery.innerHTML = photoData.map(p => `<img src="${this.portfolioUrl(p.file_url)}" alt="Работа мастера" class="portfolio-img" loading="lazy">`).join('');
        }

        await this.loadReviewSummary();
        setAppStatus('');
    },

    loadSlots: async function() {
        const { slots } = await api('available_slots', {}, false);
        state.slots = slots.map(slot => {
            const date = new Date(slot.slot_time);
            const key = date.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
            return { id: slot.id, date, key, month: key.slice(0, 7) };
        });
        state.availableMonths = [...new Set(state.slots.map(slot => slot.month))].sort();
    },

    openCalendar: async function() {
        state.selectedSlot = null;
        state.selectedDay = null;
        document.getElementById('slotsGrid').replaceChildren();
        document.getElementById('calendarGrid').replaceChildren();
        document.getElementById('noSlotsMsg').style.display = 'none';
        this.showScreen('calendar');
        setAppStatus('Загружаем свободные окошки…');
        try {
            await this.loadSlots();
            if (state.availableMonths.length) this.openMonth(state.availableMonths[0]);
            else {
                document.getElementById('calendarMonthYear').textContent = 'Свободных окошек нет';
                document.getElementById('noSlotsMsg').style.display = 'block';
            }
            setAppStatus('');
        } catch (error) {
            setAppStatus(error.message, 'error');
        }
    },

    renderServices: function() {
        const list = document.getElementById('servicesList');
        list.innerHTML = state.services.map(s => `
            <div class="service-card" onclick="app.selectService('${s.id}')">
                <div class="service-name">${escapeHtml(s.name)}</div>
                <div class="service-footer">
                    <div>
                        <div class="service-price">${s.price_min}${s.price_max > s.price_min ? ' - ' + s.price_max : ''} ₽</div>
                        <div class="service-duration">${s.duration_hours} ч</div>
                    </div>
                    <button class="btn-pill" data-id="${s.id}" onclick="app.selectService('${s.id}'); event.stopPropagation();">
                        <div class="btn-pill-viewport">
                            <div class="btn-pill-wrapper">
                                <span>Выбрать</span>
                                <span>Выбрано</span>
                            </div>
                        </div>
                    </button>
                </div>
            </div>
        `).join('');
    },

    selectService: function(id) {
        state.selectedService = state.services.find(s => s.id === id);
        
        // Update UI buttons
        document.querySelectorAll('.service-card').forEach(card => {
            const btn = card.querySelector('.btn-pill');
            if (btn.dataset.id === id) {
                card.classList.add('selected');
                btn.classList.add('selected');
            } else {
                card.classList.remove('selected');
                btn.classList.remove('selected');
            }
        });
        
        this.updateStickyFooter('services');
    },

    openMonth: function(monthKey) {
        state.currentMonth = monthKey;
        const [y, m] = monthKey.split('-').map(Number);
        const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
        document.getElementById('calendarMonthYear').textContent = `${monthNames[m - 1]} ${y}`;
        
        const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
        let firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
        firstDow = firstDow === 0 ? 6 : firstDow - 1; // Mon = 0
        
        const grid = document.getElementById('calendarGrid');
        grid.innerHTML = '';
        
        for (let i = 0; i < firstDow; i++) {
            grid.innerHTML += `<div></div>`;
        }
        
        for (let d = 1; d <= daysInMonth; d++) {
            const dayStr = d.toString().padStart(2, '0');
            const fullKey = `${monthKey}-${dayStr}`;
            
            const hasSlots = state.slots.some(s => s.key === fullKey);
            const isSelected = state.selectedDay === fullKey;
            
            let classes = 'cal-day';
            if (hasSlots) classes += ' available';
            else classes += ' disabled';
            if (isSelected) classes += ' selected';
            
            grid.innerHTML += `<div class="${classes}" ${hasSlots ? `onclick="app.selectDay('${fullKey}')"` : ''}>${d}</div>`;
        }
    },

    selectDay: function(dayKey) {
        state.selectedDay = dayKey;
        state.selectedSlot = null; // Reset slot
        this.openMonth(state.currentMonth); // re-render to show selection
        
        const daySlots = state.slots.filter(s => s.key === dayKey);
        const grid = document.getElementById('slotsGrid');
        const noSlots = document.getElementById('noSlotsMsg');
        
        if (daySlots.length === 0) {
            grid.innerHTML = '';
            noSlots.style.display = 'block';
        } else {
            noSlots.style.display = 'none';
            grid.innerHTML = daySlots.map(s => {
                const time = s.date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
                return `<button class="slot-pill" data-id="${s.id}" data-time="${time}" onclick="app.selectSlot('${s.id}')">${time}</button>`;
            }).join('');
        }
        this.updateStickyFooter('calendar');
    },

    selectSlot: function(id) {
        state.selectedSlot = state.slots.find(s => s.id === id);
        document.querySelectorAll('.slot-pill').forEach(btn => {
            if (btn.dataset.id === id) btn.classList.add('selected');
            else btn.classList.remove('selected');
        });
        this.updateStickyFooter('calendar');
    },

    updateStickyFooter: function(screenId) {
        const footer = document.getElementById('stickyFooter');
        const btn = document.getElementById('footerActionBtn');
        const priceEl = document.getElementById('footerPrice');
        const durEl = document.getElementById('footerDuration');
        
        if (!state.selectedService) {
            footer.style.display = 'none';
            return;
        }
        
        footer.style.display = 'flex';
        
        const s = state.selectedService;
        priceEl.textContent = `${s.price_min}${s.price_max > s.price_min ? ' - ' + s.price_max : ''} ₽`;
        durEl.textContent = `${s.duration_hours} ч`;

        if (screenId === 'services') {
            btn.textContent = 'Продолжить →';
            btn.onclick = () => this.openCalendar();
            btn.disabled = false;
        } 
        else if (screenId === 'calendar') {
            if (state.selectedSlot) {
                const d = state.selectedDay.split('-');
                btn.textContent = state.transferAppointment ? `Перенести на ${d[2]}.${d[1]}` : `Записаться ${d[2]}.${d[1]}`;
                btn.disabled = false;
                btn.onclick = () => state.transferAppointment ? this.submitBooking() : this.showScreen('details');
            } else {
                btn.textContent = 'Выберите время';
                btn.disabled = true;
            }
        }
        else if (screenId === 'details') {
            if (state.selectedSlot) {
                btn.textContent = 'К предоплате';
                btn.disabled = false;
                btn.onclick = () => this.submitBooking();
            }
        }
        else {
            footer.style.display = 'none';
        }
    },

    setupEvents: function() {
        document.getElementById('prevMonth').addEventListener('click', () => {
            const idx = state.availableMonths.indexOf(state.currentMonth);
            if (idx > 0) this.openMonth(state.availableMonths[idx - 1]);
        });
        document.getElementById('nextMonth').addEventListener('click', () => {
            const idx = state.availableMonths.indexOf(state.currentMonth);
            if (idx < state.availableMonths.length - 1) this.openMonth(state.availableMonths[idx + 1]);
        });
        
        // Photo uploads
        document.getElementById('photoInput').addEventListener('change', (e) => {
            const files = Array.from(e.target.files).slice(0, 3 - state.photos.length);
            files.forEach(f => {
                const reader = new FileReader();
                reader.onload = (re) => {
                    state.photos.push({ file: f, dataUrl: re.target.result });
                    this.renderPhotos();
                };
                reader.readAsDataURL(f);
            });
        });
    },

    renderPhotos: function() {
        const grid = document.getElementById('photosGrid');
        
        // Keep the upload button
        const uploadBtnHtml = state.photos.length < 3 ? `
            <label class="photo-upload-btn">
                <input type="file" accept="image/*" id="photoInput" multiple>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 5v14M5 12h14"/></svg>
            </label>
        ` : '';
        
        const photosHtml = state.photos.map((p, idx) => `
            <div class="photo-preview">
                <img src="${p.dataUrl}">
                <div class="remove-btn" onclick="app.removePhoto(${idx})">✕</div>
            </div>
        `).join('');
        
        grid.innerHTML = photosHtml + uploadBtnHtml;
        
        // re-bind event
        if (state.photos.length < 3) {
            document.getElementById('photoInput').addEventListener('change', (e) => {
                const files = Array.from(e.target.files).slice(0, 3 - state.photos.length);
                files.forEach(f => {
                    const reader = new FileReader();
                    reader.onload = (re) => {
                        state.photos.push({ file: f, dataUrl: re.target.result });
                        this.renderPhotos();
                    };
                    reader.readAsDataURL(f);
                });
            });
        }
    },
    
    removePhoto: function(idx) {
        state.photos.splice(idx, 1);
        this.renderPhotos();
    },

    submitBooking: async function() {
        const button = document.getElementById('footerActionBtn');
        const slot = state.selectedSlot;
        if (button.disabled || !slot) return;
        button.disabled = true;
        button.textContent = 'Отправляем…';
        try {
            if (state.transferAppointment) {
                await api('client_move', { appointmentId: state.transferAppointment.id, slotId: slot.id });
                state.transferAppointment = null;
                state.selectedService = null;
                await this.openMyBookings();
                return;
            }
            const photos = [];
            for (const { file } of state.photos) {
                const extension = file.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'jpg';
                const path = `ref_${crypto.randomUUID()}.${extension}`;
                const { error } = await sb.storage.from('photos').upload(path, file);
                if (error) throw new Error('Не удалось загрузить фото. Попробуйте ещё раз.');
                photos.push(sb.storage.from('photos').getPublicUrl(path).data.publicUrl);
            }
            const result = await api('client_booking', {
                slotId: slot.id, serviceId: state.selectedService.id, photos,
                comment: document.getElementById('bookingComment').value,
            });
            document.getElementById('bookingComment').value = '';
            state.photos = [];
            state.selectedService = null;
            this.renderPhotos();
            this.showPayment({ ...result.booking, slotTime: slot.date }, result.payment);
        } catch (error) {
            alert(error.message);
            if (error.status === 409) await this.openCalendar();
        } finally {
            this.updateStickyFooter(document.querySelector('.screen.active').id.slice('screen-'.length));
        }
    }

};

// Глобальный обработчик нужен для бургер-кнопки даже пока кабинет ещё загружает данные.
window.toggleMasterDrawer = function(event) {
    if (event) event.stopPropagation();
    const drawer = document.getElementById('masterDrawer');
    const button = document.getElementById('masterBurger');
    if (!drawer) return;
    const open = drawer.hidden;
    drawer.hidden = !open;
    if (button) {
        button.setAttribute('aria-expanded', String(open));
        button.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    }
};

// Start
window.app = app;
app.init();
