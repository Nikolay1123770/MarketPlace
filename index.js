const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════
// КОНФИГУРАЦИЯ
// ═══════════════════════════════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN || '8035930401:AAH4bICwB8LVXApFEIaLmOlsYD9PyO5sylI';
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
const DOMAIN = process.env.DOMAIN || 'https://marketplacebot.bothost.ru';
const BOT_USERNAME = 'RegisterMarketPlace_bot';

// ═══════════════════════════════════════════════════════════
// НАСТРОЙКИ ЮMONEY
// ═══════════════════════════════════════════════════════════
const YOOMONEY_CONFIG = {
    // === Вариант 1: P2P кошелёк (для физлиц) ===
    wallet: process.env.YOOMONEY_WALLET || '4100118944797800',  // Номер вашего кошелька
    secret: process.env.YOOMONEY_SECRET || 'fL8QIMDHIeudGlqCPNR7eux/', // Из настроек кошелька
    
    // === Вариант 2: ЮKassa (для бизнеса) ===
    shopId: process.env.YOOKASSA_SHOP_ID || '',
    shopSecret: process.env.YOOKASSA_SECRET || '',
    
    // Какой метод использовать: 'wallet' или 'yookassa'
    method: process.env.PAYMENT_METHOD || 'wallet'
};

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Папка uploads
const UPLOADS = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });
app.use('/uploads', express.static(UPLOADS));

// ═══════════════════════════════════════════════════════════
// БАЗА ДАННЫХ (RAM)
// ═══════════════════════════════════════════════════════════
let users = [];
let products = [];
let transactions = [];
let favorites = [];
let pendingPayments = new Map(); // Ожидающие платежи

// Коды для регистрации
const registerCodes = new Map();
const pendingRegistrations = new Map();

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// ═══════════════════════════════════════════════════════════
// TELEGRAM API
// ═══════════════════════════════════════════════════════════
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendMessage(chatId, text, options = {}) {
    try {
        await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML',
                ...options
            })
        });
    } catch (e) {
        console.error('Telegram error:', e.message);
    }
}

async function answerCallback(callbackId, text = '', showAlert = false) {
    try {
        await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                callback_query_id: callbackId,
                text: text,
                show_alert: showAlert
            })
        });
    } catch (e) {
        console.error('Telegram error:', e.message);
    }
}

// ═══════════════════════════════════════════════════════════
// ЮMONEY - СОЗДАНИЕ ПЛАТЕЖА
// ═══════════════════════════════════════════════════════════

