const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// const fetch = require('node-fetch'); // Убрано, так как в Node 18 fetch встроен
const cron = require('node-cron');

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN || '8035930401:AAH4bICwB8LVXApFEIaLmOlsYD9PyO5sylI';
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
const DOMAIN = process.env.DOMAIN || 'https://marketplacebot.bothost.ru'; 
const BOT_USERNAME = 'RegisterMarketPlace_bot';
const YOOMONEY_WALLET = process.env.YOOMONEY_WALLET || '4100118944797800';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Папка для загрузок
const UPLOADS = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS)) {
    fs.mkdirSync(UPLOADS, { recursive: true });
}

// Настройка Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS),
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, Date.now() + '-' + safeName);
    },
});
const upload = multer({ storage });
app.use('/uploads', express.static(UPLOADS));

// База данных
const DB_FILE = path.join(__dirname, 'database.json');
let db = {
    users: [],
    products: [],
    transactions: [],
    favorites: [],
    comments: [],
    ratings: [],
    chats: [],
};

// Загрузка базы данных
function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            db = JSON.parse(data);
            console.log(`Database loaded: ${db.users.length} users, ${db.products.length} products`);
        }
    } catch (e) {
        console.log('Could not load database:', e.message);
        db = { users: [], products: [], transactions: [], favorites: [], comments: [], ratings: [], chats: [] };
    }
}

// Сохранение базы данных
function saveDB() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
        console.log('Could not save database:', e.message);
    }
}

setInterval(saveDB, 30000);
loadDB();

// Вспомогательные переменные
let pendingPayments = new Map();
const registerCodes = new Map();
const pendingRegistrations = new Map();

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function generatePaymentId() {
    return 'PAY_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

// Telegram API
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendMessage(chatId, text, options = {}) {
    try {
        await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...options }),
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
            body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: showAlert }),
        });
    } catch (e) {}
}

function createPaymentUrl(amount, paymentId) {
    const params = new URLSearchParams({
        receiver: YOOMONEY_WALLET,
        'quickpay-form': 'shop',
        targets: 'Пополнение CodeVault',
        paymentType: 'PC',
        sum: amount,
        label: paymentId,
        successURL: `${DOMAIN}/payment/success?id=${paymentId}`,
    });
    return `https://yoomoney.ru/quickpay/confirm.xml?${params.toString()}`;
}

function createUser(username, telegramId, displayName, passwordHash) {
    const user = {
        id: Date.now().toString() + crypto.randomBytes(2).toString('hex'),
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
        myProducts: [],
        isPremium: false,
        premiumExpires: null,
        premiumAutoRenew: false,
    };

    db.users.push(user);
    db.transactions.push({
        id: Date.now().toString(),
        userId: user.id,
        type: 'bonus',
        amount: 100,
        desc: '🎁 Бонус за регистрацию',
        date: new Date().toISOString(),
    });

    saveDB();
    console.log(`New user: ${username}`);
    return user;
}

// Middleware для авторизации
const authMiddleware = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
    const user = db.users.find(u => u.id === token);
    if (!user) return res.status(401).json({ error: 'Неверный токен' });
    req.user = user;
    next();
};

// Cron Jobs
cron.schedule('0 0 * * *', () => {
    saveDB();
});

// --- API Платежей ---
app.post('/api/payment/create', authMiddleware, (req, res) => {
    const { amount } = req.body;
    const user = req.user;

    const sum = Number(amount);
    if (!sum || sum < 10) return res.status(400).json({ error: 'Минимум 10 ₽' });

    const paymentId = generatePaymentId();
    pendingPayments.set(paymentId, {
        id: paymentId,
        userId: user.id,
        username: user.username,
        amount: sum,
        status: 'pending',
        createdAt: Date.now(),
    });

    setTimeout(() => {
        if (pendingPayments.has(paymentId) && pendingPayments.get(paymentId).status === 'pending') {
            pendingPayments.delete(paymentId);
        }
    }, 60 * 60 * 1000);

    const paymentUrl = createPaymentUrl(sum, paymentId);
    res.json({ success: true, paymentId, paymentUrl, amount: sum });
});

app.get('/api/payment/status/:paymentId', (req, res) => {
    const payment = pendingPayments.get(req.params.paymentId);
    if (!payment) return res.status(404).json({ error: 'Не найден' });
    res.json({ status: payment.status, amount: payment.amount });
});

app.post('/api/yoomoney/webhook', (req, res) => {
    const { amount, label, test_notification } = req.body;
    if (test_notification === 'true') return res.send('OK');
    if (!label) return res.send('OK');

    const payment = pendingPayments.get(label);
    if (!payment) return res.status(404).send('Not found');
    if (payment.status === 'completed') return res.send('OK');

    const receivedAmount = parseFloat(amount);
    const user = db.users.find(u => u.id === payment.userId);

    if (user) {
        user.balance += receivedAmount;
        db.transactions.push({
            id: Date.now().toString(),
            userId: user.id,
            type: 'deposit',
            amount: receivedAmount,
            desc: '💳 Пополнение ЮMoney',
            paymentId: label,
            date: new Date().toISOString(),
        });

        payment.status = 'completed';
        saveDB();

        if (user.telegramId) {
            sendMessage(user.telegramId,
                `✅ <b>Баланс пополнен!</b>\n\n💰 +${receivedAmount.toLocaleString()} ₽`
            );
        }
    }
    res.send('OK');
});

