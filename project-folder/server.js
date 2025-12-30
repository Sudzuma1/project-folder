const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Используем /data/ads.db на Render и ./ads.db локально
const dbPath = process.env.NODE_ENV === 'production' ? '/data/ads.db' : './ads.db';

// ВАЖНО: Устанавливаем секрет из переменных окружения
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'mysecret123';
if (ADMIN_SECRET === 'mysecret123') {
    console.warn('ВНИМАНИЕ: Используется небезопасный ADMIN_SECRET по умолчанию. Установите переменную окружения ADMIN_SECRET на Render!');
}


// Проверка, смонтирован ли диск на Render
if (process.env.NODE_ENV === 'production') {
    if (!fs.existsSync('/data')) {
        console.error('Persistent Disk /data не смонтирован. Проверьте настройки в Render.');
        process.exit(1);
    }
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к базе:', err);
        process.exit(1);
    } else {
        console.log('Подключено к базе данных:', dbPath);
    }
});

// Промисы для работы с SQLite
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ changes: this.changes, lastID: this.lastID });
    });
});

// Создание таблиц с проверкой и отладкой
async function initializeDatabase() {
    try {
        const rows = await dbAll('SELECT name FROM sqlite_master WHERE type="table" AND name IN ("ads", "promo_codes", "permanent_ads")');
        console.log('Найденные таблицы:', rows.map(row => row.name).join(', '));

        const tablesToCreate = [];
        if (!rows.some(row => row.name === 'ads')) {
            tablesToCreate.push(`CREATE TABLE ads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                photo TEXT,
                description TEXT,
                userId TEXT,
                isPremium BOOLEAN DEFAULT 0,
                status TEXT DEFAULT 'pending'
            )`);
        }
        if (!rows.some(row => row.name === 'promo_codes')) {
            tablesToCreate.push(`CREATE TABLE promo_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT UNIQUE,
                used INTEGER DEFAULT 0
            )`);
        }
        if (!rows.some(row => row.name === 'permanent_ads')) {
            tablesToCreate.push(`CREATE TABLE permanent_ads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                photo TEXT,
                description TEXT,
                userId TEXT,
                isPremium BOOLEAN DEFAULT 0
            )`);
        }

        if (tablesToCreate.length === 0) {
            console.log('Все таблицы уже существуют');
            await createIndexes();
            return;
        }

        for (const sql of tablesToCreate) {
            await dbRun(sql);
            console.log(`Таблица ${sql.split(' ')[2]} создана успешно`);
        }
        await createIndexes();
    } catch (err) {
        console.error('Ошибка инициализации базы:', err);
        process.exit(1);
    }
}

async function createIndexes() {
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_userId ON ads(userId)',
        'CREATE INDEX IF NOT EXISTS idx_status ON ads(status)',
        'CREATE INDEX IF NOT EXISTS idx_code ON promo_codes(code)',
        'CREATE INDEX IF NOT EXISTS idx_created ON ads(id DESC)',
        'CREATE INDEX IF NOT EXISTS idx_permanent ON permanent_ads(id DESC)'
    ];
    for (const sql of indexes) {
        try {
            await dbRun(sql);
            console.log(`Индекс ${sql.split(' ')[5]} создан успешно`);
        } catch (err) {
            console.error(`Ошибка создания индекса ${sql.split(' ')[5]}:`, err);
        }
    }
}

// Инициализация базы данных при запуске
initializeDatabase().then(() => {
    console.log('База данных инициализирована');
});

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d' // Кэш статических файлов на сутки
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/generate-promo', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET) {
        res.status(403).send('Доступ запрещён');
        return;
    }
    const promoCode = 'PREMIUM_' + Math.random().toString(36).substr(2, 8).toUpperCase();
    try {
        await dbRun('INSERT INTO promo_codes (code) VALUES (?)', [promoCode]);
        res.send(`Ваш промокод: ${promoCode}`);
    } catch (err) {
        console.error('Ошибка при сохранении промокода:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/check-db', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET) {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        const rows = await dbAll('SELECT name FROM sqlite_master WHERE type="table" AND name IN ("ads", "promo_codes", "permanent_ads")');
        res.send(`Таблицы в базе:<br>${JSON.stringify(rows, null, 2).replace(/\n/g, '<br>')}`);
    } catch (err) {
        res.status(500).send('Ошибка проверки базы: ' + err.message);
    }
});


