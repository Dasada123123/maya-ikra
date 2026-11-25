// Бот-сервер заказов «Майя» для Cloudflare Workers.
//
// Что делает:
//  • POST /order — принимает заказ из мини-приложения (проверяет подпись Telegram),
//    сохраняет его и присылает владельцу и поддержке с кнопками
//    «✅ Оплата получена» и «❌ Отменить заказ». Покупателю приходит подтверждение.
//  • POST /tg/<секрет> — вебхук Telegram: /start с кнопками магазина, поддержки и владельца,
//    нажатия кнопок заказов, команда /orders для админов.
//  • GET /setup — один раз подключает вебхук бота к этому серверу.
//
// Настройки (Settings → Variables):
//  • BOT_TOKEN  — секрет, токен бота из @BotFather (вводит владелец, в код не пишется);
//  • ORDERS     — привязка KV-хранилища;
//  • ADMINS     — необязательно, юзернеймы через запятую (по умолчанию dasad_a,mayyasabi);
//  • SHOP_URL   — необязательно, адрес магазина.

const DEFAULT_ADMINS = 'dasad_a,mayyasabi';
const DEFAULT_SHOP = 'https://dasada123123.github.io/maya-ikra/';
const SUPPORT = 'Dasad_a';
const OWNER = 'MayyaSabi';
const ALLOWED_ORIGIN = 'https://dasada123123.github.io';
const STATUS = {
  new: '🆕 Новый — ждёт оплаты',
  paid: '✅ Оплачен',
  done: '📦 Выполнен',
  cancelled: '❌ Отменён'
};

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const money = n => new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c]);
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

function admins(env) {
  return (env.ADMINS || DEFAULT_ADMINS).split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}
function cors(request) {
  const origin = request.headers.get('origin') || '';
  const allow = origin === ALLOWED_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : ALLOWED_ORIGIN;
  return {'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin'};
}
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json; charset=utf-8', ...headers}});
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key,
    {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
async function webhookSecret(env) {
  return hex(await hmac(env.BOT_TOKEN, 'maya-webhook')).slice(0, 32);
}

// Проверка initData из Telegram.WebApp (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function verifyInitData(initData, token, maxAgeSec = 86400) {
  if (!initData || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = await hmac('WebAppData', token);
  const expected = hex(await hmac(secret, check));
  if (expected !== hash) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  return res.json().catch(() => ({ok: false}));
}

// ---------- Заказы ----------
function validateOrder(o) {
  if (!o || !Array.isArray(o.lines) || !o.lines.length || o.lines.length > 30) return null;
  const lines = [];
  for (const l of o.lines) {
    const qty = Number(l.qty), price = Number(l.price);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 999) return null;
    if (!Number.isSafeInteger(price) || price < 0 || price > 10000000) return null;
    lines.push({name: clip(l.name, 80), desc: clip(l.desc, 100), qty, price});
  }
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const subtotal = lines.reduce((s, l) => s + l.qty * l.price, 0);
  const pickup = o.method === 'pickup';
  const fee = pickup || count >= 5 ? 0 : 250;           // те же правила, что в магазине
  const name = clip(o.name, 80), contact = clip(o.contact, 100);
  if (!name) return null;
  if (!pickup && (!contact || !clip(o.street, 120) || !clip(o.house, 20) || !clip(o.time, 80))) return null;
  return {
    lines, count, subtotal, fee, total: subtotal + fee, pickup,
    cash: o.payment === 'cash', name, contact,
    street: clip(o.street, 120), house: clip(o.house, 20), time: clip(o.time, 80), comment: clip(o.comment, 500)
  };
}
function orderText(order) {
  const o = order.data;
  const who = order.customer;
  const tgLink = who.username ? '@' + esc(who.username) : `<a href="tg://user?id=${who.id}">${esc(who.first_name || 'покупатель')}</a>`;
  const rows = [
    `<b>Заказ №${order.id}</b> · ${STATUS[order.status]}`,
    '',
    ...o.lines.map(l => `• ${esc(l.name)}, ${esc(l.desc)} × ${l.qty} — ${money(l.qty * l.price)}`),
    `${o.pickup ? 'Самовывоз' : 'Доставка'} — ${o.fee ? money(o.fee) : 'бесплатно'}`,
    `<b>Итого: ${money(o.total)}</b>`,
    `Оплата: ${o.cash ? 'наличными при получении' : 'переводом на номер продавца'}`,
    ''
  ];
  if (!o.pickup) rows.push(`Адрес: г. Казань, ${esc(o.street)}, д. ${esc(o.house)} (встреча у дома)`, `Время: ${esc(o.time)}`);
  rows.push(`${o.cash ? 'Имя' : 'Перевод от'}: ${esc(o.name)}`);
  if (o.contact) rows.push(`Для связи: ${esc(o.contact)}`);
  rows.push(`Telegram: ${tgLink}`);
  if (o.comment) rows.push(`Комментарий: ${esc(o.comment)}`);
  if (order.history?.length) {
    const last = order.history[order.history.length - 1];
    rows.push('', `<i>${esc(STATUS[last.status])} — @${esc(last.by)}</i>`);
  }
  return rows.join('\n');
}
function orderButtons(order) {
  const id = order.id;
  if (order.status === 'new') return {inline_keyboard: [
    [{text: order.data.cash ? '✅ Принят, оплата при получении' : '✅ Оплата получена', callback_data: `paid:${id}`}],
    [{text: '❌ Отменить заказ', callback_data: `cancel:${id}`}]
  ]};
  if (order.status === 'paid') return {inline_keyboard: [
    [{text: '📦 Выполнен', callback_data: `done:${id}`}, {text: '❌ Отменить', callback_data: `cancel:${id}`}]
  ]};
  return {inline_keyboard: []};
}
async function nextId(env) {
  const n = Number(await env.ORDERS.get('counter') || 0) + 1;
  await env.ORDERS.put('counter', String(n));
  // KV не атомарен: при редком одновременном заказе добавляем хвост, чтобы номера не совпали.
  if (await env.ORDERS.get('order:' + n)) return n + '-' + Math.random().toString(36).slice(2, 5);
  return String(n);
}
async function notifyAdmins(env, order) {
  const sent = [];
  for (const username of admins(env)) {
    const chatId = await env.ORDERS.get('admin:' + username);
    if (!chatId) continue;
    const r = await tg(env, 'sendMessage', {chat_id: Number(chatId), text: orderText(order), parse_mode: 'HTML',
      disable_web_page_preview: true, reply_markup: orderButtons(order)});
    if (r.ok) sent.push({chat_id: Number(chatId), message_id: r.result.message_id});
  }
  return sent;
}
async function refreshAdminMessages(env, order) {
  for (const m of order.adminMessages || []) {
    await tg(env, 'editMessageText', {chat_id: m.chat_id, message_id: m.message_id, text: orderText(order),
      parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: orderButtons(order)});
  }
}