app.get('/payment/success', (req, res) => {
    const { id } = req.query;
    const payment = pendingPayments.get(id);
    res.send(`<h1>Статус: ${payment ? payment.status : 'Не найден'}</h1><a href="/">Вернуться</a>`);
});

// --- API Telegram Webhook ---
app.post(WEBHOOK_PATH, async (req, res) => {
    const { message, callback_query } = req.body;

    if (callback_query) {
        const chatId = callback_query.message.chat.id;
        const data = callback_query.data;
        const from = callback_query.from;

        if (data.startsWith('confirm_reg_')) {
            const regId = data.replace('confirm_reg_', '');
            const pending = pendingRegistrations.get(regId);

            if (pending) {
                if (db.users.find(u => u.telegramId === from.id)) {
                    await answerCallback(callback_query.id, '⚠️ TG уже привязан!', true);
                    return res.sendStatus(200);
                }

                const code = Math.random().toString(36).substring(2, 8).toUpperCase();
                registerCodes.set(code, { 
                    regId, 
                    telegramId: from.id, 
                    username: pending.username, 
                    passwordHash: pending.passwordHash, 
                    firstName: from.first_name, 
                    createdAt: Date.now() 
                });
                setTimeout(() => registerCodes.delete(code), 10 * 60 * 1000);

                await answerCallback(callback_query.id, '✅ Код создан!');
                await sendMessage(chatId, `✅ <b>Код подтверждения</b>\n\n🔐 Код: <code>${code}</code>`);
            } else {
                await answerCallback(callback_query.id, '❌ Ссылка устарела', true);
            }
        }
        return res.sendStatus(200);
    }

    if (message && message.text) {
        const chatId = message.chat.id;
        const text = message.text;
        
        if (text.startsWith('/start reg_')) {
            const regId = text.replace('/start reg_', '');
            const pending = pendingRegistrations.get(regId);
            if (pending) {
                await sendMessage(chatId, `📝 <b>Регистрация</b>\nПользователь: ${pending.username}\n\nНажмите кнопку ниже:`,
                    { reply_markup: { inline_keyboard: [[{ text: '✅ Получить код', callback_data: `confirm_reg_${regId}` }]] } }
                );
            } else {
                await sendMessage(chatId, '❌ Ссылка устарела.');
            }
        }
    }
    res.sendStatus(200);
});

// --- API Auth ---
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
    if (user.passwordHash !== hashPassword(password)) return res.status(401).json({ error: 'Неверный пароль' });

    const { passwordHash, ...safeUser } = user;
    res.json({ user: safeUser, token: user.id });
});

app.post('/api/auth/register/start', (req, res) => {
    const { username, password, confirmPassword } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните поля' });
    if (username.length < 3) return res.status(400).json({ error: 'Логин от 3 символов' });
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
        return res.status(400).json({ error: 'Логин уже занят' });
    }

    const user = createUser(regData.username, regData.telegramId, regData.firstName, regData.passwordHash);
    const { passwordHash, ...safeUser } = user;
    res.json({ user: safeUser, token: user.id });
});

// --- API Социальное ---
app.post('/api/comments/add', authMiddleware, (req, res) => {
    const { productId, text } = req.body;
    const user = req.user;
    if (!productId || !text) return res.status(400).json({ error: "Данные неполные" });

    const comment = {
        id: Date.now().toString(),
        productId,
        userId: user.id,
        username: user.username,
        text: text.slice(0, 500),
        createdAt: new Date().toISOString(),
    };

    db.comments.push(comment);
    saveDB();
    res.json({ success: true, comment });
});

app.get('/api/comments/:productId', (req, res) => {
    const comments = db.comments.filter(c => c.productId === req.params.productId);
    res.json(comments);
});

// Чаты
app.post('/api/chats/create', authMiddleware, (req, res) => {
    const { targetUserId } = req.body;
    const user = req.user;
    if (!targetUserId || targetUserId === user.id) return res.status(400).json({ error: "Некорректный получатель" });

    let chat = db.chats.find(c => c.participants.includes(user.id) && c.participants.includes(targetUserId));
    if (!chat) {
        chat = { id: Date.now().toString(), participants: [user.id, targetUserId], messages: [] };
        db.chats.push(chat);
        saveDB();
    }
    res.json({ success: true, chat });
});