// Генерация уникального ID платежа
function generatePaymentId() {
    return 'PAY_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

// Создание ссылки на оплату (P2P кошелёк)
function createWalletPaymentUrl(amount, paymentId, userId) {
    const params = new URLSearchParams({
        receiver: YOOMONEY_CONFIG.wallet,
        'quickpay-form': 'shop',
        targets: `Пополнение баланса CodeVault`,
        paymentType: 'PC', // PC - кошелёк, AC - карта
        sum: amount,
        label: paymentId,
        successURL: `${DOMAIN}/payment/success?id=${paymentId}`
    });
    
    return `https://yoomoney.ru/quickpay/confirm.xml?${params.toString()}`;
}

// Создание платежа через ЮKassa
async function createYooKassaPayment(amount, paymentId, userId, userEmail = '') {
    const auth = Buffer.from(`${YOOMONEY_CONFIG.shopId}:${YOOMONEY_CONFIG.shopSecret}`).toString('base64');
    
    try {
        const response = await fetch('https://api.yookassa.ru/v3/payments', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`,
                'Idempotence-Key': paymentId
            },
            body: JSON.stringify({
                amount: {
                    value: amount.toFixed(2),
                    currency: 'RUB'
                },
                confirmation: {
                    type: 'redirect',
                    return_url: `${DOMAIN}/payment/success?id=${paymentId}`
                },
                capture: true,
                description: `Пополнение баланса CodeVault`,
                metadata: {
                    paymentId: paymentId,
                    userId: userId
                }
            })
        });
        
        const data = await response.json();
        return data;
    } catch (e) {
        console.error('YooKassa error:', e);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════
// API ПЛАТЕЖЕЙ
// ═══════════════════════════════════════════════════════════

// Создание платежа
app.post('/api/payment/create', async (req, res) => {
    const { username, amount } = req.body;
    
    const user = users.find(u => u.username === username);
    if (!user) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    const sum = Number(amount);
    if (!sum || sum < 10) {
        return res.status(400).json({ error: 'Минимальная сумма 10 ₽' });
    }
    if (sum > 100000) {
        return res.status(400).json({ error: 'Максимальная сумма 100 000 ₽' });
    }
    
    const paymentId = generatePaymentId();
    
    // Сохраняем платёж
    pendingPayments.set(paymentId, {
        id: paymentId,
        oderId: user.id,
        username: username,
        amount: sum,
        status: 'pending',
        createdAt: Date.now()
    });
    
    // Удаляем через 1 час если не оплачен
    setTimeout(() => {
        const payment = pendingPayments.get(paymentId);
        if (payment && payment.status === 'pending') {
            pendingPayments.delete(paymentId);
        }
    }, 60 * 60 * 1000);
    
    let paymentUrl;
    
    if (YOOMONEY_CONFIG.method === 'yookassa' && YOOMONEY_CONFIG.shopId) {
        // Через ЮKassa
        const payment = await createYooKassaPayment(sum, paymentId, user.id);
        if (payment && payment.confirmation) {
            paymentUrl = payment.confirmation.confirmation_url;
            pendingPayments.get(paymentId).yookassaId = payment.id;
        } else {
            return res.status(500).json({ error: 'Ошибка создания платежа' });
        }
    } else {
        // Через P2P кошелёк
        paymentUrl = createWalletPaymentUrl(sum, paymentId, user.id);
    }
    
    res.json({
        success: true,
        paymentId: paymentId,
        paymentUrl: paymentUrl,
        amount: sum
    });
});

// Проверка статуса платежа
app.get('/api/payment/status/:paymentId', (req, res) => {
    const payment = pendingPayments.get(req.params.paymentId);
    if (!payment) {
        return res.status(404).json({ error: 'Платёж не найден' });
    }
    res.json({ 
        status: payment.status,
        amount: payment.amount
    });
});

// Webhook от ЮMoney P2P (кошелёк)
app.post('/api/yoomoney/webhook', (req, res) => {
    console.log('💰 YooMoney webhook:', req.body);
    
    const {
        notification_type,
        operation_id,
        amount,
        currency,
        datetime,
        sender,
        codepro,
        label, // Наш paymentId
        sha1_hash
    } = req.body;
    
    // Проверяем подпись
    const checkString = [
        notification_type,
        operation_id,
        amount,
        currency,
        datetime,
        sender || '',
        codepro,
        YOOMONEY_CONFIG.secret,
        label
    ].join('&');
    
    const hash = crypto.createHash('sha1').update(checkString).digest('hex');
    
    if (hash !== sha1_hash) {
        console.log('❌ Invalid signature');
        return res.status(400).send('Invalid signature');
    }
    
    // Находим платёж
    const payment = pendingPayments.get(label);
    if (!payment) {
        console.log('❌ Payment not found:', label);
        return res.status(404).send('Payment not found');
    }
    
    // Проверяем сумму
    const receivedAmount = parseFloat(amount);
    if (receivedAmount < payment.amount) {
        console.log('❌ Amount mismatch:', receivedAmount, 'vs', payment.amount);
        // Можно начислить фактическую сумму или отклонить
    }
    
    // Начисляем баланс
    const user = users.find(u => u.username === payment.username);
    if (user) {
        user.balance += receivedAmount;
        
        // Записываем транзакцию
        transactions.push({
            id: Date.now().toString(),
            oderId: user.id,
            type: 'deposit',
            amount: receivedAmount,
            desc: '💳 Пополнение через ЮMoney',
            paymentId: label,
            date: new Date().toISOString()
        });
        
        payment.status = 'completed';
        
        console.log('✅ Payment completed:', label, receivedAmount, '₽');
        
        // Уведомляем в Telegram
        if (user.telegramId) {
            sendMessage(user.telegramId,
                `✅ <b>Баланс пополнен!</b>\n\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `💰 Сумма: <b>+${receivedAmount.toLocaleString()} ₽</b>\n` +
                `💳 Новый баланс: <b>${user.balance.toLocaleString()} ₽</b>\n\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `Спасибо за пополнение!`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🛒 Перейти к покупкам', url: DOMAIN }]
                        ]
                    }
                }
            );
        }
    }
    
    res.send('OK');
});

// Webhook от ЮKassa
app.post('/api/yookassa/webhook', async (req, res) => {
    console.log('💰 YooKassa webhook:', req.body);
    
    const { event, object } = req.body;
    
    if (event === 'payment.succeeded') {
        const paymentId = object.metadata?.paymentId;
        const amount = parseFloat(object.amount.value);
        
        const payment = pendingPayments.get(paymentId);
        if (payment && payment.status === 'pending') {
            const user = users.find(u => u.username === payment.username);
            if (user) {
                user.balance += amount;
                
                transactions.push({
                    id: Date.now().toString(),
                    oderId: user.id,
                    type: 'deposit',
                    amount: amount,
                    desc: '💳 Пополнение через ЮKassa',
                    paymentId: paymentId,
                    date: new Date().toISOString()
                });
                
                payment.status = 'completed';
                
                console.log('✅ YooKassa payment completed:', paymentId, amount, '₽');
                
                if (user.telegramId) {
                    sendMessage(user.telegramId,
                        `✅ <b>Баланс пополнен!</b>\n\n` +
                        `💰 Сумма: <b>+${amount.toLocaleString()} ₽</b>\n` +
                        `💳 Новый баланс: <b>${user.balance.toLocaleString()} ₽</b>`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🛒 Перейти к покупкам', url: DOMAIN }]
                                ]
                            }
                        }
                    );
                }
            }
        }
    }
    
    res.json({ status: 'ok' });
});

// Страница успешной оплаты
app.get('/payment/success', (req, res) => {
    const { id } = req.query;
    const payment = pendingPayments.get(id);
    
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Оплата - CodeVault</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#0a0a0f;color:#e8e8e8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#12121a;border:1px solid #252535;border-radius:16px;padding:40px;text-align:center;max-width:400px}
.icon{font-size:64px;margin-bottom:20px}
h1{font-size:24px;margin-bottom:8px}
p{color:#707080;margin-bottom:24px}
.amount{font-size:32px;font-weight:800;color:#22c55e;margin-bottom:24px}
.btn{display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:600}
.btn:hover{transform:translateY(-2px)}
.status{padding:8px 16px;border-radius:8px;font-size:14px;margin-bottom:16px;display:inline-block}
.status.pending{background:rgba(234,179,8,0.2);color:#eab308}
.status.completed{background:rgba(34,197,94,0.2);color:#22c55e}
</style>
</head>
<body>
<div class="card">
${payment ? `
    <div class="icon">${payment.status === 'completed' ? '✅' : '⏳'}</div>
    <div class="status ${payment.status}">${payment.status === 'completed' ? 'Оплачено' : 'Ожидание подтверждения'}</div>
    <h1>${payment.status === 'completed' ? 'Оплата успешна!' : 'Обработка платежа'}</h1>
    <p>${payment.status === 'completed' 
        ? 'Средства зачислены на ваш баланс' 
        : 'Платёж обрабатывается. Средства будут зачислены автоматически в течение нескольких минут.'}</p>
    <div class="amount">+${payment.amount.toLocaleString()} ₽</div>
` : `
    <div class="icon">❓</div>
    <h1>Платёж не найден</h1>
    <p>Возможно, он уже был обработан или истёк</p>
`}
    <a href="/" class="btn">Вернуться на сайт</a>
</div>
<script>
// Автообновление статуса
${payment && payment.status === 'pending' ? `
setInterval(async () => {
    try {
        const res = await fetch('/api/payment/status/${id}');
        const data = await res.json();
        if (data.status === 'completed') {
            location.reload();
        }
    } catch(e) {}
}, 3000);
` : ''}
</script>
</body>
</html>
    `);
});

// ═══════════════════════════════════════════════════════════
// TELEGRAM WEBHOOK
// ═══════════════════════════════════════════════════════════
app.post(WEBHOOK_PATH, async (req, res) => {
    const { message, callback_query } = req.body;
    
    if (callback_query) {
        const chatId = callback_query.message.chat.id;
        const messageId = callback_query.message.message_id;
        const data = callback_query.data;
        const from = callback_query.from;
        
        if (data === 'my_balance') {
            const user = users.find(u => u.telegramId === from.id);
            if (user) {
                await answerCallback(callback_query.id);
                await sendMessage(chatId, 
                    `💎 <b>Ваш профиль</b>\n\n` +
                    `👤 <b>${user.displayName}</b>\n` +
                    `━━━━━━━━━━━━━━━\n\n` +
                    `💰 Баланс: <b>${user.balance.toLocaleString()} ₽</b>\n` +
                    `📦 Моих товаров: <b>${user.myProducts.length}</b>\n` +
                    `🛒 Покупок: <b>${user.inventory.length}</b>\n` +
                    `💵 Заработано: <b>${(user.earned || 0).toLocaleString()} ₽</b>\n\n` +
                    `━━━━━━━━━━━━━━━`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '💳 Пополнить баланс', url: DOMAIN + '/#wallet' }],
                                [{ text: '🌐 Открыть сайт', url: DOMAIN }],
                                [{ text: '◀️ Назад', callback_data: 'main_menu' }]
                            ]
                        }
                    }
                );
            } else {
                await answerCallback(callback_query.id, '❌ Вы не зарегистрированы', true);
            }
        }
        
        else if (data === 'help') {
            await answerCallback(callback_query.id);
            await sendMessage(chatId,
                `📚 <b>Справка</b>\n\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `💳 <b>Пополнение:</b>\n` +
                `Пополняйте баланс через ЮMoney на сайте. Средства зачисляются автоматически.\n\n` +
                `🔐 <b>Регистрация:</b>\n` +
                `Зарегистрируйтесь на сайте и подтвердите через бота.\n\n` +
                `🛒 <b>Покупки:</b>\n` +
                `Выбирайте товары и оплачивайте с баланса.\n\n` +
                `━━━━━━━━━━━━━━━`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🌐 Перейти на сайт', url: DOMAIN }],
                            [{ text: '◀️ Назад', callback_data: 'main_menu' }]
                        ]
                    }
                }
            );
        }
        
        else if (data === 'main_menu') {
            await answerCallback(callback_query.id);
            const user = users.find(u => u.telegramId === from.id);
            await showMainMenu(chatId, from, user);
        }
        
        else if (data.startsWith('confirm_reg_')) {
            const regId = data.replace('confirm_reg_', '');
            const pending = pendingRegistrations.get(regId);
            
            if (pending) {
                const existingTg = users.find(u => u.telegramId === from.id);
                if (existingTg) {
                    await answerCallback(callback_query.id, '⚠️ Telegram уже привязан!', true);
                    return res.sendStatus(200);
                }
                
                const code = Math.random().toString(36).substring(2, 8).toUpperCase();
                
                registerCodes.set(code, {
                    regId: regId,
                    telegramId: from.id,
                    username: pending.username,
                    passwordHash: pending.passwordHash,
                    firstName: from.first_name,
                    createdAt: Date.now()
                });
                
                setTimeout(() => registerCodes.delete(code), 10 * 60 * 1000);
                
                await answerCallback(callback_query.id, '✅ Код создан!');
                
                await sendMessage(chatId,
                    `✅ <b>Код подтверждения</b>\n\n` +
                    `━━━━━━━━━━━━━━━\n\n` +
                    `👤 Аккаунт: <b>${pending.username}</b>\n\n` +
                    `🔐 Ваш код:\n\n` +
                    `<code>${code}</code>\n\n` +
                    `━━━━━━━━━━━━━━━\n\n` +
                    `📋 Скопируйте и вставьте на сайте\n` +
                    `⏱ Действует <b>10 минут</b>`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🌐 Открыть сайт', url: DOMAIN }]
                            ]
                        }
                    }
                );
            } else {
                await answerCallback(callback_query.id, '❌ Ссылка устарела', true);
            }
        }
        
        return res.sendStatus(200);
    }
    
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text;
    const from = message.from;

    if (text.startsWith('/start reg_')) {
        const regId = text.replace('/start reg_', '');
        const pending = pendingRegistrations.get(regId);
        
        if (pending) {
            const existingTg = users.find(u => u.telegramId === from.id);
            if (existingTg) {
                await sendMessage(chatId,
                    `⚠️ <b>Telegram уже привязан!</b>\n\n` +
                    `Этот Telegram используется для аккаунта <b>${existingTg.username}</b>`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🌐 Войти на сайте', url: DOMAIN }]
                            ]
                        }
                    }
                );
                return res.sendStatus(200);
            }
            
            await sendMessage(chatId,
                `📝 <b>Подтверждение регистрации</b>\n\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `Вы регистрируете аккаунт:\n` +
                `👤 Логин: <b>${pending.username}</b>\n\n` +
                `━━━━━━━━━━━━━━━`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ Получить код', callback_data: `confirm_reg_${regId}` }],
                            [{ text: '❌ Отмена', callback_data: 'main_menu' }]
                        ]
                    }
                }
            );
        } else {
            await sendMessage(chatId,
                `❌ <b>Ссылка устарела</b>\n\nНачните регистрацию заново.`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🌐 Перейти на сайт', url: DOMAIN }]
                        ]
                    }
                }
            );
        }
        return res.sendStatus(200);
    }

    if (text === '/start') {
        const user = users.find(u => u.telegramId === from.id);
        await showMainMenu(chatId, from, user);
    }
    else if (text === '/balance') {
        const user = users.find(u => u.telegramId === from.id);
        if (user) {
            await sendMessage(chatId,
                `💰 <b>Баланс:</b> ${user.balance.toLocaleString()} ₽`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💳 Пополнить', url: DOMAIN + '/#wallet' }]
                        ]
                    }
                }
            );
        } else {
            await sendMessage(chatId, `❌ Вы не зарегистрированы`);
        }
    }

    res.sendStatus(200);
});