async function handleOrder(request, env) {
  const headers = cors(request);
  const body = await request.json().catch(() => null);
  const user = await verifyInitData(body?.initData, env.BOT_TOKEN);
  if (!user?.id) return json({error: 'telegram'}, 401, headers);
  const data = validateOrder(body.order);
  if (!data) return json({error: 'order'}, 400, headers);
  const order = {id: await nextId(env), status: 'new', created: Date.now(), data,
    customer: {id: user.id, username: user.username || '', first_name: user.first_name || ''}, history: []};
  order.adminMessages = await notifyAdmins(env, order);
  await env.ORDERS.put('order:' + order.id, JSON.stringify(order), {expirationTtl: 60 * 60 * 24 * 180});
  const ids = JSON.parse(await env.ORDERS.get('open') || '[]');
  ids.push(order.id);
  await env.ORDERS.put('open', JSON.stringify(ids.slice(-200)));
  const payNote = data.cash
    ? 'Оплата наличными при получении.'
    : `Реквизиты для перевода пришлёт владелец @${OWNER}. Переводите от имени «${data.name}».`;
  const toCustomer = await tg(env, 'sendMessage', {chat_id: user.id, parse_mode: 'HTML',
    text: `Спасибо! <b>Заказ №${order.id}</b> принят на ${money(data.total)}.\n${esc(payNote)}\nЕсли что-то не так — напишите @${SUPPORT}.`});
  return json({ok: true, id: order.id, notified: order.adminMessages.length, customerNotified: !!toCustomer.ok}, 200, headers);
}

