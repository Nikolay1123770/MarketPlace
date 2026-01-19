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

// Коды авторизации
const authCodes = new Map();        // Для входа через TG
const registerCodes = new Map();    // Для подтверждения регистрации
const pendingRegistrations = new Map(); // Ожидающие регистрации

// Хеширование пароля
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// ═══════════════════════════════════════════════════════════
// TELEGRAM WEBHOOK
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
                parse_mode: 'Markdown',
                ...options
            })
        });
    } catch (e) {
        console.error('Telegram error:', e.message);
    }
}

app.post(WEBHOOK_PATH, (req, res) => {
    const { message, callback_query } = req.body;
    
    // Обработка callback кнопок
    if (callback_query) {
        const chatId = callback_query.message.chat.id;
        const data = callback_query.data;
        const from = callback_query.from;
        
        if (data.startsWith('confirm_reg_')) {
            const regId = data.replace('confirm_reg_', '');
            const pending = pendingRegistrations.get(regId);
            
            if (pending) {
                // Генерируем код подтверждения
                const code = Math.random().toString(36).substring(2, 8).toUpperCase();
                
                registerCodes.set(code, {
                    regId: regId,
                    telegramId: from.id,
                    username: pending.username,
                    passwordHash: pending.passwordHash,
                    firstName: from.first_name,
                    createdAt: Date.now()
                });
                
                // Удаляем через 10 минут
                setTimeout(() => registerCodes.delete(code), 10 * 60 * 1000);
                
                sendMessage(chatId,
                    `✅ *Подтверждение регистрации*\n\n` +
                    `👤 Аккаунт: *${pending.username}*\n\n` +
                    `🔐 Ваш код подтверждения:\n\n` +
                    `\`${code}\`\n\n` +
                    `📋 Скопируйте код и вставьте на сайте\n\n` +
                    `⏱ Код действует 10 минут`
                );
                
                // Ответ на callback
                fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: callback_query.id,
                        text: 'Код отправлен!'
                    })
                });
            } else {
                fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: callback_query.id,
                        text: 'Регистрация устарела. Начните заново.',
                        show_alert: true
                    })
                });
            }
        }
        
        return res.sendStatus(200);
    }
    
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text;
    const from = message.from;

    if (text === '/start') {
        sendMessage(chatId,
            `👋 Привет, *${from.first_name}*!\n\n` +
            `🛒 *CodeVault Marketplace*\n\n` +
            `Команды:\n` +
            `/login — Код для входа\n` +
            `/balance — Баланс\n` +
            `/site — Открыть сайт\n\n` +
            `🌐 ${DOMAIN}`
        );
    }
    else if (text === '/login') {
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        authCodes.set(code, {
            telegramId: from.id,
            username: from.username || `user_${from.id}`,
            firstName: from.first_name,
            createdAt: Date.now()
        });

        setTimeout(() => authCodes.delete(code), 5 * 60 * 1000);

        sendMessage(chatId,
            `🔐 *Код для входа:*\n\n\`${code}\`\n\n⏱ Действует 5 минут\n\n🌐 ${DOMAIN}`
        );
    }
    else if (text === '/balance') {
        const user = users.find(u => u.telegramId === from.id);
        if (user) {
            sendMessage(chatId,
                `💰 *Баланс:* ${user.balance} ₽\n📦 Товаров: ${user.myProducts.length}\n🛒 Покупок: ${user.inventory.length}`
            );
        } else {
            sendMessage(chatId, `❌ Вы не зарегистрированы\n\nИспользуйте /login или зарегистрируйтесь на сайте`);
        }
    }
    else if (text === '/site') {
        sendMessage(chatId, `🌐 *CodeVault*\n\n${DOMAIN}`, {
            reply_markup: { inline_keyboard: [[{ text: '🛒 Открыть', url: DOMAIN }]] }
        });
    }
    else if (text === '/help') {
        sendMessage(chatId,
            `📚 *Команды:*\n\n/login — Код входа\n/balance — Баланс\n/site — Сайт\n/help — Справка`
        );
    }

    res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════

// Вход через код Telegram (быстрый вход)
app.post('/api/auth/telegram', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Код не указан' });
    
    const auth = authCodes.get(code.toUpperCase());
    if (!auth) return res.status(401).json({ error: 'Неверный или устаревший код' });
    
    authCodes.delete(code.toUpperCase());
    
    let user = users.find(u => u.telegramId === auth.telegramId);
    if (!user) {
        // Создаём пользователя без пароля (только TG вход)
        user = createUser(auth.username, auth.telegramId, auth.firstName, null);
        sendMessage(auth.telegramId, `✅ Вы вошли!\n💰 Баланс: ${user.balance} ₽`);
    }
    res.json({ user, token: user.id });
});

