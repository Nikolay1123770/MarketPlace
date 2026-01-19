const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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
const authCodes = new Map();

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
    const { message } = req.body;
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
            sendMessage(chatId, `❌ Вы не зарегистрированы\n\nИспользуйте /login`);
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

app.post('/api/auth/telegram', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Код не указан' });
    
    const auth = authCodes.get(code.toUpperCase());
    if (!auth) return res.status(401).json({ error: 'Неверный код' });
    
    authCodes.delete(code.toUpperCase());
    
    let user = users.find(u => u.telegramId === auth.telegramId);
    if (!user) {
        user = createUser(auth.username, auth.telegramId, auth.firstName);
        sendMessage(auth.telegramId, `✅ Вы вошли!\n💰 Баланс: ${user.balance} ₽`);
    }
    res.json(user);
});

app.post('/api/auth', (req, res) => {
    const { username } = req.body;
    if (!username || !username.trim()) return res.status(400).json({ error: 'Нужен username' });
    
    let user = users.find(u => u.username.toLowerCase() === username.toLowerCase().trim());
    if (!user) user = createUser(username.trim(), null, username.trim());
    res.json(user);
});

function createUser(username, telegramId, displayName) {
    const user = {
        id: Date.now().toString(),
        telegramId: telegramId,
        username: username,
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

    res.json({
        ...user,
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
.auth-box{width:100%;max-width:360px;text-align:center}
.auth-box h1{font-size:2rem;color:var(--accent);margin-bottom:8px}
.auth-box>p{color:var(--dim);margin-bottom:24px}
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tabs button{flex:1;padding:10px;background:var(--card);color:var(--dim);border-radius:8px}
.tabs button.active{background:var(--accent);color:#fff}
.auth-panel{display:none}
.auth-panel.active{display:block}
.steps{text-align:left;margin-bottom:16px}
.step{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:14px}
.step b{color:var(--accent)}
.step a{color:var(--accent)}
#tg-code{text-align:center;font-size:1.5rem;letter-spacing:6px;text-transform:uppercase}
.btn{padding:12px 20px;border-radius:8px;font-weight:600}
.btn-main{background:var(--accent);color:#fff;width:100%}
.btn-main:hover{opacity:.9}

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
</style>
</head>
<body>

<div class="toast" id="toast"></div>

<div id="auth">
<div class="auth-box">
<h1>CodeVault</h1>
<p>Маркетплейс цифровых товаров</p>
<div class="tabs">
<button class="active" onclick="switchAuth('tg')">Telegram</button>
<button onclick="switchAuth('login')">Логин</button>
</div>
<div id="auth-tg" class="auth-panel active">
<div class="steps">
<div class="step"><b>1.</b> Открой бота в Telegram</div>
<div class="step"><b>2.</b> Отправь /login</div>
<div class="step"><b>3.</b> Введи код ниже</div>
</div>
<input type="text" id="tg-code" placeholder="XXXXXX" maxlength="6">
<button class="btn btn-main" onclick="loginTG()">Войти</button>
</div>
<div id="auth-login" class="auth-panel">
<input type="text" id="login-name" placeholder="Ваш никнейм">
<button class="btn btn-main" onclick="loginName()">Войти</button>
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
let user=null,favIds=[];
const $=id=>document.getElementById(id);
const toast=m=>{const t=$('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)};
const fmt=n=>new Intl.NumberFormat('ru-RU').format(n)+'₽';
const esc=s=>{const d=document.createElement('div');d.textContent=s;return d.innerHTML};

function switchAuth(m){
document.querySelectorAll('.tabs button').forEach(b=>b.classList.remove('active'));
event.target.classList.add('active');
document.querySelectorAll('.auth-panel').forEach(p=>p.classList.remove('active'));
$('auth-'+m).classList.add('active');
}

async function loginTG(){
const code=$('tg-code').value.trim();
if(!code)return toast('Введи код');
const res=await fetch('/api/auth/telegram',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
if(!res.ok){const d=await res.json();return toast(d.error);}
user=await res.json();onLogin();
}

async function loginName(){
const name=$('login-name').value.trim();
if(!name)return toast('Введи имя');
const res=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name})});
user=await res.json();onLogin();
}

function onLogin(){
$('auth').classList.add('hidden');
$('app').classList.remove('hidden');
updateUI();loadMarket();
toast('Привет, '+user.displayName+'!');
}

function updateUI(){
$('h-avatar').src=user.avatar;
$('h-balance').textContent=fmt(user.balance);
}

document.querySelectorAll('.nav a').forEach(a=>{
a.onclick=e=>{
e.preventDefault();
document.querySelectorAll('.nav a').forEach(x=>x.classList.remove('active'));
document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
a.classList.add('active');
$('tab-'+a.dataset.tab).classList.add('active');
if(a.dataset.tab==='market')loadMarket();
if(a.dataset.tab==='favs')loadFavs();
if(a.dataset.tab==='profile')loadProfile();
if(a.dataset.tab==='wallet')loadWallet();
}});

['f-search','f-cat','f-sort'].forEach(id=>{
$(id).addEventListener('input',loadMarket);
$(id).addEventListener('change',loadMarket);
});

async function loadMarket(){
const search=$('f-search').value;
const cat=$('f-cat').value;
const sort=$('f-sort').value;
const params=new URLSearchParams();
if(search)params.append('search',search);
if(cat!=='all')params.append('category',cat);
params.append('sort',sort);

const[prods,favs]=await Promise.all([
fetch('/api/products?'+params).then(r=>r.json()),
fetch('/api/favorites/'+user.username).then(r=>r.json())
]);
favIds=favs.map(f=>f.id);

$('grid').innerHTML=prods.length===0?'<p style="color:var(--dim)">Пусто</p>':prods.map(p=>renderCard(p)).join('');
}

function renderCard(p){
const isFav=favIds.includes(p.id);
return '<div class="card">'+
'<div class="card-img" style="background-image:url('+p.preview+')">'+
'<span class="card-cat">'+p.category+'</span>'+
'<button class="card-fav '+(isFav?'active':'')+'" onclick="event.stopPropagation();toggleFav(\\''+p.id+'\\',this)">♥</button>'+
'</div>'+
'<div class="card-body">'+
'<h3>'+esc(p.title)+'</h3>'+
'<p>'+esc(p.description||'')+'</p>'+
'<div class="card-footer">'+
'<span class="price">'+fmt(p.price)+'</span>'+
'<button class="btn btn-main" onclick="buy(\\''+p.id+'\\')">Купить</button>'+
'</div></div></div>';
}

async function buy(id){
if(!confirm('Купить?'))return;
const res=await fetch('/api/buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.username,productId:id})});
const d=await res.json();
if(res.ok){user.balance=d.balance;updateUI();toast('Куплено!');loadMarket();}
else toast(d.error);
}

async function toggleFav(id,btn){
const res=await fetch('/api/favorite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.username,productId:id})});
const d=await res.json();
btn.classList.toggle('active',d.favorited);
if(d.favorited)favIds.push(id);else favIds=favIds.filter(x=>x!==id);
}

async function loadFavs(){
const favs=await fetch('/api/favorites/'+user.username).then(r=>r.json());
favIds=favs.map(f=>f.id);
$('favs-grid').innerHTML=favs.length===0?'<p style="color:var(--dim)">Пусто</p>':favs.map(p=>renderCard(p)).join('');
}

async function loadProfile(){
const data=await fetch('/api/user/'+user.username).then(r=>r.json());
user={...user,...data};updateUI();

$('p-avatar').src=data.avatar;
$('p-name').textContent=data.displayName;
$('p-bio').textContent=data.bio;
$('s-products').textContent=data.stats.products;
$('s-sales').textContent=data.stats.sales;
$('s-earned').textContent=fmt(data.stats.earned);
$('e-name').value=data.displayName;
$('e-bio').value=data.bio;

$('owned').innerHTML=data.ownedProducts.length===0?'<p style="color:var(--dim)">Пусто</p>':data.ownedProducts.map(p=>
'<div class="mini-card"><h4>'+esc(p.title)+'</h4><a href="/api/download/'+p.id+'?username='+user.username+'" class="btn btn-main">Скачать</a></div>'
).join('');
}

async function saveProfile(){
await fetch('/api/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.username,displayName:$('e-name').value,bio:$('e-bio').value})});
toast('Сохранено!');loadProfile();
}

async function loadWallet(){
const data=await fetch('/api/user/'+user.username).then(r=>r.json());
user.balance=data.balance;updateUI();
$('w-bal').textContent=fmt(data.balance);

$('tx').innerHTML=data.transactions.length===0?'<p style="padding:16px;color:var(--dim)">Нет операций</p>':data.transactions.map(t=>
'<div class="tx"><div><b>'+t.desc+'</b><br><small>'+new Date(t.date).toLocaleString('ru-RU')+'</small></div><span class="'+(t.amount>0?'tx-plus':'tx-minus')+'">'+(t.amount>0?'+':'')+fmt(t.amount)+'</span></div>'
).join('');
}

async function topUp(amount){
const res=await fetch('/api/topup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.username,amount})});
const d=await res.json();
user.balance=d.balance;updateUI();loadWallet();
toast('+'+fmt(amount));
}

async function publish(){
const title=$('u-title').value.trim();
const price=$('u-price').value;
const desc=$('u-desc').value.trim();
const cat=$('u-cat').value;
const file=$('u-file').files[0];
if(!title||!price||!desc)return toast('Заполни все поля');

const fd=new FormData();
fd.append('username',user.username);
fd.append('title',title);
fd.append('price',price);
fd.append('description',desc);
fd.append('category',cat);
if(file)fd.append('file',file);

const res=await fetch('/api/publish',{method:'POST',body:fd});
if(res.ok){
toast('Опубликовано!');
$('u-title').value='';$('u-price').value='';$('u-desc').value='';$('u-file').value='';
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

    if (BOT_TOKEN && BOT_TOKEN !== '8035930401:AAH4bICwB8LVXApFEIaLmOlsYD9PyO5sylI') {
        try {
            const webhookUrl = DOMAIN + WEBHOOK_PATH;
            const res = await fetch(TELEGRAM_API + '/setWebhook?url=' + webhookUrl);
            const data = await res.json();
            console.log('Webhook:', data.ok ? 'OK' : 'FAIL');
        } catch (e) {
            console.log('Webhook error:', e.message);
        }
    }
});
