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

// Коды для регистрации
const registerCodes = new Map();
const pendingRegistrations = new Map();

// Хеширование пароля
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

async function editMessage(chatId, messageId, text, options = {}) {
    try {
        await fetch(`${TELEGRAM_API}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
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
// TELEGRAM WEBHOOK
// ═══════════════════════════════════════════════════════════
app.post(WEBHOOK_PATH, async (req, res) => {
    const { message, callback_query } = req.body;
    
    // Обработка callback кнопок
    if (callback_query) {
        const chatId = callback_query.message.chat.id;
        const messageId = callback_query.message.message_id;
        const data = callback_query.data;
        const from = callback_query.from;
        
        // Кнопка "Открыть сайт"
        if (data === 'open_site') {
            await answerCallback(callback_query.id, '🌐 Переход на сайт...');
        }
        
        // Кнопка "Мой баланс"
        else if (data === 'my_balance') {
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
                                [{ text: '🌐 Открыть сайт', url: DOMAIN }],
                                [{ text: '◀️ Назад в меню', callback_data: 'main_menu' }]
                            ]
                        }
                    }
                );
            } else {
                await answerCallback(callback_query.id, '❌ Вы не зарегистрированы', true);
            }
        }
        
        // Кнопка "Помощь"
        else if (data === 'help') {
            await answerCallback(callback_query.id);
            await sendMessage(chatId,
                `📚 <b>Справка по боту</b>\n\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `🔐 <b>Регистрация:</b>\n` +
                `Зарегистрируйтесь на сайте, затем перейдите по ссылке из сайта в этого бота для подтверждения.\n\n` +
                `🔑 <b>Вход:</b>\n` +
                `Используйте логин и пароль на сайте.\n\n` +
                `🛒 <b>Покупки:</b>\n` +
                `Выбирайте товары на сайте и покупайте за баланс.\n\n` +
                `💰 <b>Продажи:</b>\n` +
                `Публикуйте свои товары и получайте уведомления о продажах.\n\n` +
                `━━━━━━━━━━━━━━━`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🌐 Перейти на сайт', url: DOMAIN }],
                            [{ text: '◀️ Назад в меню', callback_data: 'main_menu' }]
                        ]
                    }
                }
            );
        }
        
        // Кнопка "Главное меню"
        else if (data === 'main_menu') {
            await answerCallback(callback_query.id);
            const user = users.find(u => u.telegramId === from.id);
            await showMainMenu(chatId, from, user);
        }
        
        // Подтверждение регистрации
        else if (data.startsWith('confirm_reg_')) {
            const regId = data.replace('confirm_reg_', '');
            const pending = pendingRegistrations.get(regId);
            
            if (pending) {
                // Проверяем, не привязан ли уже этот TG
                const existingTg = users.find(u => u.telegramId === from.id);
                if (existingTg) {
                    await answerCallback(callback_query.id, '⚠️ Telegram уже привязан к аккаунту!', true);
                    return res.sendStatus(200);
                }
                
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
                
                await answerCallback(callback_query.id, '✅ Код создан!');
                
                await editMessage(chatId, messageId,
                    `✅ <b>Код подтверждения создан!</b>\n\n` +
                    `━━━━━━━━━━━━━━━\n\n` +
                    `👤 Аккаунт: <b>${pending.username}</b>\n\n` +
                    `🔐 Ваш код:\n\n` +
                    `<code>${code}</code>\n\n` +
                    `━━━━━━━━━━━━━━━\n\n` +
                    `📋 Скопируйте код (нажмите на него) и вставьте на сайте\n\n` +
                    `⏱ Код действует <b>10 минут</b>`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🌐 Открыть сайт', url: DOMAIN }]
                            ]
                        }
                    }
                );
            } else {
                await answerCallback(callback_query.id, '❌ Регистрация устарела. Начните заново.', true);
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
                await sendMessage(chatId,
                    `⚠️ <b>Telegram уже привязан!</b>\n\n` +
                    `Этот Telegram уже используется для аккаунта <b>${existingTg.username}</b>\n\n` +
                    `Используйте другой Telegram или войдите в существующий аккаунт.`,
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
                `Вы регистрируете аккаунт:\n\n` +
                `👤 Логин: <b>${pending.username}</b>\n\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `Нажмите кнопку ниже, чтобы получить код подтверждения:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ Получить код подтверждения', callback_data: `confirm_reg_${regId}` }],
                            [{ text: '❌ Отмена', callback_data: 'main_menu' }]
                        ]
                    }
                }
            );
        } else {
            await sendMessage(chatId,
                `❌ <b>Ссылка устарела</b>\n\n` +
                `Регистрация не найдена или истекла.\n\n` +
                `Начните регистрацию заново на сайте.`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🌐 Перейти на сайт', url: DOMAIN }],
                            [{ text: '◀️ Главное меню', callback_data: 'main_menu' }]
                        ]
                    }
                }
            );
        }
        return res.sendStatus(200);
    }

    // Команда /start
    if (text === '/start') {
        const user = users.find(u => u.telegramId === from.id);
        await showMainMenu(chatId, from, user);
    }
    
    // Команда /help
    else if (text === '/help') {
        await sendMessage(chatId,
            `📚 <b>Справка по боту</b>\n\n` +
            `━━━━━━━━━━━━━━━\n\n` +
            `🔐 <b>Регистрация:</b>\n` +
            `Зарегистрируйтесь на сайте, затем подтвердите через бота.\n\n` +
            `🔑 <b>Вход:</b>\n` +
            `Используйте логин и пароль на сайте.\n\n` +
            `━━━━━━━━━━━━━━━`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🌐 Перейти на сайт', url: DOMAIN }],
                        [{ text: '◀️ Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }
        );
    }
    
    // Команда /balance
    else if (text === '/balance') {
        const user = users.find(u => u.telegramId === from.id);
        if (user) {
            await sendMessage(chatId,
                `💰 <b>Ваш баланс:</b> ${user.balance.toLocaleString()} ₽\n\n` +
                `📦 Товаров: ${user.myProducts.length}\n` +
                `🛒 Покупок: ${user.inventory.length}`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🌐 Открыть сайт', url: DOMAIN }]
                        ]
                    }
                }
            );
        } else {
            await sendMessage(chatId, `❌ Вы не зарегистрированы\n\nЗарегистрируйтесь на сайте: ${DOMAIN}`);
        }
    }

    res.sendStatus(200);
});