app.post('/api/chats/send', authMiddleware, (req, res) => {
    const { chatId, text } = req.body;
    const user = req.user;
    const chat = db.chats.find(c => c.id === chatId);
    if (!chat) return res.status(404).json({ error: "Чат не найден" });
    if (!chat.participants.includes(user.id)) return res.status(403).json({ error: "Нет доступа" });

    chat.messages.push({
        id: Date.now().toString(),
        senderId: user.id,
        text: text.slice(0, 1000),
        createdAt: new Date().toISOString(),
    });
    saveDB();
    res.json({ success: true });
});

app.get('/api/chats/list', authMiddleware, (req, res) => {
    const user = req.user;
    const userChats = db.chats.filter(c => c.participants.includes(user.id));
    const enrichedChats = userChats.map(chat => {
        const otherId = chat.participants.find(id => id !== user.id);
        const otherUser = db.users.find(u => u.id === otherId);
        return {
            id: chat.id,
            partner: otherUser ? { username: otherUser.username, avatar: otherUser.avatar } : { username: 'Deleted', avatar: '' },
            lastMessage: chat.messages[chat.messages.length - 1]
        };
    });
    res.json(enrichedChats);
});

app.get('/api/chats/detail/:chatId', authMiddleware, (req, res) => {
    const { chatId } = req.params;
    const user = req.user;
    const chat = db.chats.find(c => c.id === chatId);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.participants.includes(user.id)) return res.status(403).json({ error: 'Нет доступа' });
    const otherId = chat.participants.find(id => id !== user.id);
    const otherUser = db.users.find(u => u.id === otherId);
    res.json({ ...chat, partnerUsername: otherUser ? otherUser.username : 'Unknown' });
});

// --- API Товаров ---
app.get('/api/products', (req, res) => {
    const { category, search, sort } = req.query;
    let result = [...db.products];
    if (category && category !== 'all') result = result.filter(p => p.category === category);
    if (search) {
        const s = search.toLowerCase();
        result = result.filter(p => p.title.toLowerCase().includes(s) || p.description.toLowerCase().includes(s));
    }
    // Сортировка
    if (sort === 'price-low') result.sort((a, b) => a.price - b.price);
    else if (sort === 'price-high') result.sort((a, b) => b.price - a.price);
    else result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(result.map(p => ({
        id: p.id, title: p.title, description: p.description, price: p.price,
        category: p.category, seller: p.seller, sellerAvatar: p.sellerAvatar,
        downloads: p.downloads, preview: p.preview
    })));
});

app.get('/api/products/:id', (req, res) => {
    const product = db.products.find(p => p.id === req.params.id);
    if(!product) return res.status(404).json({error: "Товар не найден"});
    res.json(product);
});

app.post('/api/publish', authMiddleware, upload.single('file'), (req, res) => {
    const { title, description, price, category } = req.body;
    const user = req.user;
    if (!req.file) return res.status(400).json({ error: 'Файл обязателен' });

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
        file: req.file.filename,
        preview: `https://placehold.co/600x400/${colors[category] || '8b5cf6'}/fff?text=${encodeURIComponent(title.substring(0, 12))}&font=roboto`,
        downloads: 0,
        createdAt: new Date().toISOString(),
    };
    db.products.push(product);
    user.myProducts.push(product.id);
    saveDB();
    res.json({ success: true });
});

app.post('/api/buy', authMiddleware, (req, res) => {
    const { productId } = req.body;
    const user = req.user;
    const product = db.products.find(p => p.id === productId);

    if (!product) return res.status(404).json({ error: 'Товар не найден' });
    if (user.balance < product.price) return res.status(400).json({ error: 'Недостаточно средств!' });
    if (user.inventory.includes(productId)) return res.status(400).json({ error: 'Уже куплено' });
    if (product.sellerId === user.id) return res.status(400).json({ error: 'Нельзя купить свой товар' });

    user.balance -= product.price;
    user.inventory.push(productId);
    product.downloads++;

    const seller = db.users.find(u => u.id === product.sellerId);
    if (seller) {
        seller.balance += product.price;
        seller.earned = (seller.earned || 0) + product.price;
        db.transactions.push({
            id: Date.now().toString(),
            userId: seller.id,
            type: 'sale',
            amount: product.price,
            desc: `💰 Продажа: ${product.title}`,
            date: new Date().toISOString(),
        });
        if (seller.telegramId) sendMessage(seller.telegramId, `🎉 <b>Продажа!</b>\n\n📦 ${product.title}\n💰 +${product.price} ₽`);
    }

    db.transactions.push({
        id: (Date.now() + 1).toString(),
        userId: user.id,
        type: 'purchase',
        amount: -product.price,
        desc: `🛒 Покупка: ${product.title}`,
        date: new Date().toISOString(),
    });
    saveDB();
    res.json({ success: true, balance: user.balance });
});

app.get('/api/favorites/:username', (req, res) => {
    const user = db.users.find(u => u.username === req.params.username);
    if (!user) return res.json([]);
    const userFavs = db.favorites.filter(f => f.userId === user.id).map(f => f.productId);
    const products = db.products.filter(p => userFavs.includes(p.id));
    res.json(products);
});

