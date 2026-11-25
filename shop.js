'use strict';

const $ = selector => document.querySelector(selector);
const number = new Intl.NumberFormat('ru-RU');
const money = amount => number.format(amount) + ' ₽';
const stockLimit = product => product.stock ?? 99;
const escapeText = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const priceList = [
  ['nerka', 'Икра нерки', [2600, 3450, 8500]],
  ['keta', 'Икра кеты', [2900, 3850, 9500]],
  ['gorbusha', 'Икра горбуши', [3050, 4050, 10000]]
];
const defaults = priceList.flatMap(([code, name, prices]) =>
  [150, 200, 500].map((weight, index) => ({
    id: code + weight, name, desc: weight + ' г', price: prices[index], stock: null
  }))
);

function readSaved(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function save(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); return true; }
  catch { $('#status').textContent = 'Хранилище браузера недоступно.'; return false; }
}
function validProduct(product) {
  return product && typeof product.id === 'string' && /^[a-z0-9_-]+$/i.test(product.id)
    && typeof product.name === 'string' && typeof product.desc === 'string'
    && Number.isSafeInteger(product.price) && product.price >= 0
    && (product.stock === null || Number.isSafeInteger(product.stock) && product.stock >= 0);
}
function loadProducts() {
  const saved = readSaved('ikra-products-v3', null);
  if (Array.isArray(saved)) return saved.filter(validProduct);
  const legacy = readSaved('ikra-products-v2', []);
  const demos = {
    gorbusha: ['Икра горбуши', 'Нежный классический вкус · 250 г', 2500, 8],
    keta: ['Икра кеты', 'Крупная икринка · 250 г', 3200, 6],
    nerka: ['Икра нерки', 'Насыщенный вкус · 250 г', 2900, 10]
  };
  const keep = Array.isArray(legacy) ? legacy.filter(validProduct).filter(item =>
    item.id !== 'black' && !/^ч[её]рная икра/i.test(item.name)
    && JSON.stringify(demos[item.id]) !== JSON.stringify([item.name, item.desc, item.price, item.stock])
  ) : [];
  return [...defaults, ...keep];
}