async function showMainMenu(chatId, from, user) {
    if (user) {
        await sendMessage(chatId,
            `🎉 <b>Добро пожаловать, ${from.first_name}!</b>\n\n` +
            `━━━━━━━━━━━━━━━\n\n` +
            `🛒 <b>CodeVault Marketplace</b>\n\n` +
            `💰 Баланс: <b>${user.balance.toLocaleString()} ₽</b>\n` +
            `📦 Товаров: <b>${user.myProducts.length}</b>\n` +
            `🛒 Покупок: <b>${user.inventory.length}</b>`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🌐 Открыть маркетплейс', url: DOMAIN }],
                        [{ text: '💰 Мой баланс', callback_data: 'my_balance' }, { text: '❓ Помощь', callback_data: 'help' }]
                    ]
                }
            }
        );
    } else {
        await sendMessage(chatId,
            `👋 <b>Привет, ${from.first_name}!</b>\n\n` +
            `━━━━━━━━━━━━━━━\n\n` +
            `🛒 <b>CodeVault Marketplace</b>\n\n` +
            `Маркетплейс цифровых товаров:\n` +
            `• 🤖 Telegram-боты\n` +
            `• 🌐 Веб-приложения\n` +
            `• 📜 Скрипты\n` +
            `• 🔌 API\n\n` +
            `━━━━━━━━━━━━━━━`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🚀 Перейти на сайт', url: DOMAIN }],
                        [{ text: '❓ Помощь', callback_data: 'help' }]
                    ]
                }
            }
        );
    }
}

// ═══════════════════════════════════════════════════════════
// AUTH API
// ═══════════════════════════════════════════════════════════

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Введите логин и пароль' });
    }
    
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase().trim());
    
    if (!user) {
        return res.status(401).json({ error: 'Пользователь не найден' });
    }
    
    if (!user.passwordHash) {
        return res.status(401).json({ error: 'Установите пароль' });
    }
    
    if (user.passwordHash !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный пароль' });
    }
    
    const { passwordHash, ...safeUser } = user;
    res.json({ user: safeUser, token: user.id });
});

app.post('/api/auth/register/start', (req, res) => {
    const { username, password, confirmPassword } = req.body;
    
    if (!username || !password || !confirmPassword) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }
    
    if (username.length < 3) {
        return res.status(400).json({ error: 'Логин минимум 3 символа' });
    }
    
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Логин: только буквы, цифры и _' });
    }
    
    if (password.length < 4) {
        return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    }
    
    if (password !== confirmPassword) {
        return res.status(400).json({ error: 'Пароли не совпадают' });
    }
    
    const existing = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existing) {
        return res.status(400).json({ error: 'Логин занят' });
    }
    
    const regId = crypto.randomBytes(16).toString('hex');
    
    pendingRegistrations.set(regId, {
        username: username.trim(),
        passwordHash: hashPassword(password),
        createdAt: Date.now()
    });
    
    setTimeout(() => pendingRegistrations.delete(regId), 15 * 60 * 1000);
    
    const botLink = `https://t.me/${BOT_USERNAME}?start=reg_${regId}`;
    
    res.json({ success: true, regId, botLink });
});