// =====================================================================
// === БЛОК МОДЕРАЦИИ (СИЛЬНО ИЗМЕНЕН) ===
// =====================================================================
app.get('/moderate', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET) {
        res.status(403).send('Доступ запрещён');
        return;
    }
    
    // Устанавливаем кодировку
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    try {
        const pendingRows = await dbAll("SELECT * FROM ads WHERE status = 'pending' ORDER BY id DESC LIMIT 100");
        const approvedRows = await dbAll("SELECT * FROM ads WHERE status = 'approved' ORDER BY id DESC LIMIT 100");
        const permanentRows = await dbAll("SELECT * FROM permanent_ads ORDER BY id DESC");

        let html = `
            <!DOCTYPE html>
            <html lang="ru">
            <head>
                <title>Модерация объявлений</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                        margin: 0;
                        padding: 10px;
                        background-color: #f0f2f5;
                        color: #333;
                    }
                    h1, h2 {
                        text-align: center;
                        color: #000;
                    }
                    .header-controls {
                        text-align: center;
                        margin-bottom: 20px;
                    }
                    .refresh-btn {
                        display: inline-block;
                        padding: 12px 20px;
                        background: #007bff;
                        color: white;
                        text-decoration: none;
                        border-radius: 8px;
                        font-weight: bold;
                    }
                    ul {
                        list-style: none;
                        padding: 0;
                        max-width: 600px;
                        margin: 0 auto;
                    }
                    li {
                        border: 1px solid #ccc;
                        padding: 15px;
                        margin-bottom: 15px;
                        border-radius: 8px;
                        background: white;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    img {
                        max-width: 100%; /* Адаптивное изображение */
                        height: auto;
                        border-radius: 5px;
                        margin-top: 10px;
                    }
                    .ad-details {
                        margin-top: 10px;
                    }
                    .ad-details strong {
                        font-size: 1.2rem;
                    }
                    .ad-details p {
                        margin: 5px 0;
                        word-break: break-word;
                    }
                    .user-info {
                        font-size: 0.9rem;
                        color: #555;
                        background: #eee;
                        padding: 5px;
                        border-radius: 4px;
                        display: inline-block;
                        margin-top: 5px;
                    }
                    .premium {
                        color: #e67e22;
                        font-weight: bold;
                    }
                    .permanent {
                        color: #28a745;
                        font-weight: bold;
                    }
                    .actions {
                        margin-top: 15px;
                        display: flex;
                        flex-wrap: wrap;
                        gap: 10px;
                    }
                    .actions a {
                        flex-grow: 1; /* Кнопки растягиваются */
                        text-align: center;
                        padding: 12px;
                        text-decoration: none;
                        font-weight: bold;
                        border-radius: 5px;
                        color: white;
                        min-width: 120px;
                    }
                    .approve { background-color: #28a745; }
                    .reject { background-color: #dc3545; }
                    .make-permanent { background-color: #17a2b8; }
                    .remove-permanent { background-color: #ffc107; color: #000; }
                    .delete { background-color: #6c757d; }
                </style>
                </head>
            <body>
                <h1>Модерация</h1>
                <div class="header-controls">
                    <a href="/moderate?secret=${secret}" class="refresh-btn">Обновить (${pendingRows.length} новых)</a>
                </div>
                
                <h2>Ожидающие (${pendingRows.length})</h2>
                <ul>`;
        
        if (pendingRows.length === 0) {
            html += `<li style="text-align: center;">Нет объявлений на проверке</li>`;
        } else {
            pendingRows.forEach(ad => {
                html += `
                    <li style="background: #fffbea;">
                        <div class="ad-details">
                            <strong>${ad.title}</strong>
                            <p>${ad.description}</p>
                            <img src="${ad.photo}" alt="Фото"><br>
                            <span classclass="premium">Премиум: ${ad.isPremium ? 'Да' : 'Нет'}</span><br>
                            <span class="user-info">ID: ${ad.userId}</span>
                        </div>
                        <div class="actions">
                            <a href="/approve/${ad.id}?secret=${secret}" class="approve">Одобрить</a>
                            <a href="/reject/${ad.id}?secret=${secret}" class="reject">Отклонить</a>
                            <a href="/make-permanent/${ad.id}?secret=${secret}" class="make-permanent">Сделать постоянным</a>
                        </div>
                    </li>`;
            });
        }
        
        html += `</ul><h2>Одобренные и постоянные (${approvedRows.length + permanentRows.length})</h2><ul>`;

        if (approvedRows.length === 0 && permanentRows.length === 0) {
            html += `<li style="text-align: center;">Нет одобренных или постоянных объявлений</li>`;
        } else {
            // Сначала отображаем уникальные постоянные
            const approvedIds = new Set(approvedRows.map(ad => ad.id));
            const uniquePermanentAds = permanentRows.filter(pad => !approvedIds.has(pad.id));

            uniquePermanentAds.forEach(ad => {
                html += `
                    <li style="background: #e6ffed;">
                        <div class="ad-details">
                            <strong>${ad.title}</strong> <span class="permanent">(Постоянное)</span>
                            <p>${ad.description}</p>
                            <img src="${ad.photo}" alt="Фото"><br>
                            <span class="premium">Премиум: ${ad.isPremium ? 'Да' : 'Нет'}</span><br>
                            <span class="user-info">ID: ${ad.userId}</span>
                        </div>
                        <div class="actions">
                            <a href="/remove-permanent/${ad.id}?secret=${secret}" class="remove-permanent">Откл. постоянный</a>
                            <a href="/delete-ad/${ad.id}?secret=${secret}" class="delete">Удалить</a>
                        </div>
                    </li>`;
            });

            // Затем одобренные
            approvedRows.forEach(ad => {
                const isPermanent = permanentRows.some(p => p.id === ad.id);
                html += `
                    <li style="background: ${isPermanent ? '#e6ffed' : '#fff'};">
                        <div class="ad-details">
                            <strong>${ad.title}</strong> ${isPermanent ? '<span class="permanent">(Постоянное)</span>' : ''}
                            <p>${ad.description}</p>
                            <img src="${ad.photo}" alt="Фото"><br>
                            <span class="premium">Премиум: ${ad.isPremium ? 'Да' : 'Нет'}</span><br>
                            <span class="user-info">ID: ${ad.userId}</span>
                        </div>
                        <div class="actions">
                            ${!isPermanent ? `<a href="/make-permanent/${ad.id}?secret=${secret}" class="make-permanent">Сделать постоянным</a>` : ''}
                            ${isPermanent ? `<a href="/remove-permanent/${ad.id}?secret=${secret}" class="remove-permanent">Откл. постоянный</a>` : ''}
                            <a href="/delete-ad/${ad.id}?secret=${secret}" class="delete">Удалить</a>
                        </div>
                    </li>`;
            });
        }
        
        html += `</ul></body></html>`;
        res.send(html);
    } catch (err) {
        console.error('Ошибка в /moderate:', err);
        res.status(500).send('Ошибка сервера: ' + err.message);
    }
});
// =====================================================================
// === КОНЕЦ БЛОКА МОДЕРАЦИИ ===
// =====================================================================