const shared = document.documentElement.dataset.shared === 'true';
// Витрина (index.html) и кабинет владельца (owner.html) используют один скрипт.
const ownerPage = document.body.dataset.page === 'owner';
const previousCatalog = loadProducts();
let products = previousCatalog;
let revision = null;
let lastSaved = structuredClone(previousCatalog);
let canEdit = !shared;
let saving = false;
let refreshInProgress = null;
const savedCart = readSaved('ikra-cart', {});
const cart = new Map();
for (const [id, quantity] of Object.entries(savedCart ?? {})) {
  if (Number.isSafeInteger(quantity) && quantity > 0) cart.set(id, quantity);
}
const selection = new Map();
let editingId = null;
const timers = new WeakMap();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const maxPhotos = 6;
const photoId = /^[a-f0-9]{64}$/;
const localPhoto = /^data:image\/jpeg;base64,[a-z0-9+/]+=*$/i;
function itemPhotos(item) {
  return Array.isArray(item?.photos) ? item.photos.filter(ref => typeof ref === 'string' && (photoId.test(ref) || localPhoto.test(ref))).slice(0, maxPhotos) : [];
}
function photoUrl(ref) {
  return photoId.test(ref) ? '/media/' + ref + '.jpg' : ref;
}
function animate(element, frames, duration = 220, delay = 0) {
  if (!reducedMotion.matches && element?.animate) {
    element.animate(frames, {duration, delay, easing: 'cubic-bezier(.22,.75,.25,1)', fill: 'backwards'});
  }
}
function productPicture(item) {
  const photos = itemPhotos(item);
  if (photos.length) {
    return `<div class="picture gallery" data-photo-index="0" data-product="${item.id}">
      <img src="${photoUrl(photos[0])}" width="720" height="720" alt="${escapeText(item.name + ', ' + item.desc)} — фото 1" decoding="async">
      ${photos.length > 1 ? `<div class="gallery-controls"><div>
        <button type="button" data-photo-step="-1" aria-label="Предыдущее фото">‹</button>
        <span aria-live="polite">1 / ${photos.length}</span>
        <button type="button" data-photo-step="1" aria-label="Следующее фото">›</button>
      </div></div>` : ''}</div>`;
  }
  const species = priceList.find(([code, name]) => item.id.startsWith(code) || item.name === name)?.[0];
  if (!species) {
    return '<div class="picture"><img src="assets/product.jpg" width="720" height="720" alt=""></div>';
  }
  const src = 'assets/' + species + '.jpg';
  const small = 'assets/' + species + '-small.jpg';
  const sizes = '(max-width: 700px) 140px, (max-width: 1050px) 30vw, 390px';
  const image = `<img src="${src}" srcset="${small} 360w, ${src} 720w" sizes="${sizes}" width="720" height="720" alt="" decoding="async">`;
  return `<button type="button" class="picture jar" data-species="${species}" aria-label="Приоткрыть крышку: ${escapeText(item.name)}" aria-pressed="false">
    ${image}
    <span class="jar-inside" aria-hidden="true"></span>
    <span class="jar-lid" aria-hidden="true">${image}</span>
  </button>`;
}
function setLid(jar, open) {
  jar.setAttribute('aria-pressed', String(open));
}
for (const [eventName, open] of [['pointerover', true], ['pointerout', false]]) {
  $('#products')?.addEventListener(eventName, event => {
    const jar = event.target.closest('.jar');
    if (jar && event.pointerType === 'mouse' && !jar.contains(event.relatedTarget)) setLid(jar, open);
  });
}
$('#products')?.addEventListener('focusout', event => {
  const jar = event.target.closest('.jar');
  if (jar) setLid(jar, false);
});
function groupProducts() {
  const groups = new Map();
  for (const item of products) {
    if (!groups.has(item.name)) groups.set(item.name, []);
    groups.get(item.name).push(item);
  }
  return [...groups.values()];
}
function availability(item) {
  if (item.stock === null) return 'Наличие уточняется';
  return item.stock ? 'В наличии · ' + item.stock + ' шт.' : 'Закончилась';
}
function selectedItem(items) {
  return items.find(item => item.id === selection.get(items[0].id)) ?? items[0];
}
function cardMarkup(items) {
  const product = selectedItem(items);
  const weights = items.map(item => `<button type="button" data-variant="${item.id}" aria-pressed="${item.id === product.id}">${escapeText(item.desc)}</button>`).join('');
  return `<article class="card" data-group="${items[0].id}">
    <div class="picture"></div>
    <div class="card-body">
      <h3>${escapeText(product.name)}</h3>
      <div class="weights" role="group" aria-label="Фасовка, ${escapeText(product.name)}">${weights}</div>
      <p class="availability"></p>
      <div class="buy-row"><strong class="price"></strong><button class="add" type="button">+</button></div>
    </div></article>`;
}
function updateCard(card, product) {
  card.querySelector('.picture').outerHTML = productPicture(product);
  card.querySelectorAll('[data-variant]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.variant === product.id));
  });
  card.querySelector('.availability').textContent = availability(product);
  card.querySelector('.price').textContent = money(product.price);
  const button = card.querySelector('.add');
  clearTimeout(timers.get(button));
  button.classList.remove('added');
  button.textContent = '+';
  button.dataset.add = product.id;
  button.disabled = (cart.get(product.id) ?? 0) >= stockLimit(product);
  button.setAttribute('aria-label', 'Добавить в корзину: ' + product.name + ', ' + product.desc);
}
function renderCatalog() {
  const groups = groupProducts();
  $('#products').innerHTML = groups.map(cardMarkup).join('') || '<p class="empty">Каталог пока пуст.</p>';
  document.querySelectorAll('.card').forEach((card, index) => updateCard(card, selectedItem(groups[index])));
}
function summary() {
  const lines = products.filter(item => cart.get(item.id) > 0);
  const count = lines.reduce((sum, item) => sum + cart.get(item.id), 0);
  const subtotal = lines.reduce((sum, item) => sum + item.price * cart.get(item.id), 0);
  const pickup = $('[name="method"]:checked').value === 'pickup';
  const fee = pickup || count === 0 || count >= 5 ? 0 : 250;
  const cash = $('[name="payment"]:checked').value === 'cash';
  return {lines, count, subtotal, pickup, cash, fee, total: subtotal + fee};
}
function renderCart() {
  const {lines, count, subtotal, pickup, cash, fee, total} = summary();
  $('#payment-note').textContent = cash
    ? (pickup ? 'Оплата наличными при получении заказа.' : 'Оплата наличными курьеру при получении. Желательно без сдачи.')
    : 'Реквизиты для перевода продавец пришлёт в Telegram после подтверждения заказа.';
  $('#name-label').textContent = cash ? 'Ваше имя' : 'Имя отправителя перевода';
  $('#name-hint').hidden = cash;
  $('#name').placeholder = cash ? 'Анна' : 'Анна С.';
  const dock = $('.dock');
  const newlyVisible = dock.hidden && count > 0;
  $('#badge').textContent = count;
  $('#bag-button').setAttribute('aria-label', 'Открыть корзину, банок: ' + count);
  $('#dock-count').textContent = count;
  $('#dock-total').textContent = money(subtotal);
  dock.hidden = count === 0;
  document.body.classList.toggle('has-cart', count > 0);
  if (newlyVisible) animate(dock.firstElementChild, [{transform:'translateY(16px)', opacity:0},{transform:'none', opacity:1}]);
  $('#checkout').hidden = count === 0;
  $('#cartItems').innerHTML = lines.map(item => `<div class="line-item">
    <div><strong>${escapeText(item.name)}</strong><small>${escapeText(item.desc)} · ${money(item.price)} за банку</small></div>
    <div class="qty">
      <button data-step="-1" data-id="${item.id}" aria-label="Убрать одну банку ${escapeText(item.name)}, ${escapeText(item.desc)}">−</button>
      <span>${cart.get(item.id)}</span>
      <button data-step="1" data-id="${item.id}" aria-label="Добавить одну банку ${escapeText(item.name)}, ${escapeText(item.desc)}" ${cart.get(item.id) >= stockLimit(item) ? 'disabled' : ''}>+</button>
    </div></div>`).join('') || '<p class="empty">Корзина пока пуста. Выберите фасовку в каталоге и нажмите «+».</p><button class="outline" data-close>К каталогу</button>';
  $('#shipping-note').textContent = pickup ? 'Место и время согласуем с продавцом.' : count >= 5
    ? 'В заказе от 5 банок — доставка бесплатная.' : 'Доставка 250 ₽. От 5 банок — бесплатно.';
  $('#address-block').hidden = pickup;
  if (!pickup) renderDeliverySlots();
  $('#contact-req').hidden = pickup;
  $('#method-label').textContent = pickup ? 'Самовывоз' : 'Доставка';
  $('#subtotal').textContent = money(subtotal);
  $('#fee').textContent = fee ? money(fee) : 'Бесплатно';
  $('#total').textContent = money(total);
}
function adjust(product, step) {
  const before = cart.get(product.id) ?? 0;
  const quantity = Math.max(0, Math.min(stockLimit(product), before + step));
  if (before === quantity) return;
  if (quantity) cart.set(product.id, quantity);
  else cart.delete(product.id);
  save('ikra-cart', Object.fromEntries(cart));
  renderCart();
  const add = document.querySelector(`[data-add="${product.id}"]`);
  if (add) {
    add.disabled = quantity >= stockLimit(product);
    if (step > 0) {
      add.classList.add('added');
      add.textContent = '✓';
      clearTimeout(timers.get(add));
      timers.set(add, setTimeout(() => {add.classList.remove('added'); add.textContent = '+';}, 700));
    }
  }
  animate($('#badge'), [{transform:'scale(.85)'},{transform:'scale(1.18)'},{transform:'scale(1)'}], 300);
  $('#status').textContent = product.name + ', ' + product.desc + '. В корзине ' + quantity + ' шт.';
}
$('#products')?.addEventListener('click', event => {
  const button = event.target.closest('button');
  const card = button?.closest('.card');
  if (!card) return;
  if (button.dataset.photoStep) {
    const gallery = button.closest('.gallery');
    const product = products.find(item => item.id === gallery.dataset.product);
    const photos = itemPhotos(product);
    const i = (Number(gallery.dataset.photoIndex) + Number(button.dataset.photoStep) + photos.length) % photos.length;
    gallery.dataset.photoIndex = i;
    const img = gallery.querySelector('img');
    img.src = photoUrl(photos[i]);
    img.alt = product.name + ', ' + product.desc + ' — фото ' + (i + 1);
    gallery.querySelector('[aria-live]').textContent = (i + 1) + ' / ' + photos.length;
    return;
  }
  if (button.classList.contains('jar')) {
    setLid(button, button.getAttribute('aria-pressed') !== 'true');
    return;
  }
  const item = products.find(item => item.id === (button.dataset.variant ?? button.dataset.add));
  if (!item) return;
  if (button.dataset.variant) {
    selection.set(card.dataset.group, item.id);
    updateCard(card, item);
    animate(card.querySelector('.price'), [{opacity:.4, transform:'translateY(3px)'},{opacity:1, transform:'none'}]);
  } else {
    adjust(item, 1);
  }
});
$('#cartItems')?.addEventListener('click', event => {
  const button = event.target.closest('[data-step]');
  if (!button) return;
  const {id, step} = button.dataset;
  const item = products.find(product => product.id === id);
  if (item) adjust(item, Number(step));
  const next = document.querySelector(`[data-step="${step}"][data-id="${id}"]:enabled`) ?? $('#cartItems button:enabled') ?? $('#basket .close');
  next.focus({preventScroll: true});
});
document.querySelectorAll('[name="method"], [name="payment"]').forEach(radio => radio.addEventListener('change', () => {
  renderCart();
  if (document.querySelector('#checkout [aria-invalid="true"]')) validateContacts();
}));