app.post('/api/auth/register/confirm', (req, res) => {
    const { code } = req.body;
    
    if (!code) {
        return res.status(400).json({ error: 'Введите код' });
    }
    
    const regData = registerCodes.get(code.toUpperCase());
    
    if (!regData) {
        return res.status(401).json({ error: 'Неверный код' });
    }
    
    registerCodes.delete(code.toUpperCase());
    pendingRegistrations.delete(regData.regId);
    
    const existingUser = users.find(u => u.username.toLowerCase() === regData.username.toLowerCase());
    if (existingUser) {
        return res.status(400).json({ error: 'Логин занят' });
    }
    
    const existingTg = users.find(u => u.telegramId === regData.telegramId);
    if (existingTg) {
        return res.status(400).json({ error: 'Telegram уже привязан' });
    }
    
    const user = createUser(regData.username, regData.telegramId, regData.firstName, regData.passwordHash);
    
    sendMessage(regData.telegramId,
        `🎉 <b>Регистрация завершена!</b>\n\n` +
        `👤 Логин: <b>${user.username}</b>\n` +
        `💰 Баланс: <b>${user.balance.toLocaleString()} ₽</b>`,
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🛒 Открыть маркетплейс', url: DOMAIN }]
                ]
            }
        }
    );
    
    const { passwordHash, ...safeUser } = user;
    res.json({ user: safeUser, token: user.id });
});

function createUser(username, telegramId, displayName, passwordHash) {
    const user = {
        id: Date.now().toString(),
        telegramId: telegramId,
        username: username,
        passwordHash: passwordHash,
        displayName: displayName || username,
        bio: 'Новый участник',
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
        balance: 100, // Стартовый бонус уменьшен
        earned: 0,
        joined: new Date().toLocaleDateString('ru-RU'),
        inventory: [],
        myProducts: []
    };
    users.push(user);
    
    transactions.push({
        id: Date.now().toString(),
        oderId: user.id,
        type: 'bonus',
        amount: 100,
        desc: '🎁 Приветственный бонус',
        date: new Date().toISOString()
    });
    
    return user;
}

// ═══════════════════════════════════════════════════════════
// ОСТАЛЬНЫЕ API
// ═══════════════════════════════════════════════════════════

app.get('/api/user/:username', (req, res) => {
    const user = users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Not found' });

    const owned = user.inventory.map(id => products.find(p => p.id === id)).filter(Boolean);
    const sold = products.filter(p => p.sellerId === user.id);
    const tx = transactions.filter(t => t.oderId === user.id).reverse().slice(0, 30);
    const favs = favorites.filter(f => f.oderId === user.id).map(f => products.find(p => p.id === f.productId)).filter(Boolean);

    const { passwordHash, ...safeUser } = user;

    res.json({
        ...safeUser,
        ownedProducts: owned,
        soldProducts: sold,
        favorites: favs,
        transactions: tx,
        stats: {
            products: sold.length,
            sales: sold.reduce((s, p) => s + p.downloads, 0),
            earned: sold.reduce((s, p) => s + p.price * p.downloads, 0),
            purchases: owned.length
        }
    });
});

app.get('/api/products', (req, res) => {
    const { category, search, sort } = req.query;
    let result = [...products];

    if (category && category !== 'all') result = result.filter(p => p.category === category);
    if (search) {
        const s = search.toLowerCase();
        result = result.filter(p => p.title.toLowerCase().includes(s) || p.description.toLowerCase().includes(s));
    }
    
    if (sort === 'price-low') result.sort((a, b) => a.price - b.price);
    else if (sort === 'price-high') result.sort((a, b) => b.price - a.price);
    else if (sort === 'popular') result.sort((a, b) => b.downloads - a.downloads);
    else result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(result.map(p => ({
        id: p.id,
        title: p.title,
        description: p.description,
        price: p.price,
        category: p.category,
        seller: p.seller,
        sellerAvatar: p.sellerAvatar,
        downloads: p.downloads,
        preview: p.preview
    })));
});

app.post('/api/publish', upload.single('file'), (req, res) => {
    const { username, title, description, price, category } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(403).json({ error: 'Unauthorized' });

    const colors = { BOT: '6366f1', WEB: '22c55e', SCRIPT: 'f59e0b', API: 'ec4899' };
    
    const product = {
        id: Date.now().toString(),
        title: title,
        description: description,
        price: Number(price) || 0,
        category: category || 'OTHER',
        seller: user.username,
        sellerId: user.id,
        sellerTelegramId: user.telegramId,
        sellerAvatar: user.avatar,
        file: req.file ? req.file.filename : null,
        preview: `https://placehold.co/600x400/${colors[category] || '8b5cf6'}/fff?text=${encodeURIComponent(title.substring(0, 12))}&font=roboto`,
        downloads: 0,
        createdAt: new Date().toISOString()
    };
    
    products.push(product);
    user.myProducts.push(product.id);
    res.json({ success: true });
});

app.post('/api/buy', (req, res) => {
    const { username, productId } = req.body;
    const user = users.find(u => u.username === username);
    const product = products.find(p => p.id === productId);

    if (!user || !product) return res.status(404).json({ error: 'Not found' });
    if (user.balance < product.price) return res.status(400).json({ error: 'Недостаточно средств. Пополните баланс!' });
    if (user.inventory.includes(productId)) return res.status(400).json({ error: 'Уже куплено' });
    if (product.sellerId === user.id) return res.status(400).json({ error: 'Нельзя купить своё' });

    user.balance -= product.price;
    user.inventory.push(productId);
    product.downloads++;

    const seller = users.find(u => u.id === product.sellerId);
    if (seller) {
        seller.balance += product.price;
        seller.earned = (seller.earned || 0) + product.price;
        
        transactions.push({
            id: Date.now().toString(),
            oderId: seller.id,
            type: 'sale',
            amount: product.price,
            desc: `💰 Продажа: ${product.title}`,
            date: new Date().toISOString()
        });

        if (seller.telegramId) {
            sendMessage(seller.telegramId,
                `🎉 <b>Новая продажа!</b>\n\n` +
                `📦 <b>${product.title}</b>\n` +
                `👤 ${user.displayName}\n` +
                `💰 <b>+${product.price.toLocaleString()} ₽</b>\n\n` +
                `💳 Баланс: <b>${seller.balance.toLocaleString()} ₽</b>`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🌐 Открыть маркетплейс', url: DOMAIN }]
                        ]
                    }
                }
            );
        }
    }

    transactions.push({
        id: (Date.now() + 1).toString(),
        oderId: user.id,
        type: 'purchase',
        amount: -product.price,
        desc: `🛒 Покупка: ${product.title}`,
        date: new Date().toISOString()
    });

    res.json({ success: true, balance: user.balance });
});