app.post('/api/favorite', authMiddleware, (req, res) => {
    const { productId } = req.body;
    const user = req.user;
    const idx = db.favorites.findIndex(f => f.userId === user.id && f.productId === productId);
    let favorited = false;
    if (idx > -1) {
        db.favorites.splice(idx, 1);
    } else {
        db.favorites.push({ userId: user.id, productId });
        favorited = true;
    }
    saveDB();
    res.json({ favorited });
});

app.get('/api/user/:username', (req, res) => {
    const user = db.users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Not found' });
    const owned = user.inventory.map(id => db.products.find(p => p.id === id)).filter(Boolean);
    const sold = db.products.filter(p => p.sellerId === user.id);
    const { passwordHash, telegramId, ...safeUser } = user;
    res.json({ ...safeUser, ownedProducts: owned, soldProducts: sold });
});

app.get('/api/me', authMiddleware, (req, res) => {
    const user = req.user;
    const tx = db.transactions.filter(t => t.userId === user.id).reverse().slice(0, 30);
    res.json({ transactions: tx, balance: user.balance });
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

app.post('/api/profile', authMiddleware, (req, res) => {
    const { displayName, bio } = req.body;
    const user = req.user;
    if (displayName) user.displayName = displayName.slice(0, 30);
    if (bio !== undefined) user.bio = bio.slice(0, 200);
    saveDB();
    res.json({ success: true });
});

// HTML-страница (ЗДЕСЬ БЫЛА ОШИБКА, ТЕПЕРЬ ИСПРАВЛЕНО)
const HTML = `
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeVault Marketplace</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0a0f;--card:#12121a;--card2:#1a1a25;--border:#252535;--text:#e8e8e8;--dim:#707080;--accent:#6366f1;--green:#22c55e;--red:#ef4444}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.hidden{display:none!important}
button{cursor:pointer;font-family:inherit;border:none;transition:all .2s}
input,textarea,select{font-family:inherit;width:100%;background:var(--card2);border:1px solid var(--border);padding:14px 16px;color:#fff;border-radius:10px;margin-bottom:12px;font-size:14px}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent)}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--card);border:1px solid var(--accent);padding:14px 28px;border-radius:12px;opacity:0;transition:.3s;z-index:2000}
.toast.show{transform:translateX(-50%) translateY(0);opacity:1}
#auth{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100}
.auth-container{width:100%;max-width:420px}
.auth-logo{text-align:center;margin-bottom:32px}
.auth-logo h1{font-size:2.5rem;font-weight:800;background:linear-gradient(135deg,var(--accent),#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.auth-box{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px}
.auth-tabs{display:flex;gap:8px;margin-bottom:24px;background:var(--bg);padding:4px;border-radius:10px}
.auth-tabs button{flex:1;padding:12px;background:transparent;color:var(--dim);border-radius:8px;font-size:14px;font-weight:600}
.auth-tabs button.active{background:var(--accent);color:#fff}
.auth-panel{display:none}.auth-panel.active{display:block}
.btn{padding:14px 24px;border-radius:10px;font-weight:600;font-size:14px;width:100%}
.btn-primary{background:linear-gradient(135deg,var(--accent),#8b5cf6);color:#fff}
.btn-secondary{background:var(--card2);color:var(--text);border:1px solid var(--border)}
.btn-success{background:linear-gradient(135deg,var(--green),#16a34a);color:#fff}
.header{background:var(--card);padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50}
.header-logo{font-size:1.25rem;font-weight:800;background:linear-gradient(135deg,var(--accent),#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header-user{display:flex;align-items:center;gap:12px}
.content{flex:1;padding:16px;padding-bottom:90px}
.tab{display:none}.tab.active{display:block}
.nav{display:flex;background:var(--card);border-top:1px solid var(--border);position:fixed;bottom:0;left:0;right:0;z-index:50;padding:8px 0}
.nav a{flex:1;padding:8px;text-align:center;color:var(--dim);text-decoration:none;font-size:11px;display:flex;flex-direction:column;align-items:center;gap:4px}
.nav a.active{color:var(--accent)}
.nav a svg{width:24px;height:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;cursor:pointer}
.card-img{height:110px;background-size:cover;background-position:center;position:relative}
.card-cat{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.75);padding:4px 8px;border-radius:6px;font-size:10px}
.card-fav{position:absolute;top:8px;right:8px;width:32px;height:32px;background:rgba(0,0,0,.6);border-radius:50%;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center}
.card-fav.active{color:var(--red)}
.card-body{padding:12px}
.card-footer{display:flex;justify-content:space-between;align-items:center}
.price{font-size:15px;font-weight:700;color:var(--green)}
.modal-overlay {position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;}
.product-window, .chat-window {background:var(--card);width:100%;max-width:500px;border-radius:16px;padding:20px;max-height:90vh;overflow-y:auto;}
.chat-messages {height:300px;overflow-y:auto;background:var(--card2);padding:10px;border-radius:10px;margin:10px 0;}
.message {margin-bottom:8px;padding:8px;border-radius:8px;max-width:80%;}
.message.sent {background:var(--accent);margin-left:auto;}
.message.received {background:#333;margin-right:auto;}
.chat-preview {display:flex;align-items:center;gap:12px;padding:12px;background:var(--card2);border-radius:10px;margin-bottom:8px;cursor:pointer;}
</style>
</head>
<body>
<div class="toast" id="toast"></div>

<!-- Auth -->
<div id="auth">
    <div class="auth-container">
        <div class="auth-logo"><h1>🛒 CodeVault</h1><p>Маркетплейс цифровых товаров</p></div>
        <div class="auth-box">
            <div class="auth-tabs">
                <button class="active" onclick="switchAuth('login',this)">Вход</button>
                <button onclick="switchAuth('register',this)">Регистрация</button>
            </div>
            
            <div id="auth-login" class="auth-panel active">
                <input type="text" id="login-username" placeholder="Логин">
                <input type="password" id="login-password" placeholder="Пароль">
                <button class="btn btn-primary" onclick="loginPassword()">Войти</button>
            </div>

            <div id="auth-register" class="auth-panel">
                <div id="reg-step1">
                    <input type="text" id="reg-username" placeholder="Логин (a-z0-9)">
                    <input type="password" id="reg-password" placeholder="Пароль">
                    <input type="password" id="reg-password2" placeholder="Повторите пароль">
                    <button class="btn btn-primary" onclick="startReg()">Далее →</button>
                </div>
                <div id="reg-step2" class="hidden">
                    <p style="text-align:center;margin-bottom:15px">Перейдите в бота и получите код</p>
                    <a id="reg-bot-link" href="#" target="_blank"><button class="btn btn-success" style="margin-bottom:10px">🤖 Telegram Bot</button></a>
                    <input type="text" id="reg-code" placeholder="Код из бота" style="text-align:center;font-size:20px;letter-spacing:5px">
                    <button class="btn btn-primary" onclick="confirmReg()">Завершить</button>
                </div>
            </div>
        </div>
    </div>
</div>

<!-- App -->
<div id="app" class="app hidden">
    <header class="header">
        <div class="header-logo">CodeVault</div>
        <div class="header-user">
            <div class="header-balance" id="h-balance">0 ₽</div>
            <img class="header-avatar" id="h-avatar" src="" style="width:36px;height:36px;border-radius:50%">
        </div>
    </header>

    <div class="content">
        <section id="tab-market" class="tab active">
            <div style="display:flex;gap:10px;margin-bottom:15px">
                <input type="text" id="f-search" placeholder="🔍 Поиск...">
                <select id="f-cat" style="width:80px"><option value="all">Все</option><option value="BOT">🤖</option><option value="WEB">🌐</option><option value="SCRIPT">📜</option></select>
            </div>
            <div id="grid" class="grid"></div>
        </section>

        <section id="tab-favs" class="tab">
            <h2>❤️ Избранное</h2>
            <div id="favs-grid" class="grid" style="margin-top:15px"></div>
        </section>

        <section id="tab-profile" class="tab">
            <div style="text-align:center;margin-bottom:20px">
                <img id="p-avatar" src="" style="width:100px;height:100px;border-radius:50%;border:4px solid var(--accent)">
                <h2 id="p-name" style="margin-top:10px"></h2>
                <p id="p-bio" style="color:var(--dim)"></p>
            </div>
            <div style="background:var(--card);padding:15px;border-radius:12px;margin-bottom:15px">
                <h3>✏️ Профиль</h3>
                <input type="text" id="e-name" placeholder="Имя">
                <textarea id="e-bio" rows="2" placeholder="О себе"></textarea>
                <button class="btn btn-primary" onclick="saveProfile()">Сохранить</button>
            </div>
             <div style="background:var(--card);padding:15px;border-radius:12px;margin-bottom:15px">
                <h3>💬 Чаты</h3>
                <div id="user-chats-list"></div>
            </div>
            <div style="background:var(--card);padding:15px;border-radius:12px;margin-bottom:15px">
                <h3>📦 Мои покупки</h3>
                <div id="owned-list" style="margin-top:10px"></div>
            </div>
            <button class="btn btn-secondary" onclick="logout()">🚪 Выйти</button>
        </section>

        <section id="tab-wallet" class="tab">
            <div style="background:linear-gradient(135deg,var(--accent),#a855f7);padding:20px;border-radius:16px;text-align:center;margin-bottom:20px">
                <div style="font-size:12px;opacity:0.8">Ваш баланс</div>
                <div class="amount" id="w-bal" style="font-size:32px;font-weight:800">0 ₽</div>
            </div>
            <div style="background:var(--card);padding:20px;border-radius:16px;margin-bottom:20px">
                <h3>Пополнить</h3>
                <input type="number" id="custom-amount" placeholder="Сумма (мин. 10₽)" min="10">
                <button class="btn btn-success" onclick="pay()">Оплатить через ЮMoney</button>
            </div>
            <div id="tx-history"></div>
        </section>

        <section id="tab-upload" class="tab">
            <div style="background:var(--card);padding:20px;border-radius:16px">
                <h2 style="margin-bottom:20px">Новый товар</h2>
                <input type="text" id="u-title" placeholder="Название">
                <select id="u-cat"><option value="BOT">Бот</option><option value="WEB">Сайт</option><option value="SCRIPT">Скрипт</option></select>
                <input type="number" id="u-price" placeholder="Цена (₽)">
                <textarea id="u-desc" rows="4" placeholder="Описание"></textarea>
                <div style="border:2px dashed var(--border);padding:20px;text-align:center;border-radius:10px;margin-bottom:15px;cursor:pointer" onclick="document.getElementById('u-file').click()">
                    📁 Выбрать файл
                </div>
                <input type="file" id="u-file" hidden>
                <button class="btn btn-primary" onclick="publish()">Опубликовать</button>
            </div>
        </section>
    </div>

    <nav class="nav">
        <a href="#" class="active" data-tab="market"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>Маркет</a>
        <a href="#" data-tab="favs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg></a>
        <a href="#" data-tab="upload"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></a>
        <a href="#" data-tab="wallet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg></a>
        <a href="#" data-tab="profile"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"/><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/></svg></a>
    </nav>
</div>

<script>
let user = null;
let token = localStorage.getItem('token');
const $ = id => document.getElementById(id);
const toast = m => { const t=$('toast'); t.innerText=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2000); };
const headers = () => ({ 'Content-Type': 'application/json', 'Authorization': token });

// --- AUTH ---
function switchAuth(type, btn) {
    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('auth-' + type).classList.add('active');
    document.querySelectorAll('.auth-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

async function loginPassword() {
    const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('login-username').value, password: $('login-password').value })
    });
    const d = await r.json();
    if(d.error) return toast(d.error);
    user = d.user;
    token = d.token;
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('token', token);
    initApp();
}

async function startReg() {
    const r = await fetch('/api/auth/register/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            username: $('reg-username').value, 
            password: $('reg-password').value,
            confirmPassword: $('reg-password2').value 
        })
    });
    const d = await r.json();
    if(d.error) return toast(d.error);
    $('reg-step1').classList.add('hidden');
    $('reg-step2').classList.remove('hidden');
    $('reg-bot-link').href = d.botLink;
}

async function confirmReg() {
    const r = await fetch('/api/auth/register/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: $('reg-code').value })
    });
    const d = await r.json();
    if(d.error) return toast(d.error);
    user = d.user;
    token = d.token;
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('token', token);
    initApp();
}

function logout() {
    localStorage.clear();
    location.reload();
}

function initApp() {
    $('auth').classList.add('hidden');
    $('app').classList.remove('hidden');
    updateUI();
    loadMarket();
}

function updateUI() {
    if(!user) return;
    $('h-balance').innerText = user.balance + ' ₽';
    $('h-avatar').src = user.avatar;
}

// --- MARKET ---
async function loadMarket() {
    const q = $('f-search').value;
    const cat = $('f-cat').value;
    const r = await fetch('/api/products?search='+q+'&category='+cat);
    const prods = await r.json();
    let favs = [];
    try {
        favs = await fetch('/api/favorites/'+user.username).then(r=>r.json()).then(l=>l.map(x=>x.id));
    } catch(e){}
    
    // Используем обычные кавычки для генерации HTML, чтобы избежать SyntaxError в Node.js
    $('grid').innerHTML = prods.map(p => {
        const isFav = favs.includes(p.id) ? 'active' : '';
        return '<div class="card" onclick="openProduct(\\'' + p.id + '\\')">' +
               '<div class="card-img" style="background-image:url(\\'' + p.preview + '\\')">' +
               '<span class="card-cat">' + p.category + '</span>' +
               '<button class="card-fav ' + isFav + '" onclick="event.stopPropagation();toggleFav(\\'' + p.id + '\\')">♥</button>' +
               '</div><div class="card-body"><h3>' + p.title + '</h3>' +
               '<div class="card-footer"><span class="price">' + p.price + ' ₽</span>' +
               '<button class="btn btn-primary" style="padding:5px 10px;font-size:12px" onclick="event.stopPropagation();buy(\\'' + p.id + '\\')">Купить</button>' +
               '</div></div></div>';
    }).join('');
}

async function toggleFav(id) {
    await fetch('/api/favorite', { method: 'POST', headers: headers(), body: JSON.stringify({ productId: id }) });
    if($('tab-favs').classList.contains('active')) loadFavs();
    else loadMarket();
}

async function loadFavs() {
    const r = await fetch('/api/favorites/'+user.username);
    const prods = await r.json();
    $('favs-grid').innerHTML = prods.map(p => 
        '<div class="card" onclick="openProduct(\\'' + p.id + '\\')">' +
        '<div class="card-img" style="background-image:url(\\'' + p.preview + '\\')"></div>' +
        '<div class="card-body"><h3>' + p.title + '</h3></div></div>'
    ).join('');
}

async function buy(id) {
    if(!confirm('Купить товар?')) return;
    const r = await fetch('/api/buy', { method: 'POST', headers: headers(), body: JSON.stringify({ productId: id }) });
    const d = await r.json();
    if(d.error) return toast(d.error);
    user.balance = d.balance;
    updateUI();
    toast('Успешно куплено!');
}

async function openProduct(id) {
    const p = await fetch('/api/products/' + id).then(r => r.json());
    const comments = await fetch('/api/comments/' + id).then(r => r.json());
    
    const div = document.createElement('div');
    div.className = 'modal-overlay';
    
    // Генерация комментариев
    const commentsHTML = comments.map(c => 
        '<div style="background:var(--card2);padding:8px;border-radius:8px;margin-bottom:5px"><b style="font-size:12px">' + c.username + '</b><div style="font-size:13px">' + c.text + '</div></div>'
    ).join('');

    div.innerHTML = 
        '<div class="product-window">' +
            '<h2>' + p.title + '</h2>' +
            '<div style="color:var(--dim);margin-bottom:10px">' + p.category + ' • ' + p.downloads + ' скачиваний</div>' +
            '<p>' + p.description + '</p>' +
            '<h3 style="color:var(--green);margin:15px 0">' + p.price + ' ₽</h3>' +
            '<div style="display:flex;gap:10px;margin-bottom:20px">' +
                '<button class="btn btn-primary" onclick="buy(\\'' + p.id + '\\')">Купить</button>' +
                '<button class="btn btn-secondary" onclick="startChat(\\'' + p.sellerId + '\\')">Написать продавцу</button>' +
            '</div>' +
            '<hr style="border-color:var(--border);margin-bottom:15px">' +
            '<h4>Отзывы</h4>' +
            '<div style="max-height:150px;overflow-y:auto;margin-bottom:10px">' + commentsHTML + '</div>' +
            '<div style="display:flex;gap:5px">' +
                '<input id="new-comment" placeholder="Ваш отзыв..." style="margin:0">' +
                '<button class="btn btn-primary" onclick="postComment(\\'' + p.id + '\\')" style="width:auto">></button>' +
            '</div>' +
            '<button class="btn btn-secondary" style="margin-top:10px;width:100%" onclick="this.closest(\\\'.modal-overlay\\\').remove()">Закрыть</button>' +
        '</div>';
    document.body.appendChild(div);
}

async function postComment(id) {
    const text = document.getElementById('new-comment').value;
    if(!text) return;
    await fetch('/api/comments/add', { method: 'POST', headers: headers(), body: JSON.stringify({ productId: id, text }) });
    document.querySelector('.modal-overlay').remove(); 
    openProduct(id);
}

async function publish() {
    const fd = new FormData();
    fd.append('title', $('u-title').value);
    fd.append('category', $('u-cat').value);
    fd.append('price', $('u-price').value);
    fd.append('description', $('u-desc').value);
    fd.append('file', $('u-file').files[0]);
    
    const r = await fetch('/api/publish', { 
        method: 'POST', 
        headers: { 'Authorization': token }, 
        body: fd 
    });
    if(r.ok) {
        toast('Товар опубликован');
        $('u-title').value = '';
        $('u-desc').value = '';
        $('u-price').value = '';
        document.querySelector('[data-tab="market"]').click();
    } else {
        toast('Ошибка');
    }
}

// --- PROFILE & WALLET ---
async function loadProfile() {
    const r = await fetch('/api/user/' + user.username);
    const d = await r.json();
    $('p-name').innerText = d.displayName;
    $('p-avatar').src = d.avatar;
    $('p-bio').innerText = d.bio || '';
    $('e-name').value = d.displayName;
    $('e-bio').value = d.bio || '';
    
    $('owned-list').innerHTML = d.ownedProducts.map(p => 
        '<div style="background:var(--card2);padding:10px;border-radius:8px;margin-bottom:5px;display:flex;justify-content:space-between;align-items:center">' +
            '<span>' + p.title + '</span>' +
            '<a href="/api/download/' + p.id + '?username=' + user.username + '" target="_blank">📥</a>' +
        '</div>'
    ).join('') || '<div style="color:var(--dim);text-align:center">Пусто</div>';

    loadChats();
}

async function saveProfile() {
    await fetch('/api/profile', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ displayName: $('e-name').value, bio: $('e-bio').value })
    });
    toast('Сохранено');
    loadProfile();
}

async function loadWallet() {
    const r = await fetch('/api/me', { headers: headers() });
    const d = await r.json();
    $('w-bal').innerText = d.balance + ' ₽';
    $('tx-history').innerHTML = d.transactions.map(t => 
        '<div style="padding:10px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;font-size:13px">' +
            '<span>' + t.desc + '</span>' +
            '<span style="color:' + (t.amount>0?'var(--green)':'var(--red)') + '">' + t.amount + ' ₽</span>' +
        '</div>'
    ).join('');
}

async function pay() {
    const amt = $('custom-amount').value;
    const r = await fetch('/api/payment/create', { method: 'POST', headers: headers(), body: JSON.stringify({ amount: amt }) });
    const d = await r.json();
    if(d.error) return toast(d.error);
    window.open(d.paymentUrl, '_blank');
}

// --- CHATS ---
async function loadChats() {
    const r = await fetch('/api/chats/list', { headers: headers() });
    const chats = await r.json();
    $('user-chats-list').innerHTML = chats.map(c => 
        '<div class="chat-preview" onclick="openChatModal(\\'' + c.id + '\\')">' +
            '<img src="' + c.partner.avatar + '" style="width:30px;height:30px;border-radius:50%">' +
            '<div><div>' + c.partner.username + '</div>' +
            '<div style="font-size:11px;color:var(--dim)">' + (c.lastMessage ? c.lastMessage.text.substring(0,20)+'...' : 'Начните общение') + '</div>' +
            '</div></div>'
    ).join('') || '<div style="text-align:center;font-size:12px;color:var(--dim)">Нет чатов</div>';
}

async function startChat(targetUserId) {
    if(targetUserId === user.id) return toast('Это вы');
    const r = await fetch('/api/chats/create', { method: 'POST', headers: headers(), body: JSON.stringify({ targetUserId }) });
    const d = await r.json();
    if(document.querySelector('.modal-overlay')) document.querySelector('.modal-overlay').remove();
    document.querySelector('[data-tab="profile"]').click();
    openChatModal(d.chat.id);
}

async function openChatModal(chatId) {
    const div = document.createElement('div');
    div.className = 'modal-overlay';
    div.innerHTML = 
        '<div class="chat-window">' +
            '<h3 id="chat-header">Чат</h3>' +
            '<div class="chat-messages" id="chat-msgs">Загрузка...</div>' +
            '<div style="display:flex;gap:5px">' +
                '<input id="chat-input" placeholder="Сообщение..." style="margin:0">' +
                '<button class="btn btn-primary" style="width:auto" onclick="sendMsg(\\'' + chatId + '\\')">></button>' +
            '</div>' +
            '<button class="btn btn-secondary" style="margin-top:10px;width:100%" onclick="this.closest(\\\'.modal-overlay\\\').remove()">Закрыть</button>' +
        '</div>';
    document.body.appendChild(div);
    refreshChat(chatId);
}

async function refreshChat(chatId) {
    const r = await fetch('/api/chats/detail/' + chatId, { headers: headers() });
    if(!r.ok) return;
    const d = await r.json();
    document.getElementById('chat-header').innerText = 'Чат с ' + d.partnerUsername;
    const msgs = document.getElementById('chat-msgs');
    if(msgs) {
        msgs.innerHTML = d.messages.map(m => 
            '<div class="message ' + (m.senderId === user.id ? 'sent' : 'received') + '">' + m.text + '</div>'
        ).join('');
        msgs.scrollTop = msgs.scrollHeight;
    }
}

async function sendMsg(chatId) {
    const txt = document.getElementById('chat-input');
    if(!txt.value) return;
    await fetch('/api/chats/send', { method: 'POST', headers: headers(), body: JSON.stringify({ chatId, text: txt.value }) });
    txt.value = '';
    refreshChat(chatId);
}

// --- INIT ---
$('f-search').oninput = loadMarket;
$('f-cat').onchange = loadMarket;

document.querySelectorAll('.nav a').forEach(a => {
    a.onclick = e => {
        e.preventDefault();
        document.querySelectorAll('.nav a').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        a.classList.add('active');
        $('tab-' + a.dataset.tab).classList.add('active');
        
        if(a.dataset.tab === 'market') loadMarket();
        if(a.dataset.tab === 'favs') loadFavs();
        if(a.dataset.tab === 'profile') loadProfile();
        if(a.dataset.tab === 'wallet') loadWallet();
    }
});

if(token && localStorage.getItem('user')) {
    user = JSON.parse(localStorage.getItem('user'));
    initApp();
}
</script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(HTML));

app.listen(PORT, async () => {
    console.log('Server started on port', PORT);
    try {
        await fetch(TELEGRAM_API + '/setWebhook?url=' + DOMAIN + WEBHOOK_PATH);
    } catch (e) {}
});

process.on('SIGINT', () => { saveDB(); process.exit(); });
process.on('SIGTERM', () => { saveDB(); process.exit(); });