// Вход по логину и паролю
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
        return res.status(401).json({ error: 'Аккаунт без пароля. Войдите через Telegram' });
    }
    
    if (user.passwordHash !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный пароль' });
    }
    
    res.json({ user, token: user.id });
});

// Шаг 1: Запрос на регистрацию (генерирует ссылку на бота)
app.post('/api/auth/register/start', (req, res) => {
    const { username, password, confirmPassword } = req.body;
    
    // Валидация
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
    
    // Проверка существующего пользователя
    const existing = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existing) {
        return res.status(400).json({ error: 'Этот логин уже занят' });
    }
    
    // Создаём pending регистрацию
    const regId = crypto.randomBytes(16).toString('hex');
    
    pendingRegistrations.set(regId, {
        username: username.trim(),
        passwordHash: hashPassword(password),
        createdAt: Date.now()
    });
    
    // Удаляем через 15 минут
    setTimeout(() => pendingRegistrations.delete(regId), 15 * 60 * 1000);
    
    // Формируем ссылку на бота с deep link
    const botUsername = 'CodeVault_Shop_bot'; // Замените на username вашего бота
    const botLink = `https://t.me/${botUsername}?start=reg_${regId}`;
    
    res.json({ 
        success: true, 
        regId: regId,
        botLink: botLink,
        message: 'Перейдите в бота для подтверждения'
    });
});

// Обработка deep link от бота
app.post(WEBHOOK_PATH.replace('/webhook/', '/webhook-check/'), (req, res) => {
    res.sendStatus(200);
});

// Обновляем обработчик /start для deep link
const originalWebhook = app._router.stack.find(r => r.route && r.route.path === WEBHOOK_PATH);

app.post(WEBHOOK_PATH, (req, res) => {
    const { message, callback_query } = req.body;
    
    // Обработка callback кнопок
    if (callback_query) {
        const chatId = callback_query.message.chat.id;
        const data = callback_query.data;
        const from = callback_query.from;
        
        if (data.startsWith('confirm_reg_')) {
            const regId = data.replace('confirm_reg_', '');
            const pending = pendingRegistrations.get(regId);
            
            if (pending) {
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
                
                sendMessage(chatId,
                    `✅ *Код подтверждения регистрации*\n\n` +
                    `👤 Аккаунт: *${pending.username}*\n\n` +
                    `🔐 Ваш код:\n\n\`${code}\`\n\n` +
                    `📋 Скопируйте и вставьте на сайте\n\n` +
                    `⏱ Действует 10 минут`
                );
                
                fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: callback_query.id,
                        text: 'Код отправлен!'
                    })
                });
            } else {
                fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: callback_query.id,
                        text: 'Регистрация устарела',
                        show_alert: true
                    })
                });
            }
        }
        
        return res.sendStatus(200);
    }
    
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text;
    const from = message.from;

    // Обработка deep link регистрации
    if (text.startsWith('/start reg_')) {
        const regId = text.replace('/start reg_', '');
        const pending = pendingRegistrations.get(regId);
        
        if (pending) {
            // Проверяем, не привязан ли уже этот TG к другому аккаунту
            const existingTg = users.find(u => u.telegramId === from.id);
            if (existingTg) {
                sendMessage(chatId,
                    `⚠️ *Telegram уже привязан*\n\n` +
                    `Этот Telegram привязан к аккаунту *${existingTg.username}*\n\n` +
                    `Войдите через /login или используйте другой Telegram`
                );
                return res.sendStatus(200);
            }
            
            sendMessage(chatId,
                `📝 *Подтверждение регистрации*\n\n` +
                `Вы регистрируете аккаунт:\n` +
                `👤 *${pending.username}*\n\n` +
                `Нажмите кнопку ниже, чтобы получить код подтверждения:`,
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Получить код подтверждения', callback_data: `confirm_reg_${regId}` }
                        ]]
                    }
                }
            );
        } else {
            sendMessage(chatId,
                `❌ *Ссылка устарела*\n\n` +
                `Регистрация не найдена или истекла.\n` +
                `Начните регистрацию заново на сайте.\n\n` +
                `🌐 ${DOMAIN}`
            );
        }
        return res.sendStatus(200);
    }

    if (text === '/start') {
        sendMessage(chatId,
            `👋 Привет, *${from.first_name}*!\n\n` +
            `🛒 *CodeVault Marketplace*\n\n` +
            `Команды:\n` +
            `/login — Код для входа\n` +
            `/balance — Баланс\n` +
            `/site — Открыть сайт\n\n` +
            `🌐 ${DOMAIN}`
        );
    }
    else if (text === '/login') {
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        authCodes.set(code, {
            telegramId: from.id,
            username: from.username || `user_${from.id}`,
            firstName: from.first_name,
            createdAt: Date.now()
        });

        setTimeout(() => authCodes.delete(code), 5 * 60 * 1000);

        sendMessage(chatId,
            `🔐 *Код для входа:*\n\n\`${code}\`\n\n⏱ Действует 5 минут\n\n🌐 ${DOMAIN}`
        );
    }
    else if (text === '/balance') {
        const user = users.find(u => u.telegramId === from.id);
        if (user) {
            sendMessage(chatId,
                `💰 *Баланс:* ${user.balance} ₽\n📦 Товаров: ${user.myProducts.length}\n🛒 Покупок: ${user.inventory.length}`
            );
        } else {
            sendMessage(chatId, `❌ Вы не зарегистрированы\n\nЗарегистрируйтесь на сайте: ${DOMAIN}`);
        }
    }
    else if (text === '/site') {
        sendMessage(chatId, `🌐 *CodeVault*\n\n${DOMAIN}`, {
            reply_markup: { inline_keyboard: [[{ text: '🛒 Открыть', url: DOMAIN }]] }
        });
    }
    else if (text === '/help') {
        sendMessage(chatId,
            `📚 *Команды:*\n\n/login — Код входа\n/balance — Баланс\n/site — Сайт\n/help — Справка`
        );
    }

    res.sendStatus(200);
});