app.post('/api/favorite', (req, res) => {
    const { username, productId } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const idx = favorites.findIndex(f => f.oderId === user.id && f.productId === productId);
    if (idx > -1) {
        favorites.splice(idx, 1);
        res.json({ favorited: false });
    } else {
        favorites.push({ oderId: user.id, productId: productId });
        res.json({ favorited: true });
    }
});

app.get('/api/favorites/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.json([]);
    res.json(favorites.filter(f => f.oderId === user.id).map(f => products.find(p => p.id === f.productId)).filter(Boolean));
});

app.get('/api/download/:productId', (req, res) => {
    const { username } = req.query;
    const user = users.find(u => u.username === username);
    const product = products.find(p => p.id === req.params.productId);

    if (!user || !product) return res.status(404).send('Not found');
    if (!user.inventory.includes(product.id) && user.id !== product.sellerId) {
        return res.status(403).send('Access denied');
    }
    if (!product.file) return res.status(404).send('No file');

    res.download(path.join(UPLOADS, product.file), product.title + path.extname(product.file));
});

app.post('/api/profile', (req, res) => {
    const { username, displayName, bio } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'Not found' });

    if (displayName) user.displayName = displayName;
    if (bio !== undefined) user.bio = bio;
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// HTML
// ═══════════════════════════════════════════════════════════
const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeVault — Маркетплейс</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0a0f;--card:#12121a;--card2:#1a1a25;--border:#252535;--text:#e8e8e8;--dim:#707080;--accent:#6366f1;--accent2:#818cf8;--green:#22c55e;--red:#ef4444;--yellow:#eab308}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.hidden{display:none!important}
button{cursor:pointer;font-family:inherit;border:none;transition:all .2s}
input,textarea,select{font-family:inherit;width:100%;background:var(--card2);border:1px solid var(--border);padding:14px 16px;color:#fff;border-radius:10px;margin-bottom:12px;font-size:14px;transition:all .2s}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(99,102,241,0.15)}
input::placeholder{color:var(--dim)}

.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--card);border:1px solid var(--accent);padding:14px 28px;border-radius:12px;opacity:0;transition:.3s;z-index:999;font-weight:500}
.toast.show{transform:translateX(-50%) translateY(0);opacity:1}

