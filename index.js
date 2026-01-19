const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════
// КОНФИГУРАЦИЯ
// ═══════════════════════════════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN || '8035930401:AAH4bICwB8LVXApFEIaLmOlsYD9PyO5sylI';
const PORT = process.env.PORT || 3001;
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
const DOMAIN = 'https://marketplacebot.bothost.ru';
const BOT_USERNAME = 'RegisterMarketPlace_bot';

// ═══════════════════════════════════════════════════════════
// ЮMONEY - ЗАМЕНИТЕ НА СВОИ ДАННЫЕ!
// ═══════════════════════════════════════════════════════════
const YOOMONEY_WALLET = process.env.YOOMONEY_WALLET || '4100118944797800';
const YOOMONEY_SECRET = process.env.YOOMONEY_SECRET || 'fL8QIMDHIeudGlqCPNR7eux/';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const UPLOADS = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });
app.use('/uploads', express.static(UPLOADS));

// ═══════════════════════════════════════════════════════════
// БАЗА ДАННЫХ С СОХРАНЕНИЕМ В ФАЙЛ
// ═══════════════════════════════════════════════════════════
const DB_FILE = path.join(__dirname, 'database.json');

let db = {
    users: [],
    products: [],
    transactions: [],
    favorites: []
};

// Загрузка базы при старте
function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            db = JSON.parse(data);
            console.log(`📂 Database loaded: ${db.users.length} users, ${db.products.length} products`);
        }
    } catch (e) {
        console.log('⚠️ Could not load database:', e.message);
    }
}

// Сохранение базы
function saveDB() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
        console.log('⚠️ Could not save database:', e.message);
    }
}

// Автосохранение каждые 30 секунд
setInterval(saveDB, 30000);

// Загружаем при старте
loadDB();

let pendingPayments = new Map();
const registerCodes = new Map();
const pendingRegistrations = new Map();

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function generatePaymentId() {
    return 'PAY_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
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
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...options })
        });
    } catch (e) {
        console.error('TG error:', e.message);
    }
}

async function answerCallback(callbackId, text = '', showAlert = false) {
    try {
        await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: showAlert })
        });
    } catch (e) {}
}

// ═══════════════════════════════════════════════════════════
// ЮMONEY ПЛАТЕЖИ
// ═══════════════════════════════════════════════════════════

function createPaymentUrl(amount, paymentId) {
    const params = new URLSearchParams({
        receiver: YOOMONEY_WALLET,
        'quickpay-form': 'shop',
        targets: 'Пополнение CodeVault',
        paymentType: 'PC',
        sum: amount,
        label: paymentId,
        successURL: `${DOMAIN}/payment/success?id=${paymentId}`
    });
    return `https://yoomoney.ru/quickpay/confirm.xml?${params.toString()}`;
}

app.post('/api/payment/create', (req, res) => {
    const { username, amount } = req.body;
    
    console.log(`💳 Payment request: username=${username}, amount=${amount}`);
    
    if (!username) {
        return res.status(400).json({ error: 'Не указан пользователь' });
    }
    
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    
    if (!user) {
        console.log(`❌ User not found: ${username}`);
        console.log(`   Available users: ${db.users.map(u => u.username).join(', ') || 'none'}`);
        return res.status(404).json({ error: 'Сессия истекла. Войдите заново.' });
    }
    
    const sum = Number(amount);
    if (!sum || sum < 10) return res.status(400).json({ error: 'Минимум 10 ₽' });
    if (sum > 100000) return res.status(400).json({ error: 'Максимум 100 000 ₽' });
    
    const paymentId = generatePaymentId();
    
    pendingPayments.set(paymentId, {
        id: paymentId,
        oderId: user.id,
        username: username,
        amount: sum,
        status: 'pending',
        createdAt: Date.now()
    });
    
    setTimeout(() => {
        const p = pendingPayments.get(paymentId);
        if (p && p.status === 'pending') pendingPayments.delete(paymentId);
    }, 60 * 60 * 1000);
    
    const paymentUrl = createPaymentUrl(sum, paymentId);
    
    console.log(`✅ Payment created: ${paymentId}, ${sum}₽ for ${username}`);
    
    res.json({ success: true, paymentId, paymentUrl, amount: sum });
});

app.get('/api/payment/status/:paymentId', (req, res) => {
    const payment = pendingPayments.get(req.params.paymentId);
    if (!payment) return res.status(404).json({ error: 'Не найден' });
    res.json({ status: payment.status, amount: payment.amount });
});

// Webhook от ЮMoney
app.post('/api/yoomoney/webhook', (req, res) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💰 YooMoney webhook received');
    
    const { notification_type, operation_id, amount, currency, datetime, sender, codepro, label, sha1_hash, test_notification } = req.body;
    
    if (test_notification === 'true') {
        console.log('✅ Тестовое уведомление - OK');
        return res.send('OK');
    }
    
    if (!label) {
        console.log('⚠️ Пустой label');
        return res.send('OK');
    }
    
    const payment = pendingPayments.get(label);
    if (!payment) {
        console.log('❌ Payment not found:', label);
        return res.status(404).send('Not found');
    }
    
    if (payment.status === 'completed') {
        return res.send('OK');
    }
    
    const receivedAmount = parseFloat(amount);
    
    const user = db.users.find(u => u.username === payment.username);
    if (user) {
        user.balance += receivedAmount;
        
        db.transactions.push({
            id: Date.now().toString(),
            oderId: user.id,
            type: 'deposit',
            amount: receivedAmount,
            desc: '💳 Пополнение ЮMoney',
            paymentId: label,
            date: new Date().toISOString()
        });
        
        payment.status = 'completed';
        saveDB();
        
        console.log(`✅ +${receivedAmount}₽ для ${user.username}. Баланс: ${user.balance}₽`);
        
        if (user.telegramId) {
            sendMessage(user.telegramId,
                `✅ <b>Баланс пополнен!</b>\n\n💰 +${receivedAmount.toLocaleString()} ₽\n💳 Баланс: ${user.balance.toLocaleString()} ₽`,
                { reply_markup: { inline_keyboard: [[{ text: '🛒 К покупкам', url: DOMAIN }]] } }
            );
        }
    }
    
    res.send('OK');
});

