const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройка путей: на бесплатном тарифе храним базу прямо в корне проекта
const dbPath = './ads.db'; 

// Секрет для модерации (через переменную окружения или стандартный)
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'mysecret123';

// Подключение к базе данных
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к базе:', err);
        process.exit(1);
    } else {
        console.log('Подключено к базе данных:', dbPath);
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        // Таблица для активных объявлений
        db.run(`CREATE TABLE IF NOT EXISTS ads (
            id TEXT PRIMARY KEY,
            text TEXT,
            userId TEXT,
            timestamp INTEGER,
            status TEXT DEFAULT 'pending'
        )`);
        
        // Таблица для истории (чтобы не терять данные при очистке)
        db.run(`CREATE TABLE IF NOT EXISTS permanent_ads (
            id TEXT PRIMARY KEY,
            text TEXT,
            userId TEXT,
            timestamp INTEGER
        )`);
    });
}

// Полезные функции для работы с БД (Promise)
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        if (err) reject(err); else resolve(this);
    });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err); else resolve(rows);
    });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err); else resolve(row);
    });
});

// Раздача статических файлов из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Страница модерации
app.get('/moderate', (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET) {
        return res.status(403).send('Доступ запрещен: неверный секретный ключ');
    }
    res.sendFile(path.join(__dirname, 'public', 'moderate.html'));
});

// Работа с Socket.io
io.on('connection', async (socket) => {
    console.log('Пользователь подключен:', socket.id);

    // Отправляем только одобренные объявления при входе
    try {
        const rows = await dbAll('SELECT * FROM ads WHERE status = "approved" ORDER BY timestamp DESC');
        socket.emit('init-ads', rows);
    } catch (err) {
        console.error(err);
    }

    // Обработка нового объявления
    socket.on('new-ad', async (data, callback) => {
        try {
            const existingAd = await dbGet('SELECT id FROM ads WHERE userId = ?', [data.userId]);
            if (existingAd) {
                callback({ success: false, message: 'У вас уже есть активное объявление' });
                return;
            }

            await dbRun(
                'INSERT INTO ads (id, text, userId, timestamp, status) VALUES (?, ?, ?, ?, ?)',
                [data.id, data.text, data.userId, Date.now(), 'pending']
            );

            // Оповещаем админа (если он онлайн)
            io.emit('admin-new-pending'); 
            callback({ success: true });

        } catch (err) {
            console.error(err);
            callback({ success: false, message: 'Ошибка сервера' });
        }
    });

    // Админ запрашивает список на модерацию
    socket.on('get-pending-ads', async (secret, callback) => {
        if (secret !== ADMIN_SECRET) return;
        const rows = await dbAll('SELECT * FROM ads WHERE status = "pending"');
        callback(rows);
    });

    // Одобрение объявления
    socket.on('approve-ad', async (data) => {
        if (data.secret !== ADMIN_SECRET) return;
        await dbRun('UPDATE ads SET status = "approved" WHERE id = ?', [data.adId]);
        const ad = await dbGet('SELECT * FROM ads WHERE id = ?', [data.adId]);
        
        // Дублируем в вечную базу
        await dbRun('INSERT OR IGNORE INTO permanent_ads (id, text, userId, timestamp) VALUES (?, ?, ?, ?)', 
            [ad.id, ad.text, ad.userId, ad.timestamp]);

        io.emit('new-ad', ad); // Отправляем всем пользователям
    });

    socket.on('delete-ad', async (data, callback) => {
        try {
            const row = await dbGet('SELECT userId FROM ads WHERE id = ?', [data.adId]);
            if (row && row.userId === data.userId) {
                await dbRun('DELETE FROM ads WHERE id = ?', [data.adId]);
                io.emit('delete-ad', data.adId);
                callback({ success: true });
            }
        } catch (err) {
            callback({ success: false });
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});