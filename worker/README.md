# Бот-сервер заказов (Cloudflare Worker)

`worker.js` принимает заказы из мини-приложения и рассылает их администраторам (@Dasad_a, @MayyaSabi) с кнопками «✅ Оплата получена», «📦 Выполнен» и «❌ Отменить заказ». Покупатель получает подтверждение и уведомления о статусе. На `/start` бот отвечает тремя кнопками: «Открыть магазин», «Поддержка», «Написать владельцу». Команда `/orders` у администратора показывает открытые заказы.

## Установка
1. Cloudflare → Workers & Pages → KV → создать хранилище `maya-orders`.
2. Создать Worker `maya-orders`, вставить `worker.js`, нажать Deploy.
3. Worker → Settings → Bindings → KV namespace: имя переменной `ORDERS`, хранилище `maya-orders`.
4. Worker → Settings → Variables and Secrets → Secret `BOT_TOKEN` = токен бота из @BotFather.
5. Открыть `https://<worker>.workers.dev/setup` — вебхук подключится.
6. @Dasad_a и @MayyaSabi открывают бота и нажимают /start: без этого бот не может им писать.
7. В `shop.js` записать адрес Worker в `ORDER_API`.