app.get('/payment/success', (req, res) => {
    const { id } = req.query;
    const payment = pendingPayments.get(id);
    
    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Оплата - CodeVault</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#0a0a0f;color:#e8e8e8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#12121a;border:1px solid #252535;border-radius:16px;padding:40px;text-align:center;max-width:400px;width:100%}
.icon{font-size:64px;margin-bottom:20px}
h1{font-size:24px;margin-bottom:8px}
p{color:#707080;margin-bottom:24px}
.amount{font-size:32px;font-weight:800;color:#22c55e;margin-bottom:24px}
.btn{display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:600}
.status{padding:8px 16px;border-radius:8px;font-size:14px;margin-bottom:16px;display:inline-block}
.status.pending{background:rgba(234,179,8,0.2);color:#eab308}
.status.completed{background:rgba(34,197,94,0.2);color:#22c55e}
.loader{width:40px;height:40px;border:3px solid #252535;border-top-color:#6366f1;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="card">
${payment ? `
    ${payment.status === 'pending' ? '<div class="loader"></div>' : ''}
    <div class="icon">${payment.status === 'completed' ? '✅' : '⏳'}</div>
    <div class="status ${payment.status}">${payment.status === 'completed' ? 'Оплачено!' : 'Ожидание...'}</div>
    <h1>${payment.status === 'completed' ? 'Успешно!' : 'Обработка...'}</h1>
    <p>${payment.status === 'completed' ? 'Средства зачислены' : 'Ожидаем подтверждение'}</p>
    <div class="amount">+${payment.amount.toLocaleString()} ₽</div>
` : `
    <div class="icon">❓</div>
    <h1>Не найден</h1>
    <p>Платёж не найден или истёк</p>
`}
    <a href="/" class="btn">На сайт</a>
</div>
<script>
${payment && payment.status === 'pending' ? `
setInterval(async () => {
    try {
        const r = await fetch('/api/payment/status/${id}');
        const d = await r.json();
        if (d.status === 'completed') location.reload();
    } catch(e) {}
}, 3000);
` : ''}
</script>
</body>
</html>`);
});

// ═══════════════════════════════════════════════════════════
// TELEGRAM WEBHOOK
// ═══════════════════════════════════════════════════════════
app.post(WEBHOOK_PATH, async (req, res) => {
    const { message, callback_query } = req.body;
    
    if (callback_query) {
        const chatId = callback_query.message.chat.id;
        const data = callback_query.data;
        const from = callback_query.from;
        
        if (data === 'my_balance') {
            const user = db.users.find(u => u.telegramId === from.id);
            if (user) {
                await answerCallback(callback_query.id);
                await sendMessage(chatId, 
                    `💎 <b>${user.displayName}</b>\n\n💰 Баланс: <b>${user.balance.toLocaleString()} ₽</b>\n📦 Товаров: <b>${user.myProducts.length}</b>\n🛒 Покупок: <b>${user.inventory.length}</b>`,
                    { reply_markup: { inline_keyboard: [[{ text: '💳 Пополнить', url: DOMAIN }], [{ text: '◀️ Назад', callback_data: 'main_menu' }]] } }
                );
            } else {
                await answerCallback(callback_query.id, '❌ Не зарегистрированы', true);
            }
        }
        else if (data === 'help') {
            await answerCallback(callback_query.id);
            await sendMessage(chatId, `📚 <b>Справка</b>\n\n💳 Пополнение через ЮMoney\n🔐 Регистрация на сайте\n🛒 Покупки с баланса`,
                { reply_markup: { inline_keyboard: [[{ text: '🌐 На сайт', url: DOMAIN }], [{ text: '◀️ Назад', callback_data: 'main_menu' }]] } }
            );
        }
        else if (data === 'main_menu') {
            await answerCallback(callback_query.id);
            const user = db.users.find(u => u.telegramId === from.id);
            await showMainMenu(chatId, from, user);
        }
        else if (data.startsWith('confirm_reg_')) {
            const regId = data.replace('confirm_reg_', '');
            const pending = pendingRegistrations.get(regId);
            
            if (pending) {
                if (db.users.find(u => u.telegramId === from.id)) {
                    await answerCallback(callback_query.id, '⚠️ TG уже привязан!', true);
                    return res.sendStatus(200);
                }
                
                const code = Math.random().toString(36).substring(2, 8).toUpperCase();
                registerCodes.set(code, { regId, telegramId: from.id, username: pending.username, passwordHash: pending.passwordHash, firstName: from.first_name, createdAt: Date.now() });
                setTimeout(() => registerCodes.delete(code), 10 * 60 * 1000);
                
                await answerCallback(callback_query.id, '✅ Код создан!');
                await sendMessage(chatId, `✅ <b>Код подтверждения</b>\n\n👤 <b>${pending.username}</b>\n\n🔐 Код:\n\n<code>${code}</code>\n\n⏱ 10 минут`,
                    { reply_markup: { inline_keyboard: [[{ text: '🌐 На сайт', url: DOMAIN }]] } }
                );
            } else {
                await answerCallback(callback_query.id, '❌ Устарело', true);
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
            if (db.users.find(u => u.telegramId === from.id)) {
                await sendMessage(chatId, `⚠️ <b>TG уже привязан!</b>`, { reply_markup: { inline_keyboard: [[{ text: '🌐 Войти', url: DOMAIN }]] } });
                return res.sendStatus(200);
            }
            
            await sendMessage(chatId, `📝 <b>Регистрация</b>\n\n👤 <b>${pending.username}</b>\n\nНажмите для получения кода:`,
                { reply_markup: { inline_keyboard: [[{ text: '✅ Получить код', callback_data: `confirm_reg_${regId}` }], [{ text: '❌ Отмена', callback_data: 'main_menu' }]] } }
            );
        } else {
            await sendMessage(chatId, `❌ <b>Ссылка устарела</b>`, { reply_markup: { inline_keyboard: [[{ text: '🌐 На сайт', url: DOMAIN }]] } });
        }
        return res.sendStatus(200);
    }

    if (text === '/start') {
        const user = db.users.find(u => u.telegramId === from.id);
        await showMainMenu(chatId, from, user);
    }
    else if (text === '/balance') {
        const user = db.users.find(u => u.telegramId === from.id);
        if (user) {
            await sendMessage(chatId, `💰 <b>Баланс:</b> ${user.balance.toLocaleString()} ₽`, { reply_markup: { inline_keyboard: [[{ text: '💳 Пополнить', url: DOMAIN }]] } });
        } else {
            await sendMessage(chatId, `❌ Не зарегистрированы`);
        }
    }

    res.sendStatus(200);
});

async function showMainMenu(chatId, from, user) {
    if (user) {
        await sendMessage(chatId, `🎉 <b>Привет, ${from.first_name}!</b>\n\n🛒 <b>CodeVault</b>\n\n💰 ${user.balance.toLocaleString()} ₽\n📦 ${user.myProducts.length} товаров\n🛒 ${user.inventory.length} покупок`,
            { reply_markup: { inline_keyboard: [[{ text: '🌐 Маркетплейс', url: DOMAIN }], [{ text: '💰 Баланс', callback_data: 'my_balance' }, { text: '❓ Помощь', callback_data: 'help' }]] } }
        );
    } else {
        await sendMessage(chatId, `👋 <b>Привет!</b>\n\n🛒 <b>CodeVault</b>\n\nМаркетплейс:\n• 🤖 Боты\n• 🌐 Веб\n• 📜 Скрипты`,
            { reply_markup: { inline_keyboard: [[{ text: '🚀 На сайт', url: DOMAIN }], [{ text: '❓ Помощь', callback_data: 'help' }]] } }
        );
    }
}

// ═══════════════════════════════════════════════════════════
// AUTH API
// ═══════════════════════════════════════════════════════════

// Проверка сессии
app.post('/api/auth/check', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ valid: false });
    
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.json({ valid: false });
    
    const { passwordHash, ...safeUser } = user;
    res.json({ valid: true, user: safeUser });
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните поля' });
    
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    if (!user.passwordHash) return res.status(401).json({ error: 'Установите пароль' });
    if (user.passwordHash !== hashPassword(password)) return res.status(401).json({ error: 'Неверный пароль' });
    
    const { passwordHash, ...safeUser } = user;
    res.json({ user: safeUser, token: user.id });
});

app.post('/api/auth/register/start', (req, res) => {
    const { username, password, confirmPassword } = req.body;
    
    if (!username || !password || !confirmPassword) return res.status(400).json({ error: 'Заполните все поля' });
    if (username.length < 3) return res.status(400).json({ error: 'Логин минимум 3 символа' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Логин: буквы, цифры, _' });
    if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    if (password !== confirmPassword) return res.status(400).json({ error: 'Пароли не совпадают' });
    
    if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(400).json({ error: 'Логин занят' });
    }
    
    const regId = crypto.randomBytes(16).toString('hex');
    pendingRegistrations.set(regId, { username: username.trim(), passwordHash: hashPassword(password), createdAt: Date.now() });
    setTimeout(() => pendingRegistrations.delete(regId), 15 * 60 * 1000);
    
    res.json({ success: true, regId, botLink: `https://t.me/${BOT_USERNAME}?start=reg_${regId}` });
});

app.post('/api/auth/register/confirm', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Введите код' });
    
    const regData = registerCodes.get(code.toUpperCase());
    if (!regData) return res.status(401).json({ error: 'Неверный код' });
    
    registerCodes.delete(code.toUpperCase());
    pendingRegistrations.delete(regData.regId);
    
    if (db.users.find(u => u.username.toLowerCase() === regData.username.toLowerCase())) {
        return res.status(400).json({ error: 'Логин занят' });
    }
    if (db.users.find(u => u.telegramId === regData.telegramId)) {
        return res.status(400).json({ error: 'TG уже привязан' });
    }
    
    const user = createUser(regData.username, regData.telegramId, regData.firstName, regData.passwordHash);
    
    sendMessage(regData.telegramId, `🎉 <b>Готово!</b>\n\n👤 ${user.username}\n💰 ${user.balance} ₽`,
        { reply_markup: { inline_keyboard: [[{ text: '🛒 Открыть', url: DOMAIN }]] } }
    );
    
    const { passwordHash, ...safeUser } = user;
    res.json({ user: safeUser, token: user.id });
});

function createUser(username, telegramId, displayName, passwordHash) {
    const user = {
        id: Date.now().toString(),
        telegramId,
        username,
        passwordHash,
        displayName: displayName || username,
        bio: 'Новый участник',
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
        balance: 100,
        earned: 0,
        joined: new Date().toLocaleDateString('ru-RU'),
        inventory: [],
        myProducts: []
    };
    db.users.push(user);
    
    db.transactions.push({
        id: Date.now().toString(),
        oderId: user.id,
        type: 'bonus',
        amount: 100,
        desc: '🎁 Бонус',
        date: new Date().toISOString()
    });
    
    saveDB();
    console.log(`👤 New user: ${username}`);
    
    return user;
}

// ═══════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════

app.get('/api/user/:username', (req, res) => {
    const user = db.users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Not found' });

    const owned = user.inventory.map(id => db.products.find(p => p.id === id)).filter(Boolean);
    const sold = db.products.filter(p => p.sellerId === user.id);
    const tx = db.transactions.filter(t => t.oderId === user.id).reverse().slice(0, 30);

    const { passwordHash, ...safeUser } = user;

    res.json({
        ...safeUser,
        ownedProducts: owned,
        soldProducts: sold,
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
    let result = [...db.products];

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
        id: p.id, title: p.title, description: p.description, price: p.price,
        category: p.category, seller: p.seller, sellerAvatar: p.sellerAvatar,
        downloads: p.downloads, preview: p.preview
    })));
});

app.post('/api/publish', upload.single('file'), (req, res) => {
    const { username, title, description, price, category } = req.body;
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(403).json({ error: 'Unauthorized' });

    const colors = { BOT: '6366f1', WEB: '22c55e', SCRIPT: 'f59e0b', API: 'ec4899' };
    
    const product = {
        id: Date.now().toString(),
        title, description,
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
    
    db.products.push(product);
    user.myProducts.push(product.id);
    saveDB();
    
    console.log(`📦 New: ${title} by ${username}`);
    res.json({ success: true });
});

app.post('/api/buy', (req, res) => {
    const { username, productId } = req.body;
    const user = db.users.find(u => u.username === username);
    const product = db.products.find(p => p.id === productId);

    if (!user || !product) return res.status(404).json({ error: 'Not found' });
    if (user.balance < product.price) return res.status(400).json({ error: 'Недостаточно средств!' });
    if (user.inventory.includes(productId)) return res.status(400).json({ error: 'Уже куплено' });
    if (product.sellerId === user.id) return res.status(400).json({ error: 'Нельзя купить своё' });

    user.balance -= product.price;
    user.inventory.push(productId);
    product.downloads++;

    const seller = db.users.find(u => u.id === product.sellerId);
    if (seller) {
        seller.balance += product.price;
        seller.earned = (seller.earned || 0) + product.price;
        
        db.transactions.push({
            id: Date.now().toString(),
            oderId: seller.id,
            type: 'sale',
            amount: product.price,
            desc: `💰 ${product.title}`,
            date: new Date().toISOString()
        });

        if (seller.telegramId) {
            sendMessage(seller.telegramId, `🎉 <b>Продажа!</b>\n\n📦 ${product.title}\n💰 +${product.price} ₽\n💳 ${seller.balance} ₽`,
                { reply_markup: { inline_keyboard: [[{ text: '🌐 Открыть', url: DOMAIN }]] } }
            );
        }
    }

    db.transactions.push({
        id: (Date.now() + 1).toString(),
        oderId: user.id,
        type: 'purchase',
        amount: -product.price,
        desc: `🛒 ${product.title}`,
        date: new Date().toISOString()
    });

    saveDB();
    console.log(`🛒 ${user.username} → ${product.title}`);
    res.json({ success: true, balance: user.balance });
});

app.post('/api/favorite', (req, res) => {
    const { username, productId } = req.body;
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const idx = db.favorites.findIndex(f => f.oderId === user.id && f.productId === productId);
    if (idx > -1) { db.favorites.splice(idx, 1); res.json({ favorited: false }); }
    else { db.favorites.push({ oderId: user.id, productId }); res.json({ favorited: true }); }
    saveDB();
});

app.get('/api/favorites/:username', (req, res) => {
    const user = db.users.find(u => u.username === req.params.username);
    if (!user) return res.json([]);
    res.json(db.favorites.filter(f => f.oderId === user.id).map(f => db.products.find(p => p.id === f.productId)).filter(Boolean));
});

app.get('/api/download/:productId', (req, res) => {
    const { username } = req.query;
    const user = db.users.find(u => u.username === username);
    const product = db.products.find(p => p.id === req.params.productId);

    if (!user || !product) return res.status(404).send('Not found');
    if (!user.inventory.includes(product.id) && user.id !== product.sellerId) return res.status(403).send('Access denied');
    if (!product.file) return res.status(404).send('No file');

    res.download(path.join(UPLOADS, product.file), product.title + path.extname(product.file));
});

app.post('/api/profile', (req, res) => {
    const { username, displayName, bio } = req.body;
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'Not found' });

    if (displayName) user.displayName = displayName;
    if (bio !== undefined) user.bio = bio;
    saveDB();
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// HTML с проверкой сессии
// ═══════════════════════════════════════════════════════════
const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeVault</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0a0f;--card:#12121a;--card2:#1a1a25;--border:#252535;--text:#e8e8e8;--dim:#707080;--accent:#6366f1;--green:#22c55e;--red:#ef4444}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.hidden{display:none!important}
button{cursor:pointer;font-family:inherit;border:none;transition:all .2s}
input,textarea,select{font-family:inherit;width:100%;background:var(--card2);border:1px solid var(--border);padding:14px 16px;color:#fff;border-radius:10px;margin-bottom:12px;font-size:14px}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent)}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--card);border:1px solid var(--accent);padding:14px 28px;border-radius:12px;opacity:0;transition:.3s;z-index:999}
.toast.show{transform:translateX(-50%) translateY(0);opacity:1}
#auth{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100}
.auth-container{width:100%;max-width:420px}
.auth-logo{text-align:center;margin-bottom:32px}
.auth-logo h1{font-size:2.5rem;font-weight:800;background:linear-gradient(135deg,var(--accent),#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.auth-logo p{color:var(--dim);font-size:14px;margin-top:8px}
.auth-box{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px}
.auth-tabs{display:flex;gap:8px;margin-bottom:24px;background:var(--bg);padding:4px;border-radius:10px}
.auth-tabs button{flex:1;padding:12px;background:transparent;color:var(--dim);border-radius:8px;font-size:14px;font-weight:600}
.auth-tabs button.active{background:var(--accent);color:#fff}
.auth-panel{display:none}.auth-panel.active{display:block}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:13px;color:var(--dim);margin-bottom:6px}
.form-group input{margin:0}
.btn{padding:14px 24px;border-radius:10px;font-weight:600;font-size:14px;width:100%}
.btn-primary{background:linear-gradient(135deg,var(--accent),#8b5cf6);color:#fff}
.btn-secondary{background:var(--card2);color:var(--text);border:1px solid var(--border)}
.btn-success{background:linear-gradient(135deg,var(--green),#16a34a);color:#fff}
.divider{display:flex;align-items:center;gap:16px;margin:20px 0;color:var(--dim);font-size:13px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
.reg-header{text-align:center;margin-bottom:24px}
.reg-header h2{font-size:18px}
.reg-header p{color:var(--dim);font-size:13px;margin-top:4px}
.steps-indicator{display:flex;justify-content:center;gap:8px;margin-bottom:24px}
.step-dot{width:10px;height:10px;border-radius:50%;background:var(--border)}
.step-dot.active{background:var(--accent)}
.step-dot.done{background:var(--green)}
.info-card{background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:20px}
.info-card.highlight{border-color:var(--accent)}
.info-card.success{border-color:var(--green)}
.info-card h4{font-size:14px;margin-bottom:8px}
.info-card p{font-size:13px;color:var(--dim)}
.code-input{text-align:center;font-size:24px;letter-spacing:8px;text-transform:uppercase;font-weight:700}
.back-link{color:var(--accent);font-size:13px;cursor:pointer;margin-top:16px;display:inline-block}
.app{display:flex;flex-direction:column;min-height:100vh}
.header{background:var(--card);padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50}
.header-logo{font-size:1.25rem;font-weight:800;background:linear-gradient(135deg,var(--accent),#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header-user{display:flex;align-items:center;gap:12px}
.header-balance{background:var(--card2);padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;color:var(--green)}
.header-avatar{width:36px;height:36px;border-radius:50%;border:2px solid var(--accent)}
.content{flex:1;padding:16px;padding-bottom:90px}
.tab{display:none}.tab.active{display:block}
.nav{display:flex;background:var(--card);border-top:1px solid var(--border);position:fixed;bottom:0;left:0;right:0;z-index:50;padding:8px 0}
.nav a{flex:1;padding:8px;text-align:center;color:var(--dim);text-decoration:none;font-size:11px;display:flex;flex-direction:column;align-items:center;gap:4px}
.nav a svg{width:24px;height:24px}
.nav a.active{color:var(--accent)}
.filters{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
.filters input{flex:1;min-width:150px;margin:0}
.filters select{width:auto;min-width:110px;margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.card-img{height:110px;background-size:cover;background-position:center;position:relative}
.card-cat{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.75);padding:4px 8px;border-radius:6px;font-size:10px}
.card-fav{position:absolute;top:8px;right:8px;width:32px;height:32px;background:rgba(0,0,0,.6);border-radius:50%;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center}
.card-fav.active{color:var(--red)}
.card-body{padding:12px}
.card-body h3{font-size:14px;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-body p{font-size:12px;color:var(--dim);margin-bottom:10px;height:32px;overflow:hidden}
.card-footer{display:flex;justify-content:space-between;align-items:center}
.price{font-size:15px;font-weight:700;color:var(--green)}
.card-footer .btn{padding:8px 14px;font-size:12px;width:auto}
.profile-card{background:var(--card);padding:24px;border-radius:16px;text-align:center;margin-bottom:20px}
.profile-card img{width:90px;height:90px;border-radius:50%;border:4px solid var(--accent);margin-bottom:16px}
.stats{display:flex;justify-content:center;gap:32px}
.stat b{display:block;font-size:1.5rem;color:var(--accent)}
.stat span{font-size:11px;color:var(--dim)}
.section{background:var(--card);padding:20px;border-radius:14px;margin-bottom:16px}
.section h3{margin-bottom:16px}
.mini-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.mini-card{background:var(--card2);padding:14px;border-radius:10px}
.mini-card h4{font-size:13px;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wallet-card{background:linear-gradient(135deg,var(--accent),#a855f7);padding:28px;border-radius:16px;text-align:center;margin-bottom:20px}
.wallet-card .amount{font-size:3rem;font-weight:800;margin:8px 0}
.topup-section{background:var(--card);border-radius:16px;padding:20px;margin-bottom:20px}
.topup-section h3{margin-bottom:16px}
.amount-buttons{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
.amount-btn{background:var(--card2);border:2px solid var(--border);padding:16px;border-radius:10px;font-size:16px;font-weight:700;color:var(--text)}
.amount-btn.selected{border-color:var(--green);color:var(--green)}
.pay-info{background:var(--card2);border-radius:10px;padding:12px;margin-top:16px;font-size:13px;color:var(--dim);text-align:center}
.tx-list{background:var(--card);border-radius:14px;overflow:hidden}
.tx{display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);font-size:13px}
.tx:last-child{border:none}
.tx-plus{color:var(--green)}
.tx-minus{color:var(--red)}
.upload-box{background:var(--card);padding:24px;border-radius:16px}
.row{display:flex;gap:10px}
.row>*{flex:1}
.file-area{border:2px dashed var(--border);padding:28px;text-align:center;border-radius:10px;color:var(--dim);margin-bottom:16px;cursor:pointer}
.empty-state{text-align:center;padding:40px;color:var(--dim)}
</style>
</head>
<body>
<div class="toast" id="toast"></div>
<div id="auth">
<div class="auth-container">
<div class="auth-logo"><h1>🛒 CodeVault</h1><p>Маркетплейс цифровых товаров</p></div>
<div class="auth-box">
<div class="auth-tabs">
<button class="active" onclick="switchAuth('login',this)">Вход</button>
<button onclick="switchAuth('register',this)">Регистрация</button>
</div>
<div id="auth-login" class="auth-panel active">
<div class="form-group"><label>Логин</label><input type="text" id="login-username" placeholder="Логин"></div>
<div class="form-group"><label>Пароль</label><input type="password" id="login-password" placeholder="Пароль"></div>
<button class="btn btn-primary" onclick="loginPassword()">Войти</button>
<div class="divider">нет аккаунта?</div>
<button class="btn btn-secondary" onclick="switchToRegister()">Создать</button>
</div>
<div id="auth-register" class="auth-panel">
<div id="reg-step1">
<div class="reg-header"><h2>Регистрация</h2><p>Шаг 1 из 3</p></div>
<div class="steps-indicator"><div class="step-dot active"></div><div class="step-dot"></div><div class="step-dot"></div></div>
<div class="form-group"><label>Логин</label><input type="text" id="reg-username" placeholder="developer" maxlength="20"></div>
<div class="form-group"><label>Пароль</label><input type="password" id="reg-password" placeholder="Мин. 4 символа"></div>
<div class="form-group"><label>Повтор</label><input type="password" id="reg-password2" placeholder="Повторите"></div>
<button class="btn btn-primary" onclick="startReg()">Далее →</button>
</div>
<div id="reg-step2" class="hidden">
<div class="reg-header"><h2>Подтверждение</h2><p>Шаг 2 из 3</p></div>
<div class="steps-indicator"><div class="step-dot done"></div><div class="step-dot active"></div><div class="step-dot"></div></div>
<div class="info-card highlight"><h4>👤 <span id="reg-show-username"></span></h4><p>Перейдите в бота</p></div>
<a id="reg-bot-link" href="#" target="_blank"><button class="btn btn-success">🤖 Telegram</button></a>
<div class="divider">есть код?</div>
<button class="btn btn-secondary" onclick="showStep3()">Ввести →</button>
<span class="back-link" onclick="showStep1()">← Назад</span>
</div>
<div id="reg-step3" class="hidden">
<div class="reg-header"><h2>Код</h2><p>Шаг 3 из 3</p></div>
<div class="steps-indicator"><div class="step-dot done"></div><div class="step-dot done"></div><div class="step-dot active"></div></div>
<div class="info-card success"><h4>✅ Почти готово!</h4><p>Введите код</p></div>
<input type="text" id="reg-code" class="code-input" placeholder="XXXXXX" maxlength="6">
<button class="btn btn-primary" onclick="confirmReg()">Готово</button>
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
<select id="f-cat"><option value="all">Все</option><option value="BOT">🤖</option><option value="WEB">🌐</option><option value="SCRIPT">📜</option></select>
<select id="f-sort"><option value="newest">Новые</option><option value="popular">Популярные</option><option value="price-low">Дешевле</option></select>
</div>
<div id="grid" class="grid"></div>
</section>
<section id="tab-favs" class="tab"><h2 style="margin-bottom:20px">❤️ Избранное</h2><div id="favs-grid" class="grid"></div></section>
<section id="tab-profile" class="tab">
<div class="profile-card"><img id="p-avatar" src=""><h2 id="p-name"></h2><p id="p-bio"></p>
<div class="stats"><div class="stat"><b id="s-products">0</b><span>Товаров</span></div><div class="stat"><b id="s-sales">0</b><span>Продаж</span></div><div class="stat"><b id="s-earned">0</b><span>Заработано</span></div></div>
</div>
<div class="section"><h3>✏️ Редактировать</h3><input type="text" id="e-name" placeholder="Имя"><textarea id="e-bio" rows="2" placeholder="О себе"></textarea><button class="btn btn-primary" onclick="saveProfile()">Сохранить</button></div>
<div class="section"><h3>📦 Покупки</h3><div id="owned" class="mini-grid"></div></div>
<div class="section"><button class="btn btn-secondary" onclick="logout()">🚪 Выйти</button></div>
</section>
<section id="tab-wallet" class="tab">
<div class="wallet-card"><small>💳 Баланс</small><div class="amount" id="w-bal">0 ₽</div></div>
<div class="topup-section">
<h3>💰 Пополнить</h3>
<div class="amount-buttons">
<button class="amount-btn" onclick="selAmt(100,this)">100₽</button>
<button class="amount-btn" onclick="selAmt(250,this)">250₽</button>
<button class="amount-btn" onclick="selAmt(500,this)">500₽</button>
<button class="amount-btn" onclick="selAmt(1000,this)">1000₽</button>
<button class="amount-btn" onclick="selAmt(2500,this)">2500₽</button>
<button class="amount-btn" onclick="selAmt(5000,this)">5000₽</button>
</div>
<input type="number" id="custom-amount" placeholder="Своя сумма" min="10" style="text-align:center">
<button class="btn btn-success" onclick="pay()" style="margin-top:12px">💳 Оплатить</button>
<div class="pay-info">ЮMoney • Мин. 10₽</div>
</div>
<h3 style="margin-bottom:14px">📋 История</h3>
<div class="tx-list" id="tx"></div>
</section>
<section id="tab-upload" class="tab">
<div class="upload-box">
<h2 style="margin-bottom:20px">📤 Новый товар</h2>
<div class="form-group"><label>Название</label><input type="text" id="u-title" placeholder="Бот..."></div>
<div class="row">
<div class="form-group"><label>Категория</label><select id="u-cat"><option value="BOT">🤖</option><option value="WEB">🌐</option><option value="SCRIPT">📜</option></select></div>
<div class="form-group"><label>Цена</label><input type="number" id="u-price" placeholder="1000"></div>
</div>
<div class="form-group"><label>Описание</label><textarea id="u-desc" rows="3" placeholder="..."></textarea></div>
<div class="file-area" onclick="document.getElementById('u-file').click()">📁 Файл</div>
<input type="file" id="u-file" hidden>
<button class="btn btn-primary" onclick="publish()">🚀 Опубликовать</button>
</div>
</section>
</div>
<nav class="nav">
<a href="#" class="active" data-tab="market"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>Маркет</a>
<a href="#" data-tab="favs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>❤️</a>
<a href="#" data-tab="profile"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"/><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/></svg>Я</a>
<a href="#" data-tab="wallet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>💰</a>
<a href="#" data-tab="upload"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>+</a>
</nav>
</div>
<script>
let user=null,favIds=[],selAmount=0;
const $=id=>document.getElementById(id);
const toast=m=>{const t=$('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)};
const fmt=n=>n.toLocaleString('ru')+' ₽';
const esc=s=>{const d=document.createElement('div');d.textContent=s;return d.innerHTML};

function switchAuth(m,btn){document.querySelectorAll('.auth-tabs button').forEach(b=>b.classList.remove('active'));btn?.classList.add('active');document.querySelectorAll('.auth-panel').forEach(p=>p.classList.remove('active'));$('auth-'+m).classList.add('active');if(m==='register')showStep1()}
function switchToRegister(){document.querySelectorAll('.auth-tabs button')[1].click()}
function showStep1(){$('reg-step1').classList.remove('hidden');$('reg-step2').classList.add('hidden');$('reg-step3').classList.add('hidden')}
function showStep2(){$('reg-step1').classList.add('hidden');$('reg-step2').classList.remove('hidden');$('reg-step3').classList.add('hidden')}
function showStep3(){$('reg-step1').classList.add('hidden');$('reg-step2').classList.add('hidden');$('reg-step3').classList.remove('hidden');$('reg-code').focus()}

async function startReg(){
    const u=$('reg-username').value.trim(),p=$('reg-password').value,p2=$('reg-password2').value;
    if(!u||!p||!p2)return toast('Заполните всё');
    const r=await fetch('/api/auth/register/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p,confirmPassword:p2})});
    const d=await r.json();
    if(!r.ok)return toast(d.error);
    $('reg-show-username').textContent=u;
    $('reg-bot-link').href=d.botLink;
    showStep2();
}

async function confirmReg(){
    const code=$('reg-code').value.trim().toUpperCase();
    if(!code||code.length!==6)return toast('6 символов');
    const r=await fetch('/api/auth/register/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    const d=await r.json();
    if(!r.ok)return toast(d.error);
    user=d.user;
    localStorage.setItem('user',JSON.stringify(user));
    onLogin();
    toast('🎉 Добро пожаловать!');
}

async function loginPassword(){
    const u=$('login-username').value.trim(),p=$('login-password').value;
    if(!u||!p)return toast('Заполните');
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const d=await r.json();
    if(!r.ok)return toast(d.error);
    user=d.user;
    localStorage.setItem('user',JSON.stringify(user));
    onLogin();
}

function onLogin(){$('auth').classList.add('hidden');$('app').classList.remove('hidden');updateUI();loadMarket();if(location.hash==='#wallet')document.querySelector('[data-tab="wallet"]').click()}
function logout(){user=null;localStorage.removeItem('user');location.reload()}
function updateUI(){$('h-avatar').src=user.avatar;$('h-balance').textContent=fmt(user.balance)}

// ПРОВЕРКА СЕССИИ ПРИ ЗАГРУЗКЕ
(async function(){
    const saved=localStorage.getItem('user');
    if(saved){
        try{
            const u=JSON.parse(saved);
            // Проверяем на сервере
            const r=await fetch('/api/auth/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u.username})});
            const d=await r.json();
            if(d.valid){
                user=d.user;
                localStorage.setItem('user',JSON.stringify(user));
                onLogin();
            }else{
                localStorage.removeItem('user');
                console.log('Сессия устарела');
            }
        }catch(e){localStorage.removeItem('user')}
    }
})();

document.querySelectorAll('.nav a').forEach(a=>{a.onclick=e=>{e.preventDefault();document.querySelectorAll('.nav a').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));a.classList.add('active');$('tab-'+a.dataset.tab).classList.add('active');if(a.dataset.tab==='market')loadMarket();if(a.dataset.tab==='favs')loadFavs();if(a.dataset.tab==='profile')loadProfile();if(a.dataset.tab==='wallet')loadWallet()}});
['f-search','f-cat','f-sort'].forEach(id=>{$(id).addEventListener('input',loadMarket);$(id).addEventListener('change',loadMarket)});

async function loadMarket(){
    const params=new URLSearchParams();
    if($('f-search').value)params.append('search',$('f-search').value);
    if($('f-cat').value!=='all')params.append('category',$('f-cat').value);
    params.append('sort',$('f-sort').value);
    const[prods,favs]=await Promise.all([fetch('/api/products?'+params).then(r=>r.json()),fetch('/api/favorites/'+user.username).then(r=>r.json())]);
    favIds=favs.map(f=>f.id);
    $('grid').innerHTML=prods.length?prods.map(p=>card(p)).join(''):'<div class="empty-state">Пусто</div>';
}

function card(p){const fav=favIds.includes(p.id);return'<div class="card"><div class="card-img" style="background-image:url('+p.preview+')"><span class="card-cat">'+p.category+'</span><button class="card-fav '+(fav?'active':'')+'" onclick="event.stopPropagation();toggleFav(\\''+p.id+'\\',this)">♥</button></div><div class="card-body"><h3>'+esc(p.title)+'</h3><p>'+esc(p.description||'')+'</p><div class="card-footer"><span class="price">'+fmt(p.price)+'</span><button class="btn btn-primary" onclick="buy(\\''+p.id+'\\')">Купить</button></div></div></div>'}

async function buy(id){if(!confirm('Купить?'))return;const r=await fetch('/api/buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.username,productId:id})});const d=await r.json();if(r.ok){user.balance=d.balance;updateUI();toast('✅ Куплено!');loadMarket()}else toast(d.error)}
async function toggleFav(id,btn){const r=await fetch('/api/favorite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.username,productId:id})});const d=await r.json();btn.classList.toggle('active',d.favorited)}
async function loadFavs(){const f=await fetch('/api/favorites/'+user.username).then(r=>r.json());$('favs-grid').innerHTML=f.length?f.map(p=>card(p)).join(''):'<div class="empty-state">Пусто</div>'}

async function loadProfile(){
    const d=await fetch('/api/user/'+user.username).then(r=>r.json());
    user={...user,...d};localStorage.setItem('user',JSON.stringify(user));updateUI();
    $('p-avatar').src=d.avatar;$('p-name').textContent=d.displayName;$('p-bio').textContent=d.bio;
    $('s-products').textContent=d.stats.products;$('s-sales').textContent=d.stats.sales;$('s-earned').textContent=fmt(d.stats.earned);
    $('e-name').value=d.displayName;$('e-bio').value=d.bio;
    $('owned').innerHTML=d.ownedProducts.length?d.ownedProducts.map(p=>'<div class="mini-card"><h4>'+esc(p.title)+'</h4><a href="/api/download/'+p.id+'?username='+user.username+'" class="btn btn-primary">📥</a></div>').join(''):'<div class="empty-state">Нет</div>';
}

async function saveProfile(){await fetch('/api/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.username,displayName:$('e-name').value,bio:$('e-bio').value})});toast('✅');loadProfile()}

async function loadWallet(){
    const d=await fetch('/api/user/'+user.username).then(r=>r.json());
    user.balance=d.balance;updateUI();
    $('w-bal').textContent=fmt(d.balance);
    $('tx').innerHTML=d.transactions.length?d.transactions.map(t=>'<div class="tx"><div><b>'+t.desc+'</b><br><small>'+new Date(t.date).toLocaleString('ru')+'</small></div><span class="'+(t.amount>0?'tx-plus':'tx-minus')+'">'+(t.amount>0?'+':'')+fmt(t.amount)+'</span></div>').join(''):'<div class="empty-state">Нет</div>';
}

function selAmt(a,btn){selAmount=a;$('custom-amount').value='';document.querySelectorAll('.amount-btn').forEach(b=>b.classList.remove('selected'));btn.classList.add('selected')}
$('custom-amount').addEventListener('input',function(){selAmount=Number(this.value)||0;document.querySelectorAll('.amount-btn').forEach(b=>b.classList.remove('selected'))});

async function pay(){
    const a=selAmount||Number($('custom-amount').value);
    if(!a||a<10)return toast('Мин. 10₽');
    const r=await fetch('/api/payment/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.username,amount:a})});
    const d=await r.json();
    if(!r.ok)return toast(d.error);
    window.open(d.paymentUrl,'_blank');
    toast('Оплата...');
    const int=setInterval(async()=>{try{const s=await fetch('/api/payment/status/'+d.paymentId).then(r=>r.json());if(s.status==='completed'){clearInterval(int);toast('✅ Оплачено!');loadWallet()}}catch(e){}},4000);
    setTimeout(()=>clearInterval(int),600000);
}

async function publish(){
    const t=$('u-title').value.trim(),pr=$('u-price').value,de=$('u-desc').value.trim();
    if(!t||!pr||!de)return toast('Заполните');
    const fd=new FormData();fd.append('username',user.username);fd.append('title',t);fd.append('price',pr);fd.append('description',de);fd.append('category',$('u-cat').value);
    const f=$('u-file').files[0];if(f)fd.append('file',f);
    const r=await fetch('/api/publish',{method:'POST',body:fd});
    if(r.ok){toast('🚀 Готово!');$('u-title').value='';$('u-price').value='';$('u-desc').value='';document.querySelector('[data-tab="market"]').click()}
}
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));

// ═══════════════════════════════════════════════════════════
// ЗАПУСК
// ═══════════════════════════════════════════════════════════
app.listen(PORT, async () => {
    console.log('═══════════════════════════════════════');
    console.log('🚀 CodeVault started on port', PORT);
    console.log('🌐', DOMAIN);
    console.log('💳 Wallet:', YOOMONEY_WALLET);
    console.log('👥 Users:', db.users.length);
    console.log('📦 Products:', db.products.length);
    console.log('═══════════════════════════════════════');
    
    try {
        const r = await fetch(TELEGRAM_API + '/setWebhook?url=' + DOMAIN + WEBHOOK_PATH);
        const d = await r.json();
        console.log('📱 TG:', d.ok ? '✅' : '❌');
    } catch (e) {}
});

// Сохранение при выходе
process.on('SIGINT', () => { saveDB(); process.exit(); });
process.on('SIGTERM', () => { saveDB(); process.exit(); });