#auth{position:fixed;inset:0;background:linear-gradient(135deg,#0a0a0f 0%,#12121a 100%);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100}
.auth-container{width:100%;max-width:420px}
.auth-logo{text-align:center;margin-bottom:32px}
.auth-logo h1{font-size:2.5rem;font-weight:800;background:linear-gradient(135deg,var(--accent),#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}
.auth-logo p{color:var(--dim);font-size:14px}
.auth-box{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,0.3)}
.auth-tabs{display:flex;gap:8px;margin-bottom:24px;background:var(--bg);padding:4px;border-radius:10px}
.auth-tabs button{flex:1;padding:12px;background:transparent;color:var(--dim);border-radius:8px;font-size:14px;font-weight:600}
.auth-tabs button.active{background:var(--accent);color:#fff}
.auth-panel{display:none}
.auth-panel.active{display:block;animation:fadeIn .3s}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:13px;font-weight:500;color:var(--dim);margin-bottom:6px}
.form-group input{margin:0}
.btn{padding:14px 24px;border-radius:10px;font-weight:600;font-size:14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%}
.btn-primary{background:linear-gradient(135deg,var(--accent),#8b5cf6);color:#fff}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 10px 20px rgba(99,102,241,0.3)}
.btn-secondary{background:var(--card2);color:var(--text);border:1px solid var(--border)}
.btn-success{background:linear-gradient(135deg,var(--green),#16a34a);color:#fff}
.divider{display:flex;align-items:center;gap:16px;margin:20px 0;color:var(--dim);font-size:13px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
.reg-header{text-align:center;margin-bottom:24px}
.reg-header h2{font-size:18px;margin-bottom:4px}
.reg-header p{color:var(--dim);font-size:13px}
.steps-indicator{display:flex;justify-content:center;gap:8px;margin-bottom:24px}
.step-dot{width:10px;height:10px;border-radius:50%;background:var(--border);transition:all .3s}
.step-dot.active{background:var(--accent);transform:scale(1.2)}
.step-dot.done{background:var(--green)}
.info-card{background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:20px}
.info-card.highlight{border-color:var(--accent);background:rgba(99,102,241,0.1)}
.info-card.success{border-color:var(--green);background:rgba(34,197,94,0.1)}
.info-card h4{font-size:14px;margin-bottom:8px}
.info-card p{font-size:13px;color:var(--dim);line-height:1.5}
.code-input{text-align:center;font-size:24px;letter-spacing:8px;text-transform:uppercase;font-weight:700}
.back-link{color:var(--accent);font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;margin-top:16px}

.app{display:flex;flex-direction:column;min-height:100vh}
.header{background:var(--card);padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50}
.header-logo{font-size:1.25rem;font-weight:800;background:linear-gradient(135deg,var(--accent),#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header-user{display:flex;align-items:center;gap:12px}
.header-balance{background:var(--card2);padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;color:var(--green)}
.header-avatar{width:36px;height:36px;border-radius:50%;border:2px solid var(--accent)}

.content{flex:1;padding:16px;padding-bottom:90px}
.tab{display:none}
.tab.active{display:block;animation:fadeIn .3s}

.nav{display:flex;background:var(--card);border-top:1px solid var(--border);position:fixed;bottom:0;left:0;right:0;z-index:50;padding:8px 0}
.nav a{flex:1;padding:8px;text-align:center;color:var(--dim);text-decoration:none;font-size:11px;display:flex;flex-direction:column;align-items:center;gap:4px}
.nav a svg{width:24px;height:24px}
.nav a.active{color:var(--accent)}

.filters{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
.filters input{flex:1;min-width:150px;margin:0}
.filters select{width:auto;min-width:110px;margin:0}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:all .2s}
.card:hover{transform:translateY(-4px);border-color:var(--accent)}
.card-img{height:110px;background-size:cover;background-position:center;position:relative}
.card-cat{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.75);padding:4px 8px;border-radius:6px;font-size:10px;font-weight:600}
.card-fav{position:absolute;top:8px;right:8px;width:32px;height:32px;background:rgba(0,0,0,.6);border-radius:50%;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center}
.card-fav.active{color:var(--red);background:rgba(239,68,68,0.2)}
.card-body{padding:12px}
.card-body h3{font-size:14px;font-weight:600;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-body p{font-size:12px;color:var(--dim);margin-bottom:10px;height:32px;overflow:hidden}
.card-footer{display:flex;justify-content:space-between;align-items:center}
.price{font-size:15px;font-weight:700;color:var(--green)}
.card-footer .btn{padding:8px 14px;font-size:12px;width:auto}

.profile-card{background:var(--card);border:1px solid var(--border);padding:24px;border-radius:16px;text-align:center;margin-bottom:20px}
.profile-card img{width:90px;height:90px;border-radius:50%;border:4px solid var(--accent);margin-bottom:16px}
.profile-card h2{font-size:20px;margin-bottom:4px}
.profile-card p{color:var(--dim);font-size:13px;margin-bottom:20px}
.stats{display:flex;justify-content:center;gap:32px}
.stat{text-align:center}
.stat b{display:block;font-size:1.5rem;font-weight:800;color:var(--accent)}
.stat span{font-size:11px;color:var(--dim)}

.section{background:var(--card);border:1px solid var(--border);padding:20px;border-radius:14px;margin-bottom:16px}
.section h3{margin-bottom:16px;font-size:16px}
.mini-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.mini-card{background:var(--card2);padding:14px;border-radius:10px;border:1px solid var(--border)}
.mini-card h4{font-size:13px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* WALLET */
.wallet-card{background:linear-gradient(135deg,var(--accent),#a855f7);padding:28px;border-radius:16px;text-align:center;margin-bottom:20px;position:relative;overflow:hidden}
.wallet-card::before{content:'';position:absolute;top:-50%;right:-50%;width:100%;height:100%;background:radial-gradient(circle,rgba(255,255,255,0.1) 0%,transparent 70%)}
.wallet-card small{opacity:.85;font-size:13px}
.wallet-card .amount{font-size:3rem;font-weight:800;margin:8px 0}

.topup-section{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:20px}
.topup-section h3{margin-bottom:16px;display:flex;align-items:center;gap:8px}
.amount-buttons{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
.amount-btn{background:var(--card2);border:2px solid var(--border);padding:16px;border-radius:10px;font-size:16px;font-weight:700;color:var(--text);transition:all .2s}
.amount-btn:hover{border-color:var(--accent);color:var(--accent)}
.amount-btn.selected{border-color:var(--green);background:rgba(34,197,94,0.1);color:var(--green)}
.custom-amount{margin-top:12px}
.custom-amount input{margin:0;text-align:center;font-size:18px;font-weight:600}
.pay-button{margin-top:16px}
.pay-info{background:var(--card2);border-radius:10px;padding:12px;margin-top:16px;font-size:13px;color:var(--dim);text-align:center}
.pay-info b{color:var(--text)}

.tx-list{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.tx{display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);font-size:13px}
.tx:last-child{border:none}
.tx-info b{display:block;margin-bottom:2px}
.tx-info small{color:var(--dim)}
.tx-plus{color:var(--green);font-weight:700}
.tx-minus{color:var(--red);font-weight:700}

.upload-box{background:var(--card);border:1px solid var(--border);padding:24px;border-radius:16px}
.upload-box h2{margin-bottom:20px}
.row{display:flex;gap:10px}
.row>*{flex:1}
.file-area{border:2px dashed var(--border);padding:28px;text-align:center;border-radius:10px;color:var(--dim);margin-bottom:16px;cursor:pointer}
.file-area:hover{border-color:var(--accent);color:var(--accent)}

.empty-state{text-align:center;padding:40px;color:var(--dim)}
</style>
</head>
<body>

<div class="toast" id="toast"></div>

<div id="auth">
<div class="auth-container">
<div class="auth-logo">
<h1>🛒 CodeVault</h1>
<p>Маркетплейс цифровых товаров</p>
</div>
<div class="auth-box">
<div class="auth-tabs">
<button class="active" onclick="switchAuth('login', this)">Вход</button>
<button onclick="switchAuth('register', this)">Регистрация</button>
</div>

<div id="auth-login" class="auth-panel active">
<div class="form-group">
<label>Логин</label>
<input type="text" id="login-username" placeholder="Введите логин">
</div>
<div class="form-group">
<label>Пароль</label>
<input type="password" id="login-password" placeholder="Введите пароль">
</div>
<button class="btn btn-primary" onclick="loginPassword()">Войти</button>
<div class="divider">нет аккаунта?</div>
<button class="btn btn-secondary" onclick="switchToRegister()">Создать аккаунт</button>
</div>

<div id="auth-register" class="auth-panel">
<div id="reg-step1">
<div class="reg-header">
<h2>Создание аккаунта</h2>
<p>Шаг 1 из 3</p>
</div>
<div class="steps-indicator">
<div class="step-dot active"></div>
<div class="step-dot"></div>
<div class="step-dot"></div>
</div>
<div class="form-group">
<label>Логин</label>
<input type="text" id="reg-username" placeholder="Например: developer" maxlength="20">
</div>
<div class="form-group">
<label>Пароль</label>
<input type="password" id="reg-password" placeholder="Минимум 4 символа">
</div>
<div class="form-group">
<label>Повторите пароль</label>
<input type="password" id="reg-password2" placeholder="Повторите пароль">
</div>
<button class="btn btn-primary" onclick="startRegistration()">Продолжить →</button>
</div>

<div id="reg-step2" class="hidden">
<div class="reg-header">
<h2>Подтверждение</h2>
<p>Шаг 2 из 3</p>
</div>
<div class="steps-indicator">
<div class="step-dot done"></div>
<div class="step-dot active"></div>
<div class="step-dot"></div>
</div>
<div class="info-card highlight">
<h4>👤 Логин: <span id="reg-show-username"></span></h4>
<p>Перейдите в Telegram-бота для получения кода подтверждения</p>
</div>
<a id="reg-bot-link" href="#" target="_blank">
<button class="btn btn-success">🤖 Открыть Telegram</button>
</a>
<div class="divider">получили код?</div>
<button class="btn btn-secondary" onclick="showStep3()">Ввести код →</button>
<span class="back-link" onclick="backToStep1()">← Назад</span>
</div>

<div id="reg-step3" class="hidden">
<div class="reg-header">
<h2>Введите код</h2>
<p>Шаг 3 из 3</p>
</div>
<div class="steps-indicator">
<div class="step-dot done"></div>
<div class="step-dot done"></div>
<div class="step-dot active"></div>
</div>
<div class="info-card success">
<h4>✅ Почти готово!</h4>
<p>Введите код из Telegram</p>
</div>
<input type="text" id="reg-code" class="code-input" placeholder="XXXXXX" maxlength="6">
<button class="btn btn-primary" onclick="confirmRegistration()">Завершить</button>
<span class="back-link" onclick="showStep2()">← Назад</span>
</div>
</div>
</div>
</div>
</div>

<div id="app" class="app hidden">
<header class="header">
<div class="header-logo">CodeVault</div>
<div class="header-user">
<div class="header-balance" id="h-balance">0 ₽</div>
<img class="header-avatar" id="h-avatar" src="">
</div>
</header>

<div class="content">
<section id="tab-market" class="tab active">
<div class="filters">
<input type="text" id="f-search" placeholder="🔍 Поиск...">
<select id="f-cat">
<option value="all">Все</option>
<option value="BOT">🤖 Боты</option>
<option value="WEB">🌐 Веб</option>
<option value="SCRIPT">📜 Скрипты</option>
<option value="API">🔌 API</option>
</select>
<select id="f-sort">
<option value="newest">Новые</option>
<option value="popular">Популярные</option>
<option value="price-low">Дешевле</option>
</select>
</div>
<div id="grid" class="grid"></div>
</section>

<section id="tab-favs" class="tab">
<h2 style="margin-bottom:20px">❤️ Избранное</h2>
<div id="favs-grid" class="grid"></div>
</section>

<section id="tab-profile" class="tab">
<div class="profile-card">
<img id="p-avatar" src="">
<h2 id="p-name"></h2>
<p id="p-bio"></p>
<div class="stats">
<div class="stat"><b id="s-products">0</b><span>Товаров</span></div>
<div class="stat"><b id="s-sales">0</b><span>Продаж</span></div>
<div class="stat"><b id="s-earned">0</b><span>Заработано</span></div>
</div>
</div>
<div class="section">
<h3>✏️ Редактировать</h3>
<input type="text" id="e-name" placeholder="Имя">
<textarea id="e-bio" rows="2" placeholder="О себе"></textarea>
<button class="btn btn-primary" onclick="saveProfile()">Сохранить</button>
</div>
<div class="section">
<h3>📦 Мои покупки</h3>
<div id="owned" class="mini-grid"></div>
</div>
<div class="section">
<button class="btn btn-secondary" onclick="logout()">🚪 Выйти</button>
</div>
</section>

<section id="tab-wallet" class="tab">
<div class="wallet-card">
<small>💳 Баланс</small>
<div class="amount" id="w-bal">0 ₽</div>
</div>

<div class="topup-section">
<h3>💰 Пополнить баланс</h3>
<div class="amount-buttons">
<button class="amount-btn" onclick="selectAmount(100, this)">100 ₽</button>
<button class="amount-btn" onclick="selectAmount(250, this)">250 ₽</button>
<button class="amount-btn" onclick="selectAmount(500, this)">500 ₽</button>
<button class="amount-btn" onclick="selectAmount(1000, this)">1 000 ₽</button>
<button class="amount-btn" onclick="selectAmount(2500, this)">2 500 ₽</button>
<button class="amount-btn" onclick="selectAmount(5000, this)">5 000 ₽</button>
</div>
<div class="custom-amount">
<input type="number" id="custom-amount" placeholder="Или введите сумму" min="10" max="100000">
</div>
<button class="btn btn-success pay-button" onclick="createPayment()">💳 Перейти к оплате</button>
<div class="pay-info">
Оплата через <b>ЮMoney</b> • Минимум 10 ₽
</div>
</div>

<h3 style="margin-bottom:14px">📋 История</h3>
<div class="tx-list" id="tx"></div>
</section>

<section id="tab-upload" class="tab">
<div class="upload-box">
<h2>📤 Новый товар</h2>
<div class="form-group">
<label>Название</label>
<input type="text" id="u-title" placeholder="Telegram Bot...">
</div>
<div class="row">
<div class="form-group">
<label>Категория</label>
<select id="u-cat">
<option value="BOT">🤖 Бот</option>
<option value="WEB">🌐 Веб</option>
<option value="SCRIPT">📜 Скрипт</option>
<option value="API">🔌 API</option>
</select>
</div>
<div class="form-group">
<label>Цена (₽)</label>
<input type="number" id="u-price" placeholder="1000">
</div>
</div>
<div class="form-group">
<label>Описание</label>
<textarea id="u-desc" rows="3" placeholder="Описание..."></textarea>
</div>
<div class="file-area" onclick="document.getElementById('u-file').click()">📁 Выбрать файл</div>
<input type="file" id="u-file" hidden>
<button class="btn btn-primary" onclick="publish()">🚀 Опубликовать</button>
</div>
</section>
</div>

<nav class="nav">
<a href="#" class="active" data-tab="market"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>Маркет</a>
<a href="#" data-tab="favs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>Избранное</a>
<a href="#" data-tab="profile"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"/><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/></svg>Профиль</a>
<a href="#" data-tab="wallet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>Кошелёк</a>
<a href="#" data-tab="upload"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>Продать</a>
</nav>
</div>

<script>
let user = null;
let favIds = [];
let selectedAmount = 0;

const $ = id => document.getElementById(id);
const toast = m => { const t = $('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); };
const fmt = n => new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

function switchAuth(m, btn) {
    document.querySelectorAll('.auth-tabs button').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    $('auth-' + m).classList.add('active');
    if (m === 'register') showStep1();
}
function switchToRegister() { document.querySelectorAll('.auth-tabs button')[1].click(); }
function showStep1() { $('reg-step1').classList.remove('hidden'); $('reg-step2').classList.add('hidden'); $('reg-step3').classList.add('hidden'); }
function showStep2() { $('reg-step1').classList.add('hidden'); $('reg-step2').classList.remove('hidden'); $('reg-step3').classList.add('hidden'); }
function showStep3() { $('reg-step1').classList.add('hidden'); $('reg-step2').classList.add('hidden'); $('reg-step3').classList.remove('hidden'); $('reg-code').focus(); }
function backToStep1() { showStep1(); }

async function startRegistration() {
    const username = $('reg-username').value.trim();
    const password = $('reg-password').value;
    const password2 = $('reg-password2').value;
    if (!username) return toast('Введите логин');
    if (!password) return toast('Введите пароль');
    if (!password2) return toast('Подтвердите пароль');
    try {
        const res = await fetch('/api/auth/register/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, confirmPassword: password2 })
        });
        const data = await res.json();
        if (!res.ok) return toast(data.error);
        $('reg-show-username').textContent = username;
        $('reg-bot-link').href = data.botLink;
        showStep2();
    } catch (e) { toast('Ошибка сети'); }
}

async function confirmRegistration() {
    const code = $('reg-code').value.trim().toUpperCase();
    if (!code || code.length !== 6) return toast('Введите 6-значный код');
    try {
        const res = await fetch('/api/auth/register/confirm', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (!res.ok) return toast(data.error);
        user = data.user;
        localStorage.setItem('user', JSON.stringify(user));
        onLogin();
        toast('🎉 Добро пожаловать!');
    } catch (e) { toast('Ошибка сети'); }
}

async function loginPassword() {
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    if (!username || !password) return toast('Заполните поля');
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) return toast(data.error);
        user = data.user;
        localStorage.setItem('user', JSON.stringify(user));
        onLogin();
    } catch (e) { toast('Ошибка сети'); }
}

function onLogin() {
    $('auth').classList.add('hidden');
    $('app').classList.remove('hidden');
    updateUI();
    loadMarket();
    // Проверяем hash для перехода на вкладку
    if (location.hash === '#wallet') {
        document.querySelector('[data-tab="wallet"]').click();
    }
}

function logout() {
    if (!confirm('Выйти?')) return;
    user = null;
    localStorage.removeItem('user');
    location.reload();
}

(function() {
    const saved = localStorage.getItem('user');
    if (saved) { try { user = JSON.parse(saved); onLogin(); } catch (e) { localStorage.removeItem('user'); } }
})();

function updateUI() {
    $('h-avatar').src = user.avatar;
    $('h-balance').textContent = fmt(user.balance);
}

document.querySelectorAll('.nav a').forEach(a => {
    a.onclick = e => {
        e.preventDefault();
        document.querySelectorAll('.nav a').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        a.classList.add('active');
        $('tab-' + a.dataset.tab).classList.add('active');
        if (a.dataset.tab === 'market') loadMarket();
        if (a.dataset.tab === 'favs') loadFavs();
        if (a.dataset.tab === 'profile') loadProfile();
        if (a.dataset.tab === 'wallet') loadWallet();
    };
});

['f-search', 'f-cat', 'f-sort'].forEach(id => { $(id).addEventListener('input', loadMarket); $(id).addEventListener('change', loadMarket); });

async function loadMarket() {
    const params = new URLSearchParams();
    const search = $('f-search').value;
    const cat = $('f-cat').value;
    if (search) params.append('search', search);
    if (cat !== 'all') params.append('category', cat);
    params.append('sort', $('f-sort').value);

    const [prods, favs] = await Promise.all([
        fetch('/api/products?' + params).then(r => r.json()),
        fetch('/api/favorites/' + user.username).then(r => r.json())
    ]);
    favIds = favs.map(f => f.id);

    $('grid').innerHTML = prods.length === 0 
        ? '<div class="empty-state"><p>Товары не найдены</p></div>' 
        : prods.map(p => renderCard(p)).join('');
}

function renderCard(p) {
    const isFav = favIds.includes(p.id);
    const icons = { BOT: '🤖', WEB: '🌐', SCRIPT: '📜', API: '🔌' };
    return '<div class="card"><div class="card-img" style="background-image:url(' + p.preview + ')"><span class="card-cat">' + (icons[p.category] || '📦') + ' ' + p.category + '</span><button class="card-fav ' + (isFav ? 'active' : '') + '" onclick="event.stopPropagation();toggleFav(\\'' + p.id + '\\',this)">♥</button></div><div class="card-body"><h3>' + esc(p.title) + '</h3><p>' + esc(p.description || '') + '</p><div class="card-footer"><span class="price">' + fmt(p.price) + '</span><button class="btn btn-primary" onclick="buy(\\'' + p.id + '\\')">Купить</button></div></div></div>';
}

async function buy(id) {
    if (!confirm('Купить?')) return;
    const res = await fetch('/api/buy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user.username, productId: id }) });
    const d = await res.json();
    if (res.ok) { user.balance = d.balance; updateUI(); toast('✅ Куплено!'); loadMarket(); }
    else toast(d.error);
}

async function toggleFav(id, btn) {
    const res = await fetch('/api/favorite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user.username, productId: id }) });
    const d = await res.json();
    btn.classList.toggle('active', d.favorited);
}

async function loadFavs() {
    const favs = await fetch('/api/favorites/' + user.username).then(r => r.json());
    $('favs-grid').innerHTML = favs.length === 0 ? '<div class="empty-state"><p>Пусто</p></div>' : favs.map(p => renderCard(p)).join('');
}

async function loadProfile() {
    const data = await fetch('/api/user/' + user.username).then(r => r.json());
    user = { ...user, ...data };
    localStorage.setItem('user', JSON.stringify(user));
    updateUI();
    $('p-avatar').src = data.avatar;
    $('p-name').textContent = data.displayName;
    $('p-bio').textContent = data.bio;
    $('s-products').textContent = data.stats.products;
    $('s-sales').textContent = data.stats.sales;
    $('s-earned').textContent = fmt(data.stats.earned);
    $('e-name').value = data.displayName;
    $('e-bio').value = data.bio;
    $('owned').innerHTML = data.ownedProducts.length === 0 ? '<div class="empty-state"><p>Нет покупок</p></div>' : data.ownedProducts.map(p => '<div class="mini-card"><h4>' + esc(p.title) + '</h4><a href="/api/download/' + p.id + '?username=' + user.username + '" class="btn btn-primary">📥 Скачать</a></div>').join('');
}

async function saveProfile() {
    await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user.username, displayName: $('e-name').value, bio: $('e-bio').value }) });
    toast('✅ Сохранено!');
    loadProfile();
}

async function loadWallet() {
    const data = await fetch('/api/user/' + user.username).then(r => r.json());
    user.balance = data.balance;
    updateUI();
    $('w-bal').textContent = fmt(data.balance);
    $('tx').innerHTML = data.transactions.length === 0 ? '<div class="empty-state"><p>Нет операций</p></div>' : data.transactions.map(t => '<div class="tx"><div class="tx-info"><b>' + t.desc + '</b><small>' + new Date(t.date).toLocaleString('ru-RU') + '</small></div><span class="' + (t.amount > 0 ? 'tx-plus' : 'tx-minus') + '">' + (t.amount > 0 ? '+' : '') + fmt(t.amount) + '</span></div>').join('');
}

// ОПЛАТА
function selectAmount(amount, btn) {
    selectedAmount = amount;
    $('custom-amount').value = '';
    document.querySelectorAll('.amount-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

$('custom-amount').addEventListener('input', function() {
    selectedAmount = Number(this.value) || 0;
    document.querySelectorAll('.amount-btn').forEach(b => b.classList.remove('selected'));
});

async function createPayment() {
    const amount = selectedAmount || Number($('custom-amount').value);
    if (!amount || amount < 10) return toast('Минимум 10 ₽');
    if (amount > 100000) return toast('Максимум 100 000 ₽');
    
    try {
        const res = await fetch('/api/payment/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user.username, amount })
        });
        const data = await res.json();
        if (!res.ok) return toast(data.error);
        
        // Переходим на страницу оплаты
        window.open(data.paymentUrl, '_blank');
        toast('Переход к оплате...');
        
        // Проверяем статус каждые 5 сек
        const checkInterval = setInterval(async () => {
            try {
                const statusRes = await fetch('/api/payment/status/' + data.paymentId);
                const statusData = await statusRes.json();
                if (statusData.status === 'completed') {
                    clearInterval(checkInterval);
                    toast('✅ Оплата получена!');
                    loadWallet();
                }
            } catch(e) {}
        }, 5000);
        
        // Останавливаем проверку через 10 минут
        setTimeout(() => clearInterval(checkInterval), 10 * 60 * 1000);
        
    } catch (e) {
        toast('Ошибка');
    }
}

async function publish() {
    const title = $('u-title').value.trim();
    const price = $('u-price').value;
    const desc = $('u-desc').value.trim();
    if (!title || !price || !desc) return toast('Заполните все поля');
    const fd = new FormData();
    fd.append('username', user.username);
    fd.append('title', title);
    fd.append('price', price);
    fd.append('description', desc);
    fd.append('category', $('u-cat').value);
    const file = $('u-file').files[0];
    if (file) fd.append('file', file);
    const res = await fetch('/api/publish', { method: 'POST', body: fd });
    if (res.ok) { toast('🚀 Опубликовано!'); $('u-title').value = ''; $('u-price').value = ''; $('u-desc').value = ''; document.querySelector('[data-tab="market"]').click(); }
}
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));

app.listen(PORT, async () => {
    console.log('🚀 CodeVault started on port ' + PORT);
    try {
        const webhookUrl = DOMAIN + WEBHOOK_PATH;
        const res = await fetch(TELEGRAM_API + '/setWebhook?url=' + webhookUrl);
        const data = await res.json();
        console.log('📡 Webhook:', data.ok ? 'OK' : 'FAIL');
        console.log('💳 Payment method:', YOOMONEY_CONFIG.method);
    } catch (e) { console.log('⚠️ Webhook error:', e.message); }
});