// ---- Контакты и адрес доставки (только Казань) ----
const contactFields = ['name', 'contact', 'street', 'house'];
const fieldValue = id => document.getElementById(id).value.trim();
function normalizeContact(raw) {
  const value = raw.trim();
  const tg = value.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
  if (/^[a-z][a-z0-9_]{4,31}$/i.test(tg) && !/^\+?\d/.test(value)) return '@' + tg;
  const digits = value.replace(/\D/g, '');
  if (/^[\d\s()+-]+$/.test(value) && digits.length === 11 && /^[78]/.test(digits)) {
    return '+7 ' + digits.slice(1, 4) + ' ' + digits.slice(4, 7) + '-' + digits.slice(7, 9) + '-' + digits.slice(9);
  }
  if (/^[\d\s()+-]+$/.test(value) && digits.length === 10 && digits[0] === '9') return normalizeContact('8' + digits);
  return null;
}
function setError(id, text, input) {
  $('#' + id).textContent = text;
  input?.setAttribute('aria-invalid', String(Boolean(text)));
}
function validateContacts(focus = false) {
  const {pickup} = summary();
  const contactInput = $('#contact');
  const raw = contactInput.value.trim();
  const contact = raw ? normalizeContact(raw) : null;
  let firstBad = null;
  const nameInput = $('#name');
  if (!nameInput.value.trim()) {
    setError('name-error', summary().cash ? 'Укажите ваше имя.' : 'Укажите имя, с которого придёт перевод.', nameInput);
    firstBad = nameInput;
  } else if (!/\p{L}/u.test(nameInput.value)) {
    setError('name-error', 'Имя должно содержать буквы, например «Анна С.».', nameInput);
    firstBad = nameInput;
  } else {
    setError('name-error', '', nameInput);
  }
  if (!raw && !pickup) {
    setError('contact-error', 'Укажите телефон или Telegram — курьер свяжется перед доставкой.', contactInput);
    firstBad ??= contactInput;
  } else if (raw && !contact) {
    setError('contact-error', 'Похоже на опечатку. Пример: +7 900 123-45-67 или @username.', contactInput);
    firstBad ??= contactInput;
  } else {
    setError('contact-error', '', contactInput);
    if (contact) contactInput.value = contact;
  }
  if (pickup) {
    setError('address-error', '', null);
    setError('time-error', '', null);
    ['street', 'house', 'delivery-day', 'delivery-time'].forEach(id => $('#' + id).removeAttribute('aria-invalid'));
  } else {
    const missing = ['street', 'house'].filter(id => !fieldValue(id));
    ['street', 'house'].forEach(id => $('#' + id).setAttribute('aria-invalid', String(missing.includes(id))));
    setError('address-error', missing.length ? 'Укажите улицу и номер дома в Казани.' : '', null);
    if (missing.length && !firstBad) firstBad = $('#' + missing[0]);
    renderDeliverySlots();
    const day = $('#delivery-day'), time = $('#delivery-time');
    const noDay = day.value === '', noTime = !time.value;
    day.setAttribute('aria-invalid', String(noDay));
    time.setAttribute('aria-invalid', String(!noDay && noTime));
    setError('time-error', noDay || noTime ? 'Выберите день и время, когда будете дома.' : '', null);
    if ((noDay || noTime) && !firstBad) firstBad = noDay ? day : time;
  }
  if (firstBad && focus) firstBad.focus();
  return !firstBad;
}
// ---- День и время доставки (время Казани, шаг 15 минут) ----
const deliveryHours = {from: 10, to: 21};   // первый и последний слот: 10:00 и 21:00
const leadMinutes = 60;                       // на сегодня — не раньше чем через час
const daysAhead = 7;
const pad = n => String(n).padStart(2, '0');
function kazanNow() {
  return new Date(Date.now() + (180 + new Date().getTimezoneOffset()) * 60000);
}
function slotsFor(dayOffset) {
  const now = kazanNow();
  const earliest = dayOffset === 0 ? now.getHours() * 60 + now.getMinutes() + leadMinutes : 0;
  const slots = [];
  for (let m = deliveryHours.from * 60; m <= deliveryHours.to * 60; m += 15) {
    if (m >= earliest) slots.push(pad(Math.floor(m / 60)) + ':' + pad(m % 60));
  }
  return slots;
}
const dayFormat = new Intl.DateTimeFormat('ru-RU', {day: 'numeric', month: 'long', weekday: 'short', timeZone: 'UTC'});
function dayLabel(offset) {
  const now = kazanNow();
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  const text = dayFormat.format(date);
  return offset === 0 ? 'Сегодня, ' + text : offset === 1 ? 'Завтра, ' + text : text;
}
function renderDeliverySlots() {
  const daySelect = $('#delivery-day');
  const timeSelect = $('#delivery-time');
  const prevDay = daySelect.value;
  const days = [];
  for (let i = 0; i < daysAhead; i++) if (slotsFor(i).length) days.push(i);
  daySelect.innerHTML = '<option value="">Выберите день</option>' +
    days.map(i => `<option value="${i}">${escapeText(dayLabel(i))}</option>`).join('');
  if (days.includes(Number(prevDay)) && prevDay !== '') daySelect.value = prevDay;
  const prevTime = timeSelect.value;
  const slots = daySelect.value === '' ? [] : slotsFor(Number(daySelect.value));
  timeSelect.innerHTML = '<option value="">' + (slots.length ? 'Выберите время' : 'Сначала день') + '</option>' +
    slots.map(t => `<option value="${t}">${t}</option>`).join('');
  timeSelect.disabled = !slots.length;
  if (slots.includes(prevTime)) timeSelect.value = prevTime;
}
for (const id of ['delivery-day', 'delivery-time']) {
  document.getElementById(id)?.addEventListener('change', () => {
    if (id === 'delivery-day') renderDeliverySlots();
    if (document.getElementById(id).getAttribute('aria-invalid') === 'true') validateContacts();
  });
}
function deliveryTimeText() {
  return dayLabel(Number($('#delivery-day').value)).toLowerCase() + ', около ' + $('#delivery-time').value;
}