// ---------- Вебхук Telegram ----------
function startKeyboard(env) {
  return {inline_keyboard: [
    [{text: '🛒 Открыть магазин', web_app: {url: env.SHOP_URL || DEFAULT_SHOP}}],
    [{text: '💬 Поддержка', url: `https://t.me/${SUPPORT}`}, {text: '✍️ Написать владельцу', url: `https://t.me/${OWNER}`}]
  ]};
}
async function handleUpdate(update, env) {
  const msg = update.message;
  if (msg?.text && msg.chat?.type === 'private') {
    const username = (msg.from?.username || '').toLowerCase();
    const isAdmin = admins(env).includes(username);
    if (isAdmin) await env.ORDERS.put('admin:' + username, String(msg.chat.id));
    const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
    if (cmd === '/orders' && isAdmin) {
      const ids = JSON.parse(await env.ORDERS.get('open') || '[]');
      const open = [];
      for (const id of ids.slice(-50)) {
        const o = JSON.parse(await env.ORDERS.get('order:' + id) || 'null');
        if (o && (o.status === 'new' || o.status === 'paid')) open.push(o);
      }
      if (!open.length) return tg(env, 'sendMessage', {chat_id: msg.chat.id, text: 'Открытых заказов нет.'});
      for (const o of open.slice(-10)) {
        const r = await tg(env, 'sendMessage', {chat_id: msg.chat.id, text: orderText(o), parse_mode: 'HTML',
          disable_web_page_preview: true, reply_markup: orderButtons(o)});
        if (r.ok) { o.adminMessages = [...(o.adminMessages || []), {chat_id: msg.chat.id, message_id: r.result.message_id}];
          await env.ORDERS.put('order:' + o.id, JSON.stringify(o), {expirationTtl: 60 * 60 * 24 * 180}); }
      }
      return;
    }
    // /start и любой другой текст — приветствие с тремя кнопками. Старая клавиатура конструктора убирается.
    await tg(env, 'sendMessage', {chat_id: msg.chat.id, text: 'Убираю старое меню…', reply_markup: {remove_keyboard: true}})
      .then(r => r.ok && tg(env, 'deleteMessage', {chat_id: msg.chat.id, message_id: r.result.message_id}));
    const adminNote = isAdmin ? '\n\n🔑 Вы администратор: сюда будут приходить заказы. Список открытых — /orders.' : '';
    return tg(env, 'sendMessage', {chat_id: msg.chat.id, parse_mode: 'HTML',
      text: `Красная икра «Майя» — доставка по Казани и самовывоз.\nНажмите «Открыть магазин», чтобы выбрать икру.${adminNote}`,
      reply_markup: startKeyboard(env)});
  }
  const cb = update.callback_query;
  if (cb?.data) {
    const username = (cb.from?.username || '').toLowerCase();
    if (!admins(env).includes(username)) return tg(env, 'answerCallbackQuery', {callback_query_id: cb.id, text: 'Только для владельца и поддержки'});
    const [action, id] = cb.data.split(':');
    const order = JSON.parse(await env.ORDERS.get('order:' + id) || 'null');
    if (!order) return tg(env, 'answerCallbackQuery', {callback_query_id: cb.id, text: 'Заказ не найден'});
    const next = {paid: 'paid', done: 'done', cancel: 'cancelled'}[action];
    const allowed = {new: ['paid', 'cancelled'], paid: ['done', 'cancelled']}[order.status] || [];
    if (!next || !allowed.includes(next)) {
      await refreshAdminMessages(env, order);
      return tg(env, 'answerCallbackQuery', {callback_query_id: cb.id, text: 'Статус уже изменён: ' + STATUS[order.status]});
    }
    order.status = next;
    order.history.push({status: next, by: cb.from.username || String(cb.from.id), at: Date.now()});
    if (cb.message && !order.adminMessages.some(m => m.chat_id === cb.message.chat.id && m.message_id === cb.message.message_id)) {
      order.adminMessages.push({chat_id: cb.message.chat.id, message_id: cb.message.message_id});
    }
    await env.ORDERS.put('order:' + order.id, JSON.stringify(order), {expirationTtl: 60 * 60 * 24 * 180});
    await refreshAdminMessages(env, order);
    const customerText = {
      paid: order.data.cash
        ? `Заказ №${order.id} подтверждён. Оплата наличными при получении.`
        : `Оплата получена, заказ №${order.id} подтверждён. Спасибо!`,
      done: `Заказ №${order.id} выполнен. Приятного аппетита!`,
      cancelled: `Заказ №${order.id} отменён${order.data.cash ? '' : ': оплата не поступила'}. Если это ошибка — напишите @${OWNER}.`
    }[next];
    await tg(env, 'sendMessage', {chat_id: order.customer.id, text: customerText});
    return tg(env, 'answerCallbackQuery', {callback_query_id: cb.id, text: STATUS[next]});
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN || !env.ORDERS) return json({error: 'Не настроены BOT_TOKEN или ORDERS'}, 500);
    try {
      if (url.pathname === '/order') {
        if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors(request)});
        if (request.method !== 'POST') return json({error: 'method'}, 405, cors(request));
        return await handleOrder(request, env);
      }
      if (url.pathname.startsWith('/tg/') && request.method === 'POST') {
        const secret = await webhookSecret(env);
        if (url.pathname !== '/tg/' + secret || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
          return json({error: 'forbidden'}, 403);
        }
        await handleUpdate(await request.json(), env);
        return json({ok: true});
      }
      if (url.pathname === '/setup') {
        const secret = await webhookSecret(env);
        const r = await tg(env, 'setWebhook', {url: `${url.origin}/tg/${secret}`, secret_token: secret,
          allowed_updates: ['message', 'callback_query'], drop_pending_updates: true});
        const me = await tg(env, 'getMe', {});
        return json({webhook: r.ok ? 'подключён' : r.description, bot: me.result?.username || null,
          next: 'Владелец и поддержка: откройте бота и нажмите /start, чтобы получать заказы.'});
      }
      if (url.pathname === '/') return json({ok: true, service: 'Майя · заказы'});
      return json({error: 'not found'}, 404);
    } catch (e) {
      return json({error: 'server'}, 500, url.pathname === '/order' ? cors(request) : {});
    }
  }
};