// Шаг 2: Подтверждение регистрации кодом
app.post('/api/auth/register/confirm', (req, res) => {
    const { code } = req.body;
    
    if (!code) {
        return res.status(400).json({ error: 'Введите код подтверждения' });
    }
    
    const regData = registerCodes.get(code.toUpperCase());
    
    if (!regData) {
        return res.status(401).json({ error: 'Неверный или устаревший код' });
    }
    
    // Удаляем использованные данные
    registerCodes.delete(code.toUpperCase());
    pendingRegistrations.delete(regData.regId);
    
    // Проверяем ещё раз на дубликаты
    const existingUser = users.find(u => u.username.toLowerCase() === regData.username.toLowerCase());
    if (existingUser) {
        return res.status(400).json({ error: 'Логин уже занят' });
    }
    
    const existingTg = users.find(u => u.telegramId === regData.telegramId);
    if (existingTg) {
        return res.status(400).json({ error: 'Telegram уже привязан к другому аккаунту' });
    }
    
    // Создаём пользователя
    const user = createUser(regData.username, regData.telegramId, regData.firstName, regData.passwordHash);
    
    // Уведомляем в Telegram
    sendMessage(regData.telegramId,
        `🎉 *Регистрация завершена!*\n\n` +
        `👤 Логин: *${user.username}*\n` +
        `💰 Баланс: *${user.balance} ₽*\n\n` +
        `Теперь вы можете входить по логину и паролю или через Telegram!\n\n` +
        `🌐 ${DOMAIN}`
    );
    
    res.json({ user, token: user.id });
});

// Устаревший простой вход (оставляем для совместимости)
app.post('/api/auth', (req, res) => {
    const { username } = req.body;
    if (!username || !username.trim()) return res.status(400).json({ error: 'Нужен username' });
    
    let user = users.find(u => u.username.toLowerCase() === username.toLowerCase().trim());
    if (!user) user = createUser(username.trim(), null, username.trim(), null);
    res.json(user);
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
        balance: 5000,
        earned: 0,
        joined: new Date().toLocaleDateString('ru-RU'),
        inventory: [],
        myProducts: []
    };
    users.push(user);
    
    transactions.push({
        id: Date.now().toString(),
        userId: user.id,
        type: 'bonus',
        amount: 5000,
        desc: '🎁 Приветственный бонус',
        date: new Date().toISOString()
    });
    
    return user;
}

app.get('/api/user/:username', (req, res) => {
    const user = users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Not found' });

    const owned = user.inventory.map(id => products.find(p => p.id === id)).filter(Boolean);
    const sold = products.filter(p => p.sellerId === user.id);
    const tx = transactions.filter(t => t.userId === user.id).reverse().slice(0, 30);
    const favs = favorites.filter(f => f.userId === user.id).map(f => products.find(p => p.id === f.productId)).filter(Boolean);

    // Не отдаём passwordHash
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
    if (user.balance < product.price) return res.status(400).json({ error: 'Недостаточно средств' });
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
            userId: seller.id,
            type: 'sale',
            amount: product.price,
            desc: `Продажа: ${product.title}`,
            date: new Date().toISOString()
        });

        if (seller.telegramId) {
            sendMessage(seller.telegramId,
                `🎉 *Продажа!*\n\n📦 ${product.title}\n👤 ${user.displayName}\n💰 +${product.price} ₽\n\nБаланс: ${seller.balance} ₽`
            );
        }
    }

    transactions.push({
        id: (Date.now() + 1).toString(),
        userId: user.id,
        type: 'purchase',
        amount: -product.price,
        desc: `Покупка: ${product.title}`,
        date: new Date().toISOString()
    });

    res.json({ success: true, balance: user.balance });
});