function addressText() {
  return ['г. Казань', fieldValue('street'), 'д. ' + fieldValue('house')].join(', ') + ' (встреча у дома)';
}
// Покупателю не нужно вводить данные заново при следующем заказе.
const savedContacts = readSaved('ikra-contacts', {});
for (const id of contactFields) {
  const input = document.getElementById(id);
  if (!input) continue;
  if (typeof savedContacts?.[id] === 'string') input.value = savedContacts[id];
  input.addEventListener('input', () => {
    save('ikra-contacts', Object.fromEntries(contactFields.map(key => [key, fieldValue(key)])));
    if (input.getAttribute('aria-invalid') === 'true') validateContacts();
  });
}
// В мини-приложении Telegram подставляем @username (имя не подставляем: нужно имя из банка).
function prefillFromTelegram() {
  const user = window.Telegram?.WebApp?.initDataUnsafe?.user;
  if (!user || !$('#contact')) return;
  if (!$('#contact').value && user.username) $('#contact').value = '@' + user.username;
}
prefillFromTelegram();
window.addEventListener('load', prefillFromTelegram);

function orderText() {
  const {lines, pickup, cash, fee, total} = summary();
  const message = ['Здравствуйте! Хочу заказать икру.', ...lines.map(item =>
    `${item.name}, ${item.desc} × ${cart.get(item.id)} — ${money(item.price * cart.get(item.id))}`
  ), (pickup ? 'Самовывоз' : 'Доставка') + ' — ' + (fee ? money(fee) : 'бесплатно'), 'Итого: ' + money(total)];
  message.push('Оплата: ' + (cash ? 'наличными при получении' : 'переводом на номер продавца'));
  if (!pickup) message.push('Адрес: ' + addressText(), 'Время: ' + deliveryTimeText());
  for (const [id, label] of [['name', cash ? 'Имя' : 'Перевод от'], ['contact', 'Для связи'], ['details', 'Комментарий']]) {
    const value = fieldValue(id);
    if (value) message.push(label + ': ' + value);
  }
  return message.join('\n');
}
$('#send')?.addEventListener('click', async () => {
  $('#checkout-feedback').textContent = '';
  if (!validateContacts(true)) {
    $('#checkout-feedback').textContent = 'Заполните отмеченные поля.';
    return;
  }
  if (shared) {
    const before = orderText();
    $('#send').disabled = true;
    const ready = await refreshCatalog();
    $('#send').disabled = false;
    if (!ready) { $('#checkout-feedback').textContent = 'Не удалось проверить наличие. Повторите попытку.'; return; }
    if (before !== orderText()) { $('#checkout-feedback').textContent = 'Каталог обновился. Проверьте состав и сумму заказа.'; return; }
  }
  if (!summary().count) return;
  const url = 'https://t.me/MayyaSabi?text=' + encodeURIComponent(orderText());
  const app = window.Telegram?.WebApp;
  if (app?.initData && app.isVersionAtLeast?.('6.1')) app.openTelegramLink(url);
  else window.location.assign(url);
});

function renderInventory() {
  $('#inventoryList').innerHTML = products.map(item => `<div class="inventory-row" data-item="${item.id}">
    <h3>${escapeText(item.name)} · ${escapeText(item.desc)}</h3>
    <p class="caption">${money(item.price)} · Учётный остаток ${item.stock ?? 'не указан'}</p>
    <button type="button" data-action="photos" class="photo-upload"><svg aria-hidden="true"><use href="#camera"/></svg>${itemPhotos(item).length >= maxPhotos ? 'Изменить фото' : 'Добавить фото'}</button>
    <label class="stock-field">Фактически, шт.<input data-actual type="number" min="0" max="100000" step="1" value="${item.stock ?? ''}"></label>
    <div class="actions"><button data-action="count" class="outline">Сверить</button><button data-action="edit" class="quiet">Изменить</button><button data-action="delete" class="quiet">Удалить</button></div>
    <p data-feedback class="caption" role="status"></p>
  </div>`).join('');
}
function updateDisplay() {
  const next = new Map();
  products.forEach(item => {
    const quantity = Math.min(cart.get(item.id) ?? 0, stockLimit(item));
    if (quantity) next.set(item.id, quantity);
  });
  cart.clear();
  next.forEach((quantity, id) => cart.set(id, quantity));
  save('ikra-cart', Object.fromEntries(cart));
  if (ownerPage) { renderInventory(); return; }
  renderCatalog();
  renderCart();
}
async function refreshCatalog() {
  if (!shared || saving) return true;
  if (refreshInProgress) return refreshInProgress;
  refreshInProgress = (async () => {
    try {
      const response = await fetch('/api/catalog', {cache: 'no-store', signal: AbortSignal.timeout(9000)});
      if (!response.ok) throw Error('catalog');
      const data = await response.json();
      if (data.items !== null && (!Array.isArray(data.items) || !data.items.every(validProduct))) throw Error('items');
      canEdit = data.owner === true;
      if (ownerPage) {
        $('[data-open="inventory"]').hidden = !canEdit;
        $('#owner-login').hidden = canEdit;
        $('#owner-status').textContent = canEdit
          ? 'Вы вошли как владелец. Изменения цен, остатков и фото сразу увидят покупатели.'
          : 'Войдите с аккаунтом владельца, чтобы менять цены, остатки и фотографии.';
        $('#stock-help').textContent = 'Укажите фактическое количество банок. После сохранения остаток обновится в общем каталоге.';
        $('#import-items').hidden = !(canEdit && data.revision === 'initial' && JSON.stringify(previousCatalog) !== JSON.stringify(defaults));
      }
      if (revision !== data.revision) {
        revision = data.revision;
        products = data.items ?? structuredClone(defaults);
        lastSaved = structuredClone(products);
        updateDisplay();
      }
      $('#catalog-error').hidden = true;
      return true;
    } catch {
      $('#catalog-error').hidden = false;
      return false;
    } finally { refreshInProgress = null; }
  })();
  return refreshInProgress;
}
async function commitCatalog() {
  if (!shared) {
    if (!save('ikra-products-v3', products)) {
      products = structuredClone(lastSaved);
      updateDisplay();
      $('#inventory-feedback').textContent = 'Не удалось сохранить на этом устройстве. Попробуйте уменьшить число фотографий или освободить место.';
      return false;
    }
    lastSaved = structuredClone(products);
    updateDisplay();
    return true;
  }
  if (!canEdit || saving) return false;
  saving = true;
  $('#inventoryList').inert = true;
  $('#editForm').inert = true;
  $('#new-item').disabled = true;
  $('#import-items').disabled = true;
  try {
    const uploaded = new Map();
    for (const item of products) {
      if (!item.photos?.length) continue;
      const refs = [];
      for (const ref of item.photos) {
        if (photoId.test(ref)) { refs.push(ref); continue; }
        if (!localPhoto.test(ref)) throw Error('photo');
        if (!uploaded.has(ref)) {
          const bytes = Uint8Array.from(atob(ref.slice(ref.indexOf(',') + 1)), char => char.charCodeAt(0));
          const blob = new Blob([bytes], {type: 'image/jpeg'});
          const result = await fetch('/api/photos', {method: 'POST', body: blob, signal: AbortSignal.timeout(30000)});
          if (!result.ok) throw Error('photo');
          const {id} = await result.json();
          if (!photoId.test(id)) throw Error('photo');
          uploaded.set(ref, id);
        }
        refs.push(uploaded.get(ref));
      }
      item.photos = refs;
    }
    const response = await fetch('/api/catalog', {method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({revision, items: products}), signal: AbortSignal.timeout(12000)});
    if (!response.ok) throw Error(response.status === 409 ? 'conflict' : 'save');
    revision = (await response.json()).revision;
    lastSaved = structuredClone(products);
    $('#import-items').hidden = true;
    updateDisplay();
    return true;
  } catch (error) {
    products = structuredClone(lastSaved);
    updateDisplay();
    if (error.message === 'conflict') {
      saving = false;
      await refreshCatalog();
      $('#inventory-feedback').textContent = 'Каталог изменился на другом устройстве. Проверьте свежие остатки и повторите правку.';
    } else if (error.message === 'photo') {
      $('#inventory-feedback').textContent = 'Не удалось загрузить фото. Проверьте соединение и повторите сохранение.';
    } else {
      $('#inventory-feedback').textContent = 'Не удалось подтвердить сохранение. Проверьте соединение и откройте остатки снова.';
    }
    return false;
  } finally {
    saving = false;
    $('#inventoryList').inert = false;
    $('#editForm').inert = false;
    $('#new-item').disabled = false;
    $('#import-items').disabled = false;
  }
}
$('#retry')?.addEventListener('click', refreshCatalog);
$('#import-items')?.addEventListener('click', async () => {
  if (!canEdit || saving || revision !== 'initial') return;
  products = structuredClone(previousCatalog);
  if (await commitCatalog()) $('#inventory-feedback').textContent = 'Каталог перенесён.';
});
let photoDraft = [];
let editSession = 0;
let choosingPhotos = false;
let replacementIndex = null;