app.get('/approve/:id', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET) {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        const ad = await dbGet("SELECT * FROM ads WHERE id = ?", [req.params.id]);
        if (!ad) {
            console.error('Объявление не найдено при одобрении:', { id: req.params.id });
            res.status(404).send('Объявление не найдено');
            return;
        }
        console.log('Состояние объявления перед одобрением:', { id: req.params.id, status: ad.status });
        const result = await dbRun("UPDATE ads SET status = 'approved' WHERE id = ?", [req.params.id]);
        console.log('Объявление одобрено:', { id: req.params.id, rowsAffected: result.changes });
        
        const updatedAd = await dbGet("SELECT * FROM ads WHERE id = ?", [req.params.id]);
        console.log('Объявление после одобрения:', { id: req.params.id, status: updatedAd.status });
        
        // Отправляем одобренное объявление всем клиентам
        io.emit('new-ad', { ...updatedAd, status: 'approved' });
        
        res.redirect(`/moderate?secret=${ADMIN_SECRET}`);
    } catch (err) {
        console.error('Ошибка в /approve:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/reject/:id', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET) {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        await dbRun("DELETE FROM ads WHERE id = ?", [req.params.id]);
        console.log('Объявление отклонено и удалено:', { id: req.params.id });
        res.redirect(`/moderate?secret=${ADMIN_SECRET}`);
    } catch (err) {
        console.error('Ошибка в /reject:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/make-permanent/:id', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET) {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        let ad = await dbGet("SELECT * FROM ads WHERE id = ?", [req.params.id]);
        
        // Если его нет в ads, но оно есть в permanent_ads, это ошибка (но лучше обработать)
        if (!ad) {
            ad = await dbGet("SELECT * FROM permanent_ads WHERE id = ?", [req.params.id]);
            if (!ad) {
                 res.status(404).send('Объявление не найдено');
                 return;
            }
        }
        
        console.log('Проверка статуса для постоянного:', { id: req.params.id, status: ad.status });
        
        // Если объявление еще на модерации, одобряем его
        if (ad.status === 'pending') {
            await dbRun("UPDATE ads SET status = 'approved' WHERE id = ?", [req.params.id]);
            // Отправляем его в ленту
            io.emit('new-ad', { ...ad, status: 'approved' });
        }

        const permanentAd = await dbGet("SELECT * FROM permanent_ads WHERE id = ?", [ad.id]);
        if (permanentAd) {
            res.status(400).send('Объявление уже постоянное');
            return;
        }
        
        await dbRun('INSERT INTO permanent_ads (id, title, photo, description, userId, isPremium) VALUES (?, ?, ?, ?, ?, ?)',
            [ad.id, ad.title, ad.photo, ad.description, ad.userId, ad.isPremium]);
        
        console.log('Объявление сделано постоянным:', ad.id);
        res.redirect(`/moderate?secret=${ADMIN_SECRET}`);
    } catch (err) {
        console.error('Ошибка в /make-permanent:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/remove-permanent/:id', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET) {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        await dbRun('DELETE FROM permanent_ads WHERE id = ?', [req.params.id]);
        console.log('Постоянное объявление удалено:', req.params.id);
        res.redirect(`/moderate?secret=${ADMIN_SECRET}`);
    } catch (err) {
        console.error('Ошибка в /remove-permanent:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/delete-ad/:id', async (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET) {
        res.status(403).send('Доступ запрещён');
        return;
    }
    try {
        const id = req.params.id;
        const adInAds = await dbGet("SELECT * FROM ads WHERE id = ?", [id]);
        const adInPermanent = await dbGet("SELECT * FROM permanent_ads WHERE id = ?", [id]);

        if (!adInAds && !adInPermanent) {
            console.error('Объявление не найдено для удаления:', { id });
            res.status(404).send('Объявление не найдено');
            return;
        }

        if (adInAds) {
            await dbRun("DELETE FROM ads WHERE id = ?", [id]);
            console.log('Объявление удалено из ads:', { id });
        }
        if (adInPermanent) {
            await dbRun("DELETE FROM permanent_ads WHERE id = ?", [id]);
            console.log('Объявление удалено из permanent_ads:', { id });
        }

        io.emit('delete-ad', id);
        res.redirect(`/moderate?secret=${ADMIN_SECRET}`);
    } catch (err) {
        console.error('Ошибка в /delete-ad:', err);
        res.status(500).send('Ошибка сервера');
    }
});

const RESET_INTERVAL = 24 * 60 * 60 * 1000;
let nextReset = Date.now() + RESET_INTERVAL;

async function resetAds() {
    try {
        await dbRun("DELETE FROM ads WHERE status = 'approved'");
        console.log('Объявления сброшены');
        
        const permanentRows = await dbAll("SELECT * FROM permanent_ads");
        io.emit('initial-ads', permanentRows);
        
        nextReset = Date.now() + RESET_INTERVAL;
        io.emit('reset-time', nextReset);
    } catch (err) {
         console.error('Ошибка при сбросе объявлений:', err);
    }
}

setInterval(() => {
    const now = Date.now();
    if (now >= nextReset) resetAds();
}, 1000 * 60);

// Функция для загрузки всех объявлений (одобренных + постоянных)
async function getAllActiveAds() {
    try {
        const tempRows = await dbAll("SELECT * FROM ads WHERE status = 'approved' LIMIT 100");
        const permanentRows = await dbAll("SELECT * FROM permanent_ads");
        
        // Объединяем и убираем дубликаты, отдавая приоритет постоянным (хотя их id должен быть в tempRows)
        const adMap = new Map();
        tempRows.forEach(ad => adMap.set(ad.id, ad));
        permanentRows.forEach(ad => adMap.set(ad.id, ad)); // Перезапишет временное, если есть дубликат
        
        const allAds = Array.from(adMap.values());
        allAds.sort((a, b) => b.isPremium - a.isPremium);
        
        console.log('Отправлены объявления:', allAds.length);
        return allAds.slice(0, 100);
    } catch (err) {
        console.error('Ошибка получения объявлений:', err);
        return [];
    }
}

io.on('connection', async (socket) => {
    console.log('Пользователь подключен:', socket.id);

    const allAds = await getAllActiveAds();
    socket.emit('initial-ads', allAds);
    socket.emit('reset-time', nextReset);

    socket.on('new-ad', async (ad, callback) => {
        const { title, photo, description, userId, promoCode } = ad;
        console.log('Получено фото размером:', photo ? photo.length / 1024 : 0, 'KB');

        if (photo && photo.length > 2097152 * 1.5) { // Оставляем запас на base64
            callback({ success: false, message: 'Фото слишком большое! Максимум 2 MB. Сжмите изображение.' });
            return;
        }

        try {
            // Проверяем, что у пользователя нет ДРУГИХ объявлений (включая на модерации)
            const row = await dbGet('SELECT COUNT(*) as count FROM ads WHERE userId = ?', [userId]);
            if (row.count > 0) {
                callback({ success: false, message: 'У вас уже есть одно объявление. Удалите его, чтобы добавить новое.' });
                return;
            }

            let isPremium = false;
            if (promoCode) {
                const promoRow = await dbGet('SELECT * FROM promo_codes WHERE code = ? AND used = 0', [promoCode]);
                console.log('Проверка промокода:', promoCode, 'Найден:', promoRow);
                if (!promoRow) {
                    callback({ success: false, message: 'Неверный или использованный промокод' });
                    return;
                }
                await dbRun('UPDATE promo_codes SET used = 1 WHERE code = ?', [promoCode]);
                isPremium = true;
            }
            
            // Сохраняем объявление со статусом 'pending'
            const result = await dbRun(
                'INSERT INTO ads (title, photo, description, userId, isPremium, status) VALUES (?, ?, ?, ?, ?, ?)',
                [title, photo, description, userId, isPremium, 'pending']
            );
            
            // Уведомляем админа о новом объявлении на модерации
            io.emit('new-pending-ad', result.lastID); // (Можно использовать в админке для real-time)
            callback({ success: true });

        } catch (err) {
            console.error('Ошибка обработки new-ad:', err);
            callback({ success: false, message: 'Ошибка сервера' });
        }
    });

    socket.on('delete-ad', async (data, callback) => {
        try {
            const row = await dbGet('SELECT userId FROM ads WHERE id = ?', [data.adId]);
            if (!row) {
                callback({ success: false, message: 'Объявление не найдено' });
                return;
            }
            if (row.userId !== data.userId) {
                callback({ success: false, message: 'Вы не можете удалить это объявление' });
                return;
            }
            
            // Удаляем из обеих таблиц
            await dbRun('DELETE FROM ads WHERE id = ?', [data.adId]);
            await dbRun('DELETE FROM permanent_ads WHERE id = ?', [data.adId]);

            io.emit('delete-ad', data.adId);
            callback({ success: true });
        } catch (err) {
            console.error('Ошибка удаления объявления:', err);
            callback({ success: false, message: 'Ошибка сервера' });
        }
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключен:', socket.id);
    });
});


const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    // resetAds(); // Не сбрасываем при запуске, только по таймеру
});