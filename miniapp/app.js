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
const NOTIFY_SECRET = 'nailspace_notify_2026';

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
    photos: []
};

// App Logic
const app = {
    init: async function() {
        const urlParams = new URLSearchParams(window.location.search);
        const screenParam = urlParams.get('screen') || Telegram.WebApp.initDataUnsafe?.start_param;
        
        if (screenParam === 'my_bookings') {
            this.showScreen('my-bookings');
            await this.loadMyBookings();
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
                    <button class="btn-secondary" style="margin-top:12px;width:100%;background:rgba(255,255,255,0.1);color:#fff" onclick="app.cancelBooking('${a.id}')">Отменить запись</button>
                </div>
            </div>
            `;
        }).join('');
        
        html += `<button class="btn-primary" style="margin-top:16px;width:100%" onclick="window.location.href='?screen=services'">Записаться ещё</button>`;
        list.innerHTML = html;
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
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'x-notify-secret': NOTIFY_SECRET },
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
        // Load services
        const { data: srvData } = await sb.from('services').select('*').eq('is_active', true).order('sort_order');
        if (srvData) {
            state.services = srvData;
            document.getElementById('servicesCount').textContent = srvData.length;
            this.renderServices();
        }

        // Load portfolio photos
        const { data: photoData } = await sb.from('portfolio_photos').select('*').order('sort_order');
        if (photoData) {
            const gallery = document.getElementById('portfolioGallery');
            gallery.innerHTML = photoData.map(p => `<img src="../${p.file_url}" alt="Work" class="portfolio-img">`).join('');
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
                btn.textContent = `Записаться ${d[2]}.${d[1]}`;
                btn.disabled = false;
                btn.onclick = () => this.showScreen('details');
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
                btn.disabled = false;
                this.showScreen('calendar');
                await this.loadData();
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
                    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                    'x-notify-secret': NOTIFY_SECRET
                },
                body: JSON.stringify({
                    action: 'new_appointment',
                    appointmentId: appointment.id,
                    clientName: appointment.client_name,
                    phone: appointment.phone,
                    contact: appointment.contact,
                    contactType: 'Телеграм',
                    service: appointment.service,
                    comment: appointment.comment,
                    price: appointment.price,
                    slotTime: `${dayRu}, ${timeStr}`
                })
            }).catch(e => console.error(e));

            // Show success screen
            this.showScreen('success');
            document.getElementById('successDateTime').textContent = `${dayRu} · ${timeStr}`;
            document.getElementById('successService').textContent = `${state.selectedService.name} · ${state.selectedService.price_min}${state.selectedService.price_max > state.selectedService.price_min ? ' - ' + state.selectedService.price_max : ''} ₽ · ${state.selectedService.duration_hours} ч`;

            // Tell telegram we are done and hide MainButton
            Telegram.WebApp.MainButton.hide();

        } catch (err) {
            alert(err.message || 'Ошибка записи');
            btn.textContent = 'Продолжить →';
            btn.disabled = false;
        }
    }
};

// Start
app.init();