function renderPhotoEditor() {
  $('#photo-list').innerHTML = photoDraft.map((ref, i) => `<li>
    <img src="${photoUrl(ref)}" alt="Фото ${i + 1}">
    <div><strong>${i === 0 ? 'Обложка' : 'Фото ' + (i + 1)}</strong>
    <div class="photo-actions">
      ${i ? `<button type="button" data-cover="${i}">На обложку</button>` : ''}
      <button type="button" data-replace="${i}">Заменить</button>
      <button type="button" data-remove="${i}">Убрать</button>
    </div></div></li>`).join('');
  $('#add-photos').disabled = choosingPhotos || photoDraft.length >= maxPhotos;
  $('#photo-list').inert = choosingPhotos;
  $('#editForm [type="submit"]').disabled = choosingPhotos;
}

async function preparePhoto(file) {
  if (!file.size || file.size > 30 * 1024 * 1024) throw Error('Выберите изображение размером до 30 МБ.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { throw Error('Браузер не смог открыть снимок. Попробуйте JPEG, PNG или WebP.'); }
    const ratio = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fffaf3';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [.84, .68, .5]) {
      const jpeg = canvas.toDataURL('image/jpeg', quality);
      if (jpeg.startsWith('data:image/jpeg;base64,') && jpeg.length < 1398100) return jpeg;
    }
    throw Error('Не удалось уменьшить снимок. Выберите изображение меньшего размера.');
  } finally { URL.revokeObjectURL(url); }
}