app.post('/api/favorite', (req, res) => {
    const { username, productId } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const idx = favorites.findIndex(f => f.userId === user.id && f.productId === productId);
    if (idx > -1) {
        favorites.splice(idx, 1);
        res.json({ favorited: false });
    } else {
        favorites.push({ userId: user.id, productId: productId });
        res.json({ favorited: true });
    }
});

app.get('/api/favorites/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.json([]);
    res.json(favorites.filter(f => f.userId === user.id).map(f => products.find(p => p.id === f.productId)).filter(Boolean));
});

app.post('/api/topup', (req, res) => {
    const { username, amount } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const sum = Number(amount) || 1000;
    user.balance += sum;

    transactions.push({
        id: Date.now().toString(),
        userId: user.id,
        type: 'deposit',
        amount: sum,
        desc: 'Пополнение',
        date: new Date().toISOString()
    });

    res.json({ success: true, balance: user.balance });
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
<title>CodeVault</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0a0f;--card:#14141f;--border:#252535;--text:#e8e8e8;--dim:#707080;--accent:#6366f1;--green:#22c55e;--red:#ef4444}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.hidden{display:none!important}
button{cursor:pointer;font-family:inherit;border:none}
input,textarea,select{font-family:inherit;width:100%;background:var(--bg);border:1px solid var(--border);padding:12px;color:#fff;border-radius:8px;margin-bottom:12px}
input:focus,textarea:focus{outline:none;border-color:var(--accent)}

.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--card);border:1px solid var(--accent);padding:12px 24px;border-radius:8px;opacity:0;transition:.3s;z-index:999}
.toast.show{transform:translateX(-50%) translateY(0);opacity:1}

#auth{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100}
.auth-box{width:100%;max-width:400px;text-align:center}
.auth-box h1{font-size:2rem;color:var(--accent);margin-bottom:8px}
.auth-box>p{color:var(--dim);margin-bottom:24px}
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tabs button{flex:1;padding:10px;background:var(--card);color:var(--dim);border-radius:8px;font-size:13px}
.tabs button.active{background:var(--accent);color:#fff}
.auth-panel{display:none}
.auth-panel.active{display:block}
.steps{text-align:left;margin-bottom:16px}
.step{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:14px}
.step b{color:var(--accent)}
.step a{color:var(--accent)}
.code-input{text-align:center;font-size:1.5rem;letter-spacing:6px;text-transform:uppercase}
.btn{padding:12px 20px;border-radius:8px;font-weight:600}
.btn-main{background:var(--accent);color:#fff;width:100%}
.btn-main:hover{opacity:.9}
.btn-secondary{background:var(--card);color:var(--text);width:100%;border:1px solid var(--border)}
.btn-green{background:var(--green);color:#fff;width:100%}
.divider{display:flex;align-items:center;gap:12px;margin:16px 0;color:var(--dim);font-size:13px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
.reg-step{margin-bottom:20px}
.reg-step h3{font-size:14px;color:var(--accent);margin-bottom:12px;text-align:left}
.input-group{position:relative}
.input-group label{position:absolute;left:12px;top:-8px;background:var(--bg);padding:0 4px;font-size:11px;color:var(--dim)}
.info-box{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px;text-align:left;font-size:13px}
.info-box.success{border-color:var(--green);background:rgba(34,197,94,0.1)}
.info-box.warning{border-color:var(--accent);background:rgba(99,102,241,0.1)}
.back-link{color:var(--accent);font-size:13px;cursor:pointer;margin-top:12px;display:inline-block}

.app{display:flex;flex-direction:column;min-height:100vh}
.header{background:var(--card);padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50}
.header h1{font-size:1.25rem;color:var(--accent)}
.user{display:flex;align-items:center;gap:10px;font-size:14px}
.user img{width:32px;height:32px;border-radius:50%}
.user span{color:var(--green);font-weight:600}

.content{flex:1;padding:16px}
.tab{display:none}
.tab.active{display:block;animation:fade .3s}
@keyframes fade{from{opacity:0}to{opacity:1}}

.nav{display:flex;background:var(--card);border-top:1px solid var(--border);position:fixed;bottom:0;left:0;right:0;z-index:50}
.nav a{flex:1;padding:12px 8px;text-align:center;color:var(--dim);text-decoration:none;font-size:11px;display:flex;flex-direction:column;align-items:center;gap:4px}
.nav a svg{width:22px;height:22px}
.nav a.active{color:var(--accent)}

.filters{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filters input{flex:1;min-width:150px;margin:0}
.filters select{width:auto;min-width:100px;margin:0}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;padding-bottom:80px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.card-img{height:100px;background-size:cover;background-position:center;position:relative}
.card-cat{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.7);padding:2px 6px;border-radius:4px;font-size:10px}
.card-fav{position:absolute;top:6px;right:6px;width:28px;height:28px;background:rgba(0,0,0,.6);border-radius:50%;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center}
.card-fav.active{color:var(--red)}
.card-body{padding:10px}
.card-body h3{font-size:14px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-body p{font-size:11px;color:var(--dim);margin-bottom:8px;height:28px;overflow:hidden}
.card-footer{display:flex;justify-content:space-between;align-items:center}
.price{font-size:14px;font-weight:700;color:var(--green)}
.card-footer .btn{padding:6px 12px;font-size:12px}

.profile-head{background:var(--card);padding:20px;border-radius:12px;text-align:center;margin-bottom:16px}
.profile-head img{width:80px;height:80px;border-radius:50%;border:3px solid var(--accent);margin-bottom:12px}
.profile-head h2{margin-bottom:4px}
.profile-head p{color:var(--dim);font-size:13px;margin-bottom:16px}
.stats{display:flex;justify-content:center;gap:24px}
.stat{text-align:center}
.stat b{display:block;font-size:1.25rem;color:var(--accent)}
.stat span{font-size:11px;color:var(--dim)}

.section{background:var(--card);padding:16px;border-radius:12px;margin-bottom:16px}
.section h3{margin-bottom:12px;font-size:15px}
.mini-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.mini-card{background:var(--bg);padding:12px;border-radius:8px;border:1px solid var(--border)}
.mini-card h4{font-size:13px;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mini-card .btn{width:100%;padding:8px;font-size:12px}

.wallet-card{background:linear-gradient(135deg,var(--accent),#a855f7);padding:24px;border-radius:12px;text-align:center;margin-bottom:16px}
.wallet-card small{opacity:.8}
.wallet-card .amount{font-size:2.5rem;font-weight:800}
.wallet-card .btns{display:flex;gap:8px;justify-content:center;margin-top:16px}
.wallet-card .btn{background:rgba(255,255,255,.2);color:#fff;padding:10px 16px}
.tx-list{background:var(--card);border-radius:12px;overflow:hidden}
.tx{display:flex;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);font-size:13px}
.tx:last-child{border:none}
.tx-plus{color:var(--green)}
.tx-minus{color:var(--red)}

.upload-box{background:var(--card);padding:20px;border-radius:12px}
.upload-box h2{margin-bottom:16px}
.row{display:flex;gap:8px}
.row>*{flex:1}
.file-area{border:2px dashed var(--border);padding:24px;text-align:center;border-radius:8px;color:var(--dim);margin-bottom:12px}

.loading{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<div class="toast" id="toast"></div>

<div id="auth">
<div class="auth-box">
<h1>🛒 CodeVault</h1>
<p>Маркетплейс цифровых товаров</p>

<div class="tabs">
<button class="active" onclick="switchAuth('login', this)">Вход</button>
<button onclick="switchAuth('register', this)">Регистрация</button>
<button onclick="switchAuth('tg', this)">Telegram</button>
</div>

<!-- ВХОД ПО ЛОГИНУ/ПАРОЛЮ -->
<div id="auth-login" class="auth-panel active">
<input type="text" id="login-username" placeholder="Логин">
<input type="password" id="login-password" placeholder="Пароль">
<button class="btn btn-main" onclick="loginPassword()">Войти</button>
<div class="divider">или</div>
<p style="font-size:13px;color:var(--dim)">Нет аккаунта? Переключитесь на вкладку "Регистрация"</p>
</div>

<!-- РЕГИСТРАЦИЯ -->
<div id="auth-register" class="auth-panel">

<!-- Шаг 1: Ввод данных -->
<div id="reg-step1" class="reg-step">
<h3>📝 Шаг 1: Данные аккаунта</h3>
<input type="text" id="reg-username" placeholder="Придумайте логин" maxlength="20">
<input type="password" id="reg-password" placeholder="Придумайте пароль">
<input type="password" id="reg-password2" placeholder="Повторите пароль">
<button class="btn btn-main" onclick="startRegistration()">Получить код подтверждения</button>
</div>

<!-- Шаг 2: Переход в бота -->
<div id="reg-step2" class="reg-step hidden">
<h3>📱 Шаг 2: Подтверждение в Telegram</h3>
<div class="info-box warning">
<b>👤 Логин:</b> <span id="reg-show-username"></span><br><br>
Нажмите кнопку ниже, чтобы перейти в Telegram-бота и получить код подтверждения.
</div>
<a id="reg-bot-link" href="#" target="_blank">
<button class="btn btn-green">🤖 Открыть Telegram-бота</button>
</a>
<div class="divider">после получения кода</div>
<button class="btn btn-secondary" onclick="showStep3()">У меня есть код →</button>
<span class="back-link" onclick="backToStep1()">← Назад</span>
</div>

<!-- Шаг 3: Ввод кода -->
<div id="reg-step3" class="reg-step hidden">
<h3>🔐 Шаг 3: Введите код</h3>
<div class="info-box success">
Введите 6-значный код, который вы получили в Telegram-боте
</div>
<input type="text" id="reg-code" class="code-input" placeholder="XXXXXX" maxlength="6">
<button class="btn btn-main" onclick="confirmRegistration()">Подтвердить регистрацию</button>
<span class="back-link" onclick="showStep2()">← Назад к боту</span>
</div>

</div>

<!-- ВХОД ЧЕРЕЗ TELEGRAM КОД -->
<div id="auth-tg" class="auth-panel">
<div class="steps">
<div class="step"><b>1.</b> Откройте бота в Telegram</div>
<div class="step"><b>2.</b> Отправьте команду /login</div>
<div class="step"><b>3.</b> Введите полученный код ниже</div>
</div>
<input type="text" id="tg-code" class="code-input" placeholder="XXXXXX" maxlength="6">
<button class="btn btn-main" onclick="loginTG()">Войти</button>
<div class="divider">бот</div>
<a href="https://t.me/CodeVault_Shop_bot" target="_blank">
<button class="btn btn-secondary">🤖 Открыть бота</button>
</a>
</div>

</div>
</div>

<div id="app" class="app hidden">
<header class="header">
<h1>CodeVault</h1>
<div class="user">
<span id="h-balance">0₽</span>
<img id="h-avatar" src="">
</div>
</header>

<div class="content">
<section id="tab-market" class="tab active">
<div class="filters">
<input type="text" id="f-search" placeholder="Поиск...">
<select id="f-cat"><option value="all">Все</option><option>BOT</option><option>WEB</option><option>SCRIPT</option></select>
<select id="f-sort"><option value="newest">Новые</option><option value="popular">Популярные</option><option value="price-low">Дешевле</option></select>
</div>
<div id="grid" class="grid"></div>
</section>

<section id="tab-favs" class="tab">
<h2 style="margin-bottom:16px">Избранное</h2>
<div id="favs-grid" class="grid"></div>
</section>

<section id="tab-profile" class="tab">
<div class="profile-head">
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
<h3>Редактировать</h3>
<input type="text" id="e-name" placeholder="Имя">
<textarea id="e-bio" rows="2" placeholder="О себе"></textarea>
<button class="btn btn-main" onclick="saveProfile()">Сохранить</button>
</div>
<div class="section">
<h3>Мои покупки</h3>
<div id="owned" class="mini-grid"></div>
</div>
<div class="section">
<button class="btn btn-secondary" onclick="logout()">🚪 Выйти из аккаунта</button>
</div>
</section>

<section id="tab-wallet" class="tab">
<div class="wallet-card">
<small>Баланс</small>
<div class="amount" id="w-bal">0 ₽</div>
<div class="btns">
<button class="btn" onclick="topUp(1000)">+1K</button>
<button class="btn" onclick="topUp(5000)">+5K</button>
<button class="btn" onclick="topUp(10000)">+10K</button>
</div>
</div>
<h3 style="margin-bottom:12px">История</h3>
<div class="tx-list" id="tx"></div>
</section>

<section id="tab-upload" class="tab">
<div class="upload-box">
<h2>Новый товар</h2>
<input type="text" id="u-title" placeholder="Название">
<div class="row">
<select id="u-cat"><option>BOT</option><option>WEB</option><option>SCRIPT</option><option>API</option></select>
<input type="number" id="u-price" placeholder="Цена">
</div>
<textarea id="u-desc" rows="3" placeholder="Описание"></textarea>
<div class="file-area" onclick="document.getElementById('u-file').click()">📁 Выбрать файл</div>
<input type="file" id="u-file" hidden>
<button class="btn btn-main" onclick="publish()">Опубликовать</button>
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
let pendingRegId = null;

const $ = id => document.getElementById(id);
const toast = m => {
    const t = $('toast');
    t.textContent = m;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
};
const fmt = n => new Intl.NumberFormat('ru-RU').format(n) + '₽';
const esc = s => {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
};

// Переключение вкладок авторизации
function switchAuth(m, btn) {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    $('auth-' + m).classList.add('active');
    
    // Сброс шагов регистрации
    if (m === 'register') {
        showStep1();
    }
}

// ═══════════════════════════════════════════════════════════
// РЕГИСТРАЦИЯ
// ═══════════════════════════════════════════════════════════

function showStep1() {
    $('reg-step1').classList.remove('hidden');
    $('reg-step2').classList.add('hidden');
    $('reg-step3').classList.add('hidden');
}

function showStep2() {
    $('reg-step1').classList.add('hidden');
    $('reg-step2').classList.remove('hidden');
    $('reg-step3').classList.add('hidden');
}

function showStep3() {
    $('reg-step1').classList.add('hidden');
    $('reg-step2').classList.add('hidden');
    $('reg-step3').classList.remove('hidden');
    $('reg-code').focus();
}

function backToStep1() {
    showStep1();
    pendingRegId = null;
}

async function startRegistration() {
    const username = $('reg-username').value.trim();
    const password = $('reg-password').value;
    const password2 = $('reg-password2').value;
    
    if (!username) return toast('Введите логин');
    if (!password) return toast('Введите пароль');
    if (!password2) return toast('Подтвердите пароль');
    
    try {
        const res = await fetch('/api/auth/register/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                username, 
                password, 
                confirmPassword: password2 
            })
        });
        
        const data = await res.json();
        
        if (!res.ok) {
            return toast(data.error);
        }
        
        pendingRegId = data.regId;
        $('reg-show-username').textContent = username;
        $('reg-bot-link').href = data.botLink;
        
        showStep2();
        toast('Перейдите в бота!');
        
    } catch (e) {
        toast('Ошибка сети');
    }
}

async function confirmRegistration() {
    const code = $('reg-code').value.trim().toUpperCase();
    
    if (!code) return toast('Введите код');
    if (code.length !== 6) return toast('Код должен быть 6 символов');
    
    try {
        const res = await fetch('/api/auth/register/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        
        const data = await res.json();
        
        if (!res.ok) {
            return toast(data.error);
        }
        
        user = data.user;
        localStorage.setItem('user', JSON.stringify(user));
        onLogin();
        toast('🎉 Регистрация успешна!');
        
    } catch (e) {
        toast('Ошибка сети');
    }
}

// ═══════════════════════════════════════════════════════════
// ВХОД
// ═══════════════════════════════════════════════════════════

async function loginPassword() {
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    
    if (!username) return toast('Введите логин');
    if (!password) return toast('Введите пароль');
    
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await res.json();
        
        if (!res.ok) {
            return toast(data.error);
        }
        
        user = data.user;
        localStorage.setItem('user', JSON.stringify(user));
        onLogin();
        
    } catch (e) {
        toast('Ошибка сети');
    }
}

async function loginTG() {
    const code = $('tg-code').value.trim();
    if (!code) return toast('Введи код');
    
    const res = await fetch('/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
    });
    
    if (!res.ok) {
        const d = await res.json();
        return toast(d.error);
    }
    
    const data = await res.json();
    user = data.user;
    localStorage.setItem('user', JSON.stringify(user));
    onLogin();
}

function onLogin() {
    $('auth').classList.add('hidden');
    $('app').classList.remove('hidden');
    updateUI();
    loadMarket();
    toast('Привет, ' + user.displayName + '!');
}

function logout() {
    if (!confirm('Выйти из аккаунта?')) return;
    user = null;
    localStorage.removeItem('user');
    $('auth').classList.remove('hidden');
    $('app').classList.add('hidden');
    // Сброс форм
    $('login-username').value = '';
    $('login-password').value = '';
    $('tg-code').value = '';
    $('reg-username').value = '';
    $('reg-password').value = '';
    $('reg-password2').value = '';
    $('reg-code').value = '';
    showStep1();
    toast('Вы вышли');
}

// Автовход при загрузке
(function checkSavedUser() {
    const saved = localStorage.getItem('user');
    if (saved) {
        try {
            user = JSON.parse(saved);
            onLogin();
        } catch (e) {
            localStorage.removeItem('user');
        }
    }
})();

function updateUI() {
    $('h-avatar').src = user.avatar;
    $('h-balance').textContent = fmt(user.balance);
}

// ═══════════════════════════════════════════════════════════
// НАВИГАЦИЯ
// ═══════════════════════════════════════════════════════════

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

['f-search', 'f-cat', 'f-sort'].forEach(id => {
    $(id).addEventListener('input', loadMarket);
    $(id).addEventListener('change', loadMarket);
});

// ═══════════════════════════════════════════════════════════
// МАРКЕТ
// ═══════════════════════════════════════════════════════════

async function loadMarket() {
    const search = $('f-search').value;
    const cat = $('f-cat').value;
    const sort = $('f-sort').value;
    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (cat !== 'all') params.append('category', cat);
    params.append('sort', sort);

    const [prods, favs] = await Promise.all([
        fetch('/api/products?' + params).then(r => r.json()),
        fetch('/api/favorites/' + user.username).then(r => r.json())
    ]);
    favIds = favs.map(f => f.id);

    $('grid').innerHTML = prods.length === 0 
        ? '<p style="color:var(--dim)">Пусто</p>' 
        : prods.map(p => renderCard(p)).join('');
}

function renderCard(p) {
    const isFav = favIds.includes(p.id);
    return '<div class="card">' +
        '<div class="card-img" style="background-image:url(' + p.preview + ')">' +
        '<span class="card-cat">' + p.category + '</span>' +
        '<button class="card-fav ' + (isFav ? 'active' : '') + '" onclick="event.stopPropagation();toggleFav(\\'' + p.id + '\\',this)">♥</button>' +
        '</div>' +
        '<div class="card-body">' +
        '<h3>' + esc(p.title) + '</h3>' +
        '<p>' + esc(p.description || '') + '</p>' +
        '<div class="card-footer">' +
        '<span class="price">' + fmt(p.price) + '</span>' +
        '<button class="btn btn-main" onclick="buy(\\'' + p.id + '\\')">Купить</button>' +
        '</div></div></div>';
}

async function buy(id) {
    if (!confirm('Купить?')) return;
    const res = await fetch('/api/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username, productId: id })
    });
    const d = await res.json();
    if (res.ok) {
        user.balance = d.balance;
        updateUI();
        toast('Куплено!');
        loadMarket();
    } else {
        toast(d.error);
    }
}

async function toggleFav(id, btn) {
    const res = await fetch('/api/favorite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username, productId: id })
    });
    const d = await res.json();
    btn.classList.toggle('active', d.favorited);
    if (d.favorited) favIds.push(id);
    else favIds = favIds.filter(x => x !== id);
}

async function loadFavs() {
    const favs = await fetch('/api/favorites/' + user.username).then(r => r.json());
    favIds = favs.map(f => f.id);
    $('favs-grid').innerHTML = favs.length === 0 
        ? '<p style="color:var(--dim)">Пусто</p>' 
        : favs.map(p => renderCard(p)).join('');
}

// ═══════════════════════════════════════════════════════════
// ПРОФИЛЬ
// ═══════════════════════════════════════════════════════════

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

    $('owned').innerHTML = data.ownedProducts.length === 0 
        ? '<p style="color:var(--dim)">Пусто</p>' 
        : data.ownedProducts.map(p =>
            '<div class="mini-card"><h4>' + esc(p.title) + '</h4><a href="/api/download/' + p.id + '?username=' + user.username + '" class="btn btn-main">Скачать</a></div>'
        ).join('');
}

async function saveProfile() {
    await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: user.username,
            displayName: $('e-name').value,
            bio: $('e-bio').value
        })
    });
    toast('Сохранено!');
    loadProfile();
}