// Показать главное меню
async function showMainMenu(chatId, from, user) {
    if (user) {
        // Пользователь зарегистрирован
        await sendMessage(chatId,
            `🎉 <b>Добро пожаловать, ${from.first_name}!</b>\n\n` +
            `━━━━━━━━━━━━━━━\n\n` +
            `🛒 <b>CodeVault Marketplace</b>\n\n` +
            `Маркетплейс цифровых товаров:\n` +
            `боты, скрипты, веб-приложения и API\n\n` +
            `━━━━━━━━━━━━━━━\n\n` +
            `💰 Ваш баланс: <b>${user.balance.toLocaleString()} ₽</b>\n` +
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
        // Пользователь не зарегистрирован
        await sendMessage(chatId,
            `👋 <b>Привет, ${from.first_name}!</b>\n\n` +
            `━━━━━━━━━━━━━━━\n\n` +
            `🛒 <b>CodeVault Marketplace</b>\n\n` +
            `Маркетплейс цифровых товаров:\n` +
            `• 🤖 Telegram-боты\n` +
            `• 🌐 Веб-приложения\n` +
            `• 📜 Скрипты и утилиты\n` +
            `• 🔌 API и интеграции\n\n` +
            `━━━━━━━━━━━━━━━\n\n` +
            `📝 Зарегистрируйтесь на сайте, чтобы:\n` +
            `• Покупать и продавать товары\n` +
            `• Получать уведомления о продажах\n` +
            `• Отслеживать баланс`,
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
// API
// ═══════════════════════════════════════════════════════════

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
        return res.status(401).json({ error: 'Установите пароль через регистрацию' });
    }
    
    if (user.passwordHash !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный пароль' });
    }
    
    // Убираем passwordHash из ответа
    const { passwordHash, ...safeUser } = user;
    res.json({ user: safeUser, token: user.id });
});

// Шаг 1: Запрос на регистрацию
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
    const botLink = `https://t.me/${BOT_USERNAME}?start=reg_${regId}`;
    
    res.json({ 
        success: true, 
        regId: regId,
        botLink: botLink,
        message: 'Перейдите в бота для подтверждения'
    });
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
        `🎉 <b>Регистрация завершена!</b>\n\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `👤 Логин: <b>${user.username}</b>\n` +
        `💰 Баланс: <b>${user.balance.toLocaleString()} ₽</b>\n\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `Теперь вы можете покупать и продавать товары!`,
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
        bio: 'Новый участник маркетплейса',
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
                `🎉 <b>Новая продажа!</b>\n\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `📦 <b>${product.title}</b>\n` +
                `👤 Покупатель: ${user.displayName}\n` +
                `💰 Получено: <b>+${product.price.toLocaleString()} ₽</b>\n\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `💳 Новый баланс: <b>${seller.balance.toLocaleString()} ₽</b>`,
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
        desc: 'Пополнение баланса',
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

/* AUTH SCREEN */
#auth{position:fixed;inset:0;background:linear-gradient(135deg,#0a0a0f 0%,#12121a 100%);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100}
.auth-container{width:100%;max-width:420px}
.auth-logo{text-align:center;margin-bottom:32px}
.auth-logo h1{font-size:2.5rem;font-weight:800;background:linear-gradient(135deg,var(--accent),#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}
.auth-logo p{color:var(--dim);font-size:14px}

.auth-box{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,0.3)}

.auth-tabs{display:flex;gap:8px;margin-bottom:24px;background:var(--bg);padding:4px;border-radius:10px}
.auth-tabs button{flex:1;padding:12px;background:transparent;color:var(--dim);border-radius:8px;font-size:14px;font-weight:600;transition:all .2s}
.auth-tabs button.active{background:var(--accent);color:#fff}
.auth-tabs button:hover:not(.active){color:var(--text)}

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
.btn-secondary:hover{border-color:var(--accent);color:var(--accent)}
.btn-success{background:linear-gradient(135deg,var(--green),#16a34a);color:#fff}
.btn-success:hover{transform:translateY(-2px);box-shadow:0 10px 20px rgba(34,197,94,0.3)}

.divider{display:flex;align-items:center;gap:16px;margin:20px 0;color:var(--dim);font-size:13px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}

/* Registration Steps */
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
.info-card h4{font-size:14px;margin-bottom:8px;display:flex;align-items:center;gap:8px}
.info-card p{font-size:13px;color:var(--dim);line-height:1.5}
.info-card .username{color:var(--accent);font-weight:600}

.code-input{text-align:center;font-size:24px;letter-spacing:8px;text-transform:uppercase;font-weight:700;padding:16px}

.back-link{color:var(--accent);font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;margin-top:16px}
.back-link:hover{text-decoration:underline}

/* MAIN APP */
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
.nav a{flex:1;padding:8px;text-align:center;color:var(--dim);text-decoration:none;font-size:11px;display:flex;flex-direction:column;align-items:center;gap:4px;transition:all .2s}
.nav a svg{width:24px;height:24px}
.nav a.active{color:var(--accent)}
.nav a.active svg{stroke:var(--accent)}

.filters{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
.filters input{flex:1;min-width:150px;margin:0}
.filters select{width:auto;min-width:110px;margin:0}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:all .2s}
.card:hover{transform:translateY(-4px);border-color:var(--accent);box-shadow:0 10px 30px rgba(99,102,241,0.1)}
.card-img{height:110px;background-size:cover;background-position:center;position:relative}
.card-cat{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);padding:4px 8px;border-radius:6px;font-size:10px;font-weight:600}
.card-fav{position:absolute;top:8px;right:8px;width:32px;height:32px;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);border-radius:50%;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .2s}
.card-fav:hover{background:var(--red)}
.card-fav.active{color:var(--red);background:rgba(239,68,68,0.2)}
.card-body{padding:12px}
.card-body h3{font-size:14px;font-weight:600;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-body p{font-size:12px;color:var(--dim);margin-bottom:10px;height:32px;overflow:hidden;line-height:1.4}
.card-footer{display:flex;justify-content:space-between;align-items:center}
.price{font-size:15px;font-weight:700;color:var(--green)}
.card-footer .btn{padding:8px 14px;font-size:12px;width:auto}

.profile-card{background:linear-gradient(135deg,var(--card) 0%,var(--card2) 100%);border:1px solid var(--border);padding:24px;border-radius:16px;text-align:center;margin-bottom:20px}
.profile-card img{width:90px;height:90px;border-radius:50%;border:4px solid var(--accent);margin-bottom:16px}
.profile-card h2{font-size:20px;margin-bottom:4px}
.profile-card p{color:var(--dim);font-size:13px;margin-bottom:20px}
.stats{display:flex;justify-content:center;gap:32px}
.stat{text-align:center}
.stat b{display:block;font-size:1.5rem;font-weight:800;color:var(--accent)}
.stat span{font-size:11px;color:var(--dim)}

.section{background:var(--card);border:1px solid var(--border);padding:20px;border-radius:14px;margin-bottom:16px}
.section h3{margin-bottom:16px;font-size:16px;font-weight:600}
.mini-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.mini-card{background:var(--card2);padding:14px;border-radius:10px;border:1px solid var(--border)}
.mini-card h4{font-size:13px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mini-card .btn{padding:10px}

.wallet-card{background:linear-gradient(135deg,var(--accent),#a855f7);padding:28px;border-radius:16px;text-align:center;margin-bottom:20px;position:relative;overflow:hidden}
.wallet-card::before{content:'';position:absolute;top:-50%;right:-50%;width:100%;height:100%;background:radial-gradient(circle,rgba(255,255,255,0.1) 0%,transparent 70%)}
.wallet-card small{opacity:.85;font-size:13px}
.wallet-card .amount{font-size:3rem;font-weight:800;margin:8px 0}
.wallet-card .btns{display:flex;gap:10px;justify-content:center;margin-top:20px}
.wallet-card .btn{background:rgba(255,255,255,.2);color:#fff;padding:12px 20px;width:auto;backdrop-filter:blur(4px)}
.wallet-card .btn:hover{background:rgba(255,255,255,.3)}

.tx-list{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.tx{display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);font-size:13px}
.tx:last-child{border:none}
.tx-info b{display:block;margin-bottom:2px}
.tx-info small{color:var(--dim)}
.tx-plus{color:var(--green);font-weight:700}
.tx-minus{color:var(--red);font-weight:700}

.upload-box{background:var(--card);border:1px solid var(--border);padding:24px;border-radius:16px}
.upload-box h2{margin-bottom:20px;font-size:18px}
.row{display:flex;gap:10px}
.row>*{flex:1}
.file-area{border:2px dashed var(--border);padding:28px;text-align:center;border-radius:10px;color:var(--dim);margin-bottom:16px;cursor:pointer;transition:all .2s}
.file-area:hover{border-color:var(--accent);color:var(--accent)}

.empty-state{text-align:center;padding:40px;color:var(--dim)}
.empty-state svg{width:48px;height:48px;margin-bottom:12px;opacity:0.5}
</style>
</head>
<body>

<div class="toast" id="toast"></div>

<!-- AUTH SCREEN -->
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

<!-- ВХОД -->
<div id="auth-login" class="auth-panel active">
<div class="form-group">
<label>Логин</label>
<input type="text" id="login-username" placeholder="Введите логин">
</div>
<div class="form-group">
<label>Пароль</label>
<input type="password" id="login-password" placeholder="Введите пароль">
</div>
<button class="btn btn-primary" onclick="loginPassword()">
<span>Войти в аккаунт</span>
</button>
<div class="divider">нет аккаунта?</div>
<button class="btn btn-secondary" onclick="switchToRegister()">Создать аккаунт</button>
</div>

<!-- РЕГИСТРАЦИЯ -->
<div id="auth-register" class="auth-panel">

<!-- Шаг 1 -->
<div id="reg-step1">
<div class="reg-header">
<h2>Создание аккаунта</h2>
<p>Шаг 1 из 3 — Данные для входа</p>
</div>
<div class="steps-indicator">
<div class="step-dot active"></div>
<div class="step-dot"></div>
<div class="step-dot"></div>
</div>
<div class="form-group">
<label>Придумайте логин</label>
<input type="text" id="reg-username" placeholder="Например: developer_pro" maxlength="20">
</div>
<div class="form-group">
<label>Придумайте пароль</label>
<input type="password" id="reg-password" placeholder="Минимум 4 символа">
</div>
<div class="form-group">
<label>Повторите пароль</label>
<input type="password" id="reg-password2" placeholder="Повторите пароль">
</div>
<button class="btn btn-primary" onclick="startRegistration()">Продолжить →</button>
</div>

<!-- Шаг 2 -->
<div id="reg-step2" class="hidden">
<div class="reg-header">
<h2>Подтверждение</h2>
<p>Шаг 2 из 3 — Переход в Telegram</p>
</div>
<div class="steps-indicator">
<div class="step-dot done"></div>
<div class="step-dot active"></div>
<div class="step-dot"></div>
</div>
<div class="info-card highlight">
<h4>👤 Ваш логин</h4>
<p class="username" id="reg-show-username"></p>
</div>
<div class="info-card">
<h4>📱 Что нужно сделать</h4>
<p>Нажмите кнопку ниже, чтобы перейти в Telegram-бота. Там вы получите код подтверждения для завершения регистрации.</p>
</div>
<a id="reg-bot-link" href="#" target="_blank">
<button class="btn btn-success">🤖 Открыть Telegram-бота</button>
</a>
<div class="divider">получили код?</div>
<button class="btn btn-secondary" onclick="showStep3()">У меня есть код →</button>
<span class="back-link" onclick="backToStep1()">← Изменить данные</span>
</div>

<!-- Шаг 3 -->
<div id="reg-step3" class="hidden">
<div class="reg-header">
<h2>Введите код</h2>
<p>Шаг 3 из 3 — Финальный шаг</p>
</div>
<div class="steps-indicator">
<div class="step-dot done"></div>
<div class="step-dot done"></div>
<div class="step-dot active"></div>
</div>
<div class="info-card success">
<h4>✅ Почти готово!</h4>
<p>Введите 6-значный код, который вы получили в Telegram-боте</p>
</div>
<div class="form-group">
<input type="text" id="reg-code" class="code-input" placeholder="XXXXXX" maxlength="6">
</div>
<button class="btn btn-primary" onclick="confirmRegistration()">🎉 Завершить регистрацию</button>
<span class="back-link" onclick="showStep2()">← Вернуться к боту</span>
</div>

</div>
</div>
</div>
</div>

<!-- MAIN APP -->
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
<input type="text" id="f-search" placeholder="🔍 Поиск товаров...">
<select id="f-cat">
<option value="all">Все категории</option>
<option value="BOT">🤖 Боты</option>
<option value="WEB">🌐 Веб</option>
<option value="SCRIPT">📜 Скрипты</option>
<option value="API">🔌 API</option>
</select>
<select id="f-sort">
<option value="newest">Новые</option>
<option value="popular">Популярные</option>
<option value="price-low">Дешевле</option>
<option value="price-high">Дороже</option>
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
<h3>✏️ Редактировать профиль</h3>
<input type="text" id="e-name" placeholder="Отображаемое имя">
<textarea id="e-bio" rows="2" placeholder="О себе"></textarea>
<button class="btn btn-primary" onclick="saveProfile()">Сохранить изменения</button>
</div>
<div class="section">
<h3>📦 Мои покупки</h3>
<div id="owned" class="mini-grid"></div>
</div>
<div class="section">
<button class="btn btn-secondary" onclick="logout()">🚪 Выйти из аккаунта</button>
</div>
</section>

<section id="tab-wallet" class="tab">
<div class="wallet-card">
<small>💳 Текущий баланс</small>
<div class="amount" id="w-bal">0 ₽</div>
<div class="btns">
<button class="btn" onclick="topUp(1000)">+1 000 ₽</button>
<button class="btn" onclick="topUp(5000)">+5 000 ₽</button>
<button class="btn" onclick="topUp(10000)">+10 000 ₽</button>
</div>
</div>
<h3 style="margin-bottom:14px">📋 История операций</h3>
<div class="tx-list" id="tx"></div>
</section>

<section id="tab-upload" class="tab">
<div class="upload-box">
<h2>📤 Новый товар</h2>
<div class="form-group">
<label>Название товара</label>
<input type="text" id="u-title" placeholder="Например: Telegram Bot для парсинга">
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
<textarea id="u-desc" rows="3" placeholder="Подробное описание вашего товара..."></textarea>
</div>
<div class="file-area" onclick="document.getElementById('u-file').click()">
📁 Нажмите чтобы выбрать файл
</div>
<input type="file" id="u-file" hidden>
<button class="btn btn-primary" onclick="publish()">🚀 Опубликовать товар</button>
</div>
</section>
</div>

<nav class="nav">
<a href="#" class="active" data-tab="market">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
Маркет
</a>
<a href="#" data-tab="favs">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
Избранное
</a>
<a href="#" data-tab="profile">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"/><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/></svg>
Профиль
</a>
<a href="#" data-tab="wallet">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
Кошелёк
</a>
<a href="#" data-tab="upload">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
Продать
</a>
</nav>
</div>

<script>
let user = null;
let favIds = [];

const $ = id => document.getElementById(id);
const toast = m => {
    const t = $('toast');
    t.textContent = m;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
};
const fmt = n => new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
const esc = s => {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
};

// ═══════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════

function switchAuth(m, btn) {
    document.querySelectorAll('.auth-tabs button').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    $('auth-' + m).classList.add('active');
    if (m === 'register') showStep1();
}

function switchToRegister() {
    document.querySelectorAll('.auth-tabs button')[1].click();
}

// Registration Steps
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
            body: JSON.stringify({ username, password, confirmPassword: password2 })
        });
        
        const data = await res.json();
        if (!res.ok) return toast(data.error);
        
        $('reg-show-username').textContent = username;
        $('reg-bot-link').href = data.botLink;
        
        showStep2();
        toast('Переходите в бота!');
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
        if (!res.ok) return toast(data.error);
        
        user = data.user;
        localStorage.setItem('user', JSON.stringify(user));
        onLogin();
        toast('🎉 Добро пожаловать!');
    } catch (e) {
        toast('Ошибка сети');
    }
}

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
        if (!res.ok) return toast(data.error);
        
        user = data.user;
        localStorage.setItem('user', JSON.stringify(user));
        onLogin();
    } catch (e) {
        toast('Ошибка сети');
    }
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
    location.reload();
}

// Auto login
(function() {
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
// NAVIGATION
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
// MARKET
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
        ? '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg><p>Товары не найдены</p></div>' 
        : prods.map(p => renderCard(p)).join('');
}

function renderCard(p) {
    const isFav = favIds.includes(p.id);
    const catIcons = { BOT: '🤖', WEB: '🌐', SCRIPT: '📜', API: '🔌' };
    return '<div class="card">' +
        '<div class="card-img" style="background-image:url(' + p.preview + ')">' +
        '<span class="card-cat">' + (catIcons[p.category] || '📦') + ' ' + p.category + '</span>' +
        '<button class="card-fav ' + (isFav ? 'active' : '') + '" onclick="event.stopPropagation();toggleFav(\\'' + p.id + '\\',this)">♥</button>' +
        '</div>' +
        '<div class="card-body">' +
        '<h3>' + esc(p.title) + '</h3>' +
        '<p>' + esc(p.description || 'Нет описания') + '</p>' +
        '<div class="card-footer">' +
        '<span class="price">' + fmt(p.price) + '</span>' +
        '<button class="btn btn-primary" onclick="buy(\\'' + p.id + '\\')">Купить</button>' +
        '</div></div></div>';
}

async function buy(id) {
    if (!confirm('Купить этот товар?')) return;
    const res = await fetch('/api/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username, productId: id })
    });
    const d = await res.json();
    if (res.ok) {
        user.balance = d.balance;
        updateUI();
        toast('✅ Товар куплен!');
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
        ? '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg><p>Нет избранных товаров</p></div>' 
        : favs.map(p => renderCard(p)).join('');
}

// ═══════════════════════════════════════════════════════════
// PROFILE
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
        ? '<div class="empty-state"><p>Нет покупок</p></div>' 
        : data.ownedProducts.map(p =>
            '<div class="mini-card"><h4>' + esc(p.title) + '</h4><a href="/api/download/' + p.id + '?username=' + user.username + '" class="btn btn-primary">📥 Скачать</a></div>'
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
    toast('✅ Сохранено!');
    loadProfile();
}

// ═══════════════════════════════════════════════════════════
// WALLET
// ═══════════════════════════════════════════════════════════

async function loadWallet() {
    const data = await fetch('/api/user/' + user.username).then(r => r.json());
    user.balance = data.balance;
    updateUI();
    $('w-bal').textContent = fmt(data.balance);

    $('tx').innerHTML = data.transactions.length === 0 
        ? '<div class="empty-state"><p>Нет операций</p></div>' 
        : data.transactions.map(t =>
            '<div class="tx"><div class="tx-info"><b>' + t.desc + '</b><small>' + new Date(t.date).toLocaleString('ru-RU') + '</small></div><span class="' + (t.amount > 0 ? 'tx-plus' : 'tx-minus') + '">' + (t.amount > 0 ? '+' : '') + fmt(t.amount) + '</span></div>'
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
    toast('✅ +' + fmt(amount));
}

// ═══════════════════════════════════════════════════════════
// PUBLISH
// ═══════════════════════════════════════════════════════════

async function publish() {
    const title = $('u-title').value.trim();
    const price = $('u-price').value;
    const desc = $('u-desc').value.trim();
    const cat = $('u-cat').value;
    const file = $('u-file').files[0];
    
    if (!title) return toast('Введите название');
    if (!price) return toast('Укажите цену');
    if (!desc) return toast('Добавьте описание');

    const fd = new FormData();
    fd.append('username', user.username);
    fd.append('title', title);
    fd.append('price', price);
    fd.append('description', desc);
    fd.append('category', cat);
    if (file) fd.append('file', file);

    const res = await fetch('/api/publish', { method: 'POST', body: fd });
    if (res.ok) {
        toast('🚀 Товар опубликован!');
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
    console.log('🚀 CodeVault started on port ' + PORT);

    try {
        const webhookUrl = DOMAIN + WEBHOOK_PATH;
        const res = await fetch(TELEGRAM_API + '/setWebhook?url=' + webhookUrl);
        const data = await res.json();
        console.log('📡 Webhook:', data.ok ? 'OK' : 'FAIL', data.description || '');
    } catch (e) {
        console.log('⚠️ Webhook error:', e.message);
    }
});
