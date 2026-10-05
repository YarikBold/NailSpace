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
    transferAppointment: null
};

function setAppStatus(message, type = '') {
    const el = document.getElementById('appStatus');
    if (!el) return;
    el.textContent = message || '';
    el.className = `app-status${type ? ' ' + type : ''}`;
    el.hidden = !message;
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
        document.getElementById('masterOverview').hidden = false;
        this.setMasterDrawerActive(activeSection);
        this.setMasterTitle(activeSection);
        try {
            const response = await fetch(EDGE_FUNCTION_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
                body: JSON.stringify({ action: 'master_list', initData: Telegram.WebApp.initData }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Доступ запрещён');
            if (!result.appointments.length) {
                panel.innerHTML = '<p class="slots-loading">Ближайших записей нет.</p>';
                return;
            }
            this.renderMasterOverview(result.appointments);
            panel.innerHTML = result.appointments.map(a => {
                const slot = Array.isArray(a.slots) ? a.slots[0] : a.slots;
                const date = new Date(slot.slot_time).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
                const actions = a.status === 'new'
                    ? `<button class="btn-primary" onclick="app.masterAction('${a.id}','confirm')">Подтвердить</button>`
                    : '';
                return `<article class="master-booking" onclick="app.openMasterDetail('${a.id}')"><strong>${date} · ${a.client_name}</strong><div>${a.service}</div><small>${a.phone} · ${a.status === 'confirmed' ? 'подтверждена' : 'новая'}</small><div class="master-actions">${actions}<button class="btn-secondary" onclick="event.stopPropagation(); app.masterAction('${a.id}','cancel')">Отменить</button><button class="btn-secondary" onclick="event.stopPropagation(); app.masterCash('${a.id}', '${a.price || 0}')">В кассу</button></div></article>`;
            }).join('');
        } catch (error) {
            panel.innerHTML = '<p class="slots-loading">Кабинет доступен только мастеру.</p>';
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
        overview.innerHTML = `<div class="master-overview" onclick="app.openMasterDetail('${item.id}')"><strong>${label}</strong><div>${date} · ${item.client_name}</div><small>${item.service} · ${left}</small></div>`;
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
        const labels = { upcoming: 'ближайшая запись', bookings: 'записи', cash: 'касса', slots: 'свободные окошки', profile: 'профиль' };
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
        const response = await fetch(EDGE_FUNCTION_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }, body: JSON.stringify({ action, initData: Telegram.WebApp.initData, ...extra }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Ошибка кабинета');
        return result;
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
        try { await this.masterRequest('master_action', { appointmentId: id, kind }); await this.loadMasterCabinet(); } catch (e) { alert(e.message); }
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
            content.innerHTML = `<article class="client-card"><div class="client-card-top"><div><span class="eyebrow">карточка клиента</span><h2>${appointment.client_name}</h2></div><span class="client-status">${appointment.status === 'confirmed' ? 'Подтверждена' : 'Новая'}</span></div><div class="client-meta"><span><b>Дата</b>${date}</span><span><b>Услуга</b>${appointment.service}</span><span><b>Стоимость</b>${appointment.price || 0} ₽</span><span><b>Телефон</b>${appointment.phone}</span>${appointment.contact ? `<span><b>Контакт</b>${appointment.contact}</span>` : ''}</div>${comment.replace(/Фото (Исходник|Референс): https:\/\/\S+/g, '').trim() ? `<p class="client-comment">${comment.replace(/Фото (Исходник|Референс): https:\/\/\S+/g, '').trim()}</p>` : ''}${photoGrid}<div class="master-photo-actions"><label class="btn-secondary">Добавить исходник<input type="file" accept="image/*" hidden onchange="app.addMasterPhoto(event, 'before', '${id}')"></label><label class="btn-secondary">Добавить референс<input type="file" accept="image/*" hidden onchange="app.addMasterPhoto(event, 'ref', '${id}')"></label></div></article>`;
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
            panel.innerHTML = `<div class="master-booking"><strong>Общий доход: ${result.total} ₽</strong><small>Завершённых записей: ${result.rows.length}</small></div>` + result.rows.map(row => `<article class="master-booking"><strong>${row.client_name} · ${row.price} ₽</strong><div>${row.service}</div><small>${row.completed_at ? new Date(row.completed_at).toLocaleString('ru-RU') : '—'}</small></article>`).join('');
        } catch (e) { panel.innerHTML = '<p class="slots-loading">Не удалось загрузить кассу.</p>'; }
    },

    loadMyBookings: async function() {
        const list = document.getElementById('myBookingsList');
        const chatId = Telegram.WebApp.initDataUnsafe?.user?.id;
        
        if (!chatId) {
            list.innerHTML = '<p class="slots-loading">Откройте приложение внутри Telegram.</p>';
            return;
        }

        const today = new Date();
        today.setHours(0,0,0,0);

        const { data: apps, error } = await sb
            .from('appointments')
            .select('*, slots!inner(slot_time)')
            .eq('chat_id', String(chatId))
            .in('status', ['new', 'confirmed'])
            .gte('slots.slot_time', today.toISOString())
            .order('slot_time', { foreignTable: 'slots', ascending: true });

        if (error || !apps || apps.length === 0) {
            list.innerHTML = '<div style="text-align:center; padding: 20px 0;"><p style="margin-bottom:24px; color:var(--text-muted);">У вас пока нет активных записей.</p><button class="btn-primary" style="width:100%" onclick="window.location.href=\'?screen=services\'">Записаться</button></div>';
            return;
        }

        let html = apps.map(a => {
            const slotDate = new Date(a.slots.slot_time);
            const timeStr = slotDate.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
            
            let statusText = '';
            if (a.status === 'new') statusText = '<span style="color:#facc15">Ожидает подтверждения</span>';
            if (a.status === 'confirmed') statusText = '<span style="color:#4ade80">Подтверждена</span>';

            return `
            <div class="service-card" style="margin-bottom:16px;">
                <div class="service-name">${a.service}</div>
                <div class="service-footer" style="flex-direction:column; align-items:flex-start; gap:8px;">
                    <div><strong>Дата:</strong> ${timeStr}</div>
                    <div><strong>Цена:</strong> ${a.price || '—'} ₽</div>
                    <div><strong>Статус:</strong> ${statusText}</div>
                    <button class="btn-primary" style="margin-top:12px;width:100%" onclick="app.startTransfer('${a.id}')">Перенести запись</button>
                    <button class="btn-secondary" style="width:100%;background:rgba(255,255,255,0.1);color:#fff" onclick="app.cancelBooking('${a.id}')">Отменить запись</button>
                </div>
            </div>
            `;
        }).join('');
        
        html += `<button class="btn-primary" style="margin-top:16px;width:100%" onclick="window.location.href='?screen=services'">Записаться ещё</button>`;
        list.innerHTML = html;
    },

    startTransfer: async function(id) {
        const { data: booking, error } = await sb.from('appointments').select('id, slot_id, service, price').eq('id', id).single();
        if (error || !booking) return alert('Не удалось открыть перенос записи.');
        state.transferAppointment = booking;
        state.selectedService = { name: booking.service, price_min: booking.price || 0, price_max: booking.price || 0, duration_hours: 0 };
        state.selectedSlot = null;
        if (!state.slots.length) await this.loadData();
        this.showScreen('calendar');
    },

    cancelBooking: async function(id) {
        if (!confirm('Точно отменить запись?')) return;
        const btn = event.target;
        btn.textContent = 'Отменяем...';
        btn.disabled = true;

        try {
            const { data: appData } = await sb.from('appointments').select('slot_id').eq('id', id).single();
            await sb.from('appointments').update({ status: 'canceled' }).eq('id', id);
            if (appData && appData.slot_id) {
                await sb.from('slots').update({ status: 'available' }).eq('id', appData.slot_id);
            }
            
            // Notify master via Edge function
            fetch(EDGE_FUNCTION_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
                body: JSON.stringify({ action: 'cancel_appointment', appointmentId: id })
            }).catch(() => {});

            alert('Запись отменена.');
            this.loadMyBookings();
        } catch (e) {
            alert('Ошибка при отмене.');
            btn.textContent = 'Отменить запись';
            btn.disabled = false;
        }
    },

    loadData: async function() {
        setAppStatus('Загружаю услуги и свободные окошки…');
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

        // Load reviews stats
        const { data: revData } = await sb.from('appointments').select('review_rating').not('review_rating', 'is', null);
        if (revData && revData.length > 0) {
            const sum = revData.reduce((acc, curr) => acc + curr.review_rating, 0);
            const avg = (sum / revData.length).toFixed(1);
            document.getElementById('masterRating').innerHTML = `<span class="rating-star">★</span><span class="rating-val">${avg}</span><span class="rating-count">${revData.length} оценок</span>`;
        }

        // Load calendar slots
        const { data: slotsData } = await sb.from('slots').select('*').eq('status', 'available').gte('slot_time', new Date().toISOString()).order('slot_time');
        
        if (slotsData) {
            state.slots = slotsData.map(s => {
                const d = new Date(s.slot_time);
                const localStr = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
                const key = localStr.split('T')[0];
                return { id: s.id, date: d, key, month: key.slice(0, 7) };
            });
            state.availableMonths = [...new Set(state.slots.map(s => s.month))].sort();
            if (state.availableMonths.length > 0) {
                this.openMonth(state.availableMonths[0]);
            }
        }
        setAppStatus('');
    },

    renderServices: function() {
        const list = document.getElementById('servicesList');
        list.innerHTML = state.services.map(s => `
            <div class="service-card" onclick="app.selectService('${s.id}')">
                <div class="service-name">${s.name}</div>
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
                const time = s.date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
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
            btn.onclick = () => this.showScreen('calendar');
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
                const d = state.selectedDay.split('-');
                const time = state.selectedSlot.date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                btn.textContent = `Записаться ${d[2]}.${d[1]} в ${time}`;
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
        const btn = document.getElementById('footerActionBtn');
        btn.textContent = 'Отправляем...';
        btn.disabled = true;
        setAppStatus('Создаю запись…');

        try {
            // Claim slot
            const { data: claimed, error: claimError } = await sb
                .from('slots')
                .update({ status: 'booked' })
                .eq('id', state.selectedSlot.id)
                .eq('status', 'available')
                .select();
                
            if (claimError || !claimed || claimed.length === 0) {
                alert('Увы, это окошко только что заняли — выбери другое.');
                setAppStatus('Окошко уже заняли. Выбери другое.', 'error');
                btn.disabled = false;
                this.showScreen('calendar');
                await this.loadData();
                return;
            }

            if (state.transferAppointment) {
                const oldSlotId = state.transferAppointment.slot_id;
                const { error: updateError } = await sb.from('appointments')
                    .update({ slot_id: state.selectedSlot.id })
                    .eq('id', state.transferAppointment.id)
                    .eq('slot_id', oldSlotId);
                if (updateError) {
                    await sb.from('slots').update({ status: 'available' }).eq('id', state.selectedSlot.id);
                    throw updateError;
                }
                await sb.from('slots').update({ status: 'available' }).eq('id', oldSlotId);
                await fetch(EDGE_FUNCTION_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
                    body: JSON.stringify({ action: 'transfer_appointment', appointmentId: state.transferAppointment.id }),
                });
                state.transferAppointment = null;
                state.selectedSlot = null;
                alert('Запись перенесена.');
                this.showScreen('my-bookings');
                await this.loadMyBookings();
                setAppStatus('');
                return;
            }

            // Client data from Telegram WebApp
            const user = Telegram.WebApp.initDataUnsafe?.user;
            const tgUsername = user?.username ? '@' + user.username : null;
            const clientName = user?.first_name ? user.first_name + (user.last_name ? ' ' + user.last_name : '') : 'Клиент из Telegram';
            const chatId = user?.id;
            
            // Upload photos if any
            const photoUrls = [];
            for (const p of state.photos) {
                const ext = p.file.name.split('.').pop();
                const fileName = `ref_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
                const { data: uploadData, error } = await sb.storage.from('photos').upload(fileName, p.file);
                if (!error) {
                    const { data: pubData } = sb.storage.from('photos').getPublicUrl(fileName);
                    photoUrls.push(pubData.publicUrl);
                }
            }

            // Insert appointment
            const commentStr = document.getElementById('bookingComment').value.trim();
            const fullComment = photoUrls.length > 0 ? 
                (commentStr ? commentStr + '\n\nФото-референсы:\n' + photoUrls.join('\n') : 'Фото-референсы:\n' + photoUrls.join('\n')) : commentStr;

            const { data: appointment, error: insertError } = await sb
                .from('appointments')
                .insert({
                    slot_id: state.selectedSlot.id,
                    client_name: clientName,
                    phone: 'Telegram', // Or ask phone
                    contact: tgUsername,
                    chat_id: chatId ? chatId.toString() : null,
                    service: state.selectedService.name,
                    comment: fullComment || null,
                    price: state.selectedService.price_min,
                    status: 'new'
                })
                .select()
                .single();

            if (insertError) {
                await sb.from('slots').update({ status: 'available' }).eq('id', state.selectedSlot.id);
                throw insertError;
            }

            // Notify via edge function
            const dayRu = new Date(state.selectedDay + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
            const timeStr = state.selectedSlot.date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            
            fetch(EDGE_FUNCTION_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
                },
                body: JSON.stringify({
                    action: 'new_appointment',
                    appointmentId: appointment.id
                })
            }).catch(e => console.error(e));

            // Show success screen
            this.showScreen('success');
            setAppStatus('');
            document.getElementById('successDateTime').textContent = `${dayRu} · ${timeStr}`;
            document.getElementById('successService').textContent = `${state.selectedService.name} · ${state.selectedService.price_min}${state.selectedService.price_max > state.selectedService.price_min ? ' - ' + state.selectedService.price_max : ''} ₽ · ${state.selectedService.duration_hours} ч`;

            // Tell telegram we are done and hide MainButton
            Telegram.WebApp.MainButton.hide();

        } catch (err) {
            alert(err.message || 'Ошибка записи');
            setAppStatus('Не удалось создать запись. Попробуй ещё раз.', 'error');
            btn.textContent = 'Продолжить →';
            btn.disabled = false;
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