// ═══════════════════════════════════════════════════════════
// КОШЕЛЁК
// ═══════════════════════════════════════════════════════════

async function loadWallet() {
    const data = await fetch('/api/user/' + user.username).then(r => r.json());
    user.balance = data.balance;
    updateUI();
    $('w-bal').textContent = fmt(data.balance);

    $('tx').innerHTML = data.transactions.length === 0 
        ? '<p style="padding:16px;color:var(--dim)">Нет операций</p>' 
        : data.transactions.map(t =>
            '<div class="tx"><div><b>' + t.desc + '</b><br><small>' + new Date(t.date).toLocaleString('ru-RU') + '</small></div><span class="' + (t.amount > 0 ? 'tx-plus' : 'tx-minus') + '">' + (t.amount > 0 ? '+' : '') + fmt(t.amount) + '</span></div>'
        ).join('');
}

async function topUp(amount) {
    const res = await fetch('/api/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username, amount })
    });
    const d = await res.json();
    user.balance = d.balance;
    updateUI();
    loadWallet();
    toast('+' + fmt(amount));
}

// ═══════════════════════════════════════════════════════════
// ПУБЛИКАЦИЯ
// ═══════════════════════════════════════════════════════════

async function publish() {
    const title = $('u-title').value.trim();
    const price = $('u-price').value;
    const desc = $('u-desc').value.trim();
    const cat = $('u-cat').value;
    const file = $('u-file').files[0];
    if (!title || !price || !desc) return toast('Заполни все поля');

    const fd = new FormData();
    fd.append('username', user.username);
    fd.append('title', title);
    fd.append('price', price);
    fd.append('description', desc);
    fd.append('category', cat);
    if (file) fd.append('file', file);

    const res = await fetch('/api/publish', { method: 'POST', body: fd });
    if (res.ok) {
        toast('Опубликовано!');
        $('u-title').value = '';
        $('u-price').value = '';
        $('u-desc').value = '';
        $('u-file').value = '';
        document.querySelector('[data-tab="market"]').click();
    }
}
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));

// ═══════════════════════════════════════════════════════════
// ЗАПУСК
// ═══════════════════════════════════════════════════════════
app.listen(PORT, async () => {
    console.log('CodeVault started on port ' + PORT);

    try {
        const webhookUrl = DOMAIN + WEBHOOK_PATH;
        const res = await fetch(TELEGRAM_API + '/setWebhook?url=' + webhookUrl);
        const data = await res.json();
        console.log('Webhook:', data.ok ? 'OK' : 'FAIL', data.description || '');
    } catch (e) {
        console.log('Webhook error:', e.message);
    }
});