function pickPhotos(index = null) {
  replacementIndex = index;
  const input = $('#photo-files');
  input.value = '';
  input.multiple = index === null;
  input.click();
}
$('#add-photos')?.addEventListener('click', () => pickPhotos());
$('#photo-list')?.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || choosingPhotos) return;
  const {replace, remove, cover} = button.dataset;
  if (replace !== undefined) return pickPhotos(Number(replace));
  if (remove !== undefined) photoDraft.splice(Number(remove), 1);
  if (cover !== undefined) photoDraft.unshift(...photoDraft.splice(Number(cover), 1));
  $('#photo-feedback').textContent = '';
  renderPhotoEditor();
});
$('#photo-files')?.addEventListener('change', async event => {
  const files = [...event.target.files];
  if (!files.length || choosingPhotos) return;
  const replace = replacementIndex;
  if (replace === null && files.length + photoDraft.length > maxPhotos) {
    $('#photo-feedback').textContent = 'Можно добавить ещё ' + (maxPhotos - photoDraft.length) + ' фото.';
    return;
  }
  const session = editSession;
  choosingPhotos = true;
  renderPhotoEditor();
  $('#photo-feedback').textContent = 'Подготавливаем фото…';
  try {
    const ready = [];
    for (const file of files) ready.push(await preparePhoto(file));
    if (session !== editSession) return;
    if (replace !== null) photoDraft[replace] = ready[0];
    else photoDraft.push(...ready);
    $('#photo-feedback').textContent = 'Фото готово к сохранению.';
  } catch (error) {
    if (session === editSession) $('#photo-feedback').textContent = error.message;
  } finally {
    if (session === editSession) { choosingPhotos = false; renderPhotoEditor(); }
  }
});
function startEdit(item, photosOnly = false) {
  editSession++;
  choosingPhotos = false;
  photoDraft = itemPhotos(item);
  $('#photo-feedback').textContent = '';
  $('#inventory-feedback').textContent = '';
  renderPhotoEditor();
  editingId = item?.id ?? null;
  $('#editForm').hidden = false;
  $('#editForm').classList.toggle('photos-only', photosOnly);
  $('#formTitle').textContent = item ? item.name + ' · ' + item.desc : 'Новая позиция';
  for (const [id, key] of [['productName','name'], ['productDesc','desc'], ['productPrice','price'], ['productStock','stock']]) {
    document.getElementById(id).value = item?.[key] ?? '';
  }
  $('#formTitle').focus();
}
function endEdit() {
  editSession++;
  choosingPhotos = false;
  photoDraft = [];
  editingId = null;
  $('#editForm').hidden = true;
}
$('#inventoryList')?.addEventListener('click', async event => {
  if (!canEdit || saving) return;
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const row = button.closest('[data-item]');
  const item = products.find(product => product.id === row.dataset.item);
  if (!item) return;
  const feedback = row.querySelector('[data-feedback]');
  if (button.dataset.action === 'photos') {
    startEdit(item, true);
    if (photoDraft.length < maxPhotos) pickPhotos();
    return;
  }
  if (button.dataset.action === 'edit') return startEdit(item);
  if (button.dataset.action === 'delete') {
    feedback.innerHTML = 'Убрать эту фасовку из каталога? <button class="outline" data-action="confirm">Да, удалить</button> <button class="quiet" data-action="cancel">Отмена</button>';
    return;
  }
  if (button.dataset.action === 'cancel') { feedback.textContent = ''; return; }
  if (button.dataset.action === 'confirm') {
    products = products.filter(product => product.id !== item.id);
    if (editingId === item.id) endEdit();
    if (!await commitCatalog()) return;
    $('#inventory-feedback').textContent = item.name + ', ' + item.desc + ' — позиция удалена.';
    return;
  }
  const input = row.querySelector('[data-actual]');
  if (!input.value.trim() || !input.checkValidity()) {
    feedback.textContent = 'Введите целое количество от 0 до 100 000.';
    input.focus();
    return;
  }
  const before = item.stock;
  item.stock = input.valueAsNumber;
  if (!await commitCatalog()) return;
  const difference = item.stock - before;
  const result = before === null ? 'Начальный остаток сохранён.' : difference === 0 ? 'Остаток совпадает.' :
    'Сверка сохранена. Разница ' + (difference > 0 ? '+' : '') + difference + ' шт.';
  document.querySelector(`[data-item="${item.id}"] [data-feedback]`).textContent = result;
});
$('#new-item')?.addEventListener('click', () => startEdit(null));
$('#cancel-edit')?.addEventListener('click', endEdit);
$('#editForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!canEdit || choosingPhotos || saving) return;
  const name = $('#productName').value.trim();
  const desc = $('#productDesc').value.trim();
  if (!name || !desc) { $('#inventory-feedback').textContent = 'Введите название и фасовку.'; return; }
  const item = {id: editingId ?? 'p' + crypto.randomUUID(), name, desc, price: $('#productPrice').valueAsNumber,
    stock: $('#productStock').value === '' ? null : $('#productStock').valueAsNumber, photos: [...photoDraft]};
  $('#inventory-feedback').textContent = 'Сохраняем позицию…';
  if (editingId && !products.some(existing => existing.id === editingId)) {
    endEdit();
    $('#inventory-feedback').textContent = 'Эту позицию уже удалили на другом устройстве.';
    return;
  }
  if (editingId) products = products.map(existing => existing.id === editingId ? item : existing);
  else products.push(item);
  if (!await commitCatalog()) return;
  endEdit();
  $('#inventory-feedback').textContent = item.name + ', ' + item.desc + ' — сохранено.';
});
document.addEventListener('click', async event => {
  const opener = event.target.closest('[data-open]');
  if (opener) {
    if (saving) return;
    const dialog = document.getElementById(opener.dataset.open);
    if (shared && !await refreshCatalog()) return;
    if (dialog.id === 'inventory') {
      if (!canEdit) return;
      renderInventory();
      $('#inventory-feedback').textContent = '';
      endEdit();
    }
    if (!dialog.open) dialog.showModal();
    return;
  }
  const closer = event.target.closest('[data-close]');
  if (saving && event.target.closest('#inventory')) return;
  if (closer) closer.closest('dialog').close();
  if (event.target.tagName === 'DIALOG') {
    const rect = event.target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
  }
});
$('#inventory')?.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
$('#inventory')?.addEventListener('close', endEdit);
async function startOwner() {
  if (shared) {
    if (!await refreshCatalog()) { $('#owner-status').textContent = 'Не удалось связаться с сайтом.'; return; }
  } else {
    canEdit = true;
    $('[data-open="inventory"]').hidden = false;
    $('#owner-status').textContent = 'Пробный режим без сервера: изменения сохраняются только в этом браузере.';
    updateDisplay();
  }
  if (canEdit) {
    renderInventory();
    endEdit();
    $('#inventory').showModal();
  }
}
// Владелец и поддержка открывают кабинет прямо из Telegram:
// ссылка t.me/Ikra_mayya_bot?startapp=owner или кнопка «Кабинет владельца» внизу витрины.
const staffUsernames = ['dasad_a', 'mayyasabi'];
function checkStaff() {
  const app = window.Telegram?.WebApp;
  const data = app?.initDataUnsafe;
  if (!data || ownerPage) return;
  if (data.start_param === 'owner') { location.replace(shared ? '/owner' : 'owner.html'); return; }
  const username = data.user?.username?.toLowerCase();
  const link = $('#staff-link');
  if (link && username && staffUsernames.includes(username)) link.hidden = false;
}
window.addEventListener('load', checkStaff);
async function start() {
  if (ownerPage) return startOwner();
  // Старые ссылки вида /#owner ведут в отдельный кабинет.
  if (location.hash === '#owner') { location.replace(shared ? '/owner' : 'owner.html'); return; }
  if (shared) {
    $('#products').innerHTML = '<p class="empty" role="status">Загружаем каталог…</p>';
    if (!await refreshCatalog()) { $('#products').textContent = ''; return; }
  } else {
    updateDisplay();
  }
  document.querySelectorAll('.card').forEach((card, index) =>
    animate(card, [{opacity:0, transform:'translateY(12px)'},{opacity:1, transform:'none'}], 450, 70 * index)
  );
}
start();
window.addEventListener('pageshow', event => { if (event.persisted && shared) refreshCatalog(); });

// iOS may resize only the visual viewport when the software keyboard opens.
if (window.visualViewport) {
  const viewport = window.visualViewport;
  const sizeSheet = () => {
    document.documentElement.style.setProperty('--visible-height', viewport.height + 'px');
    document.documentElement.style.setProperty('--visible-top', viewport.offsetTop + 'px');
  };
  viewport.addEventListener('resize', sizeSheet);
  viewport.addEventListener('scroll', sizeSheet);
  sizeSheet();
}
