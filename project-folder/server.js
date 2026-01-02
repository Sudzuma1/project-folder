const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'mysupersecret2026';

const db = new sqlite3.Database('./ads.db', (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err.message);
    } else {
        console.log('DB connected');
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS ads (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        photo TEXT,
        category TEXT,
        userId TEXT,
        timestamp INTEGER,
        status TEXT DEFAULT 'pending',
        isPremium INTEGER DEFAULT 0
    )`, (err) => {
        if (err) {
            console.error('Ошибка создания таблицы:', err.message);
        } else {
            console.log('Таблица ads готова');
        }
    });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/moderate', (req, res) => {
    if (req.query.secret !== ADMIN_SECRET) return res.status(403).send('Доступ запрещён');
    res.sendFile(path.join(__dirname, 'public', 'moderate.html'));
});

io.on('connection', (socket) => {
    console.log('Клиент подключился:', socket.id);

    // Отправляем одобренные объявления
    db.all(`SELECT * FROM ads WHERE status = 'approved' ORDER BY isPremium DESC, timestamp DESC`, [], (err, rows) => {
        if (err) {
            console.error('Ошибка загрузки initial-ads:', err.message);
        } else {
            socket.emit('initial-ads', rows || []);
        }
    });

    // Новое объявление
    socket.on('new-ad', (ad, callback) => {
        const { id, title, description, photo, category, userId } = ad;
        console.log('Получено новое объявление:', { id, title, category, userId });

        db.run(`INSERT INTO ads (id, title, description, photo, category, userId, timestamp, status, isPremium)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
            [id, title, description, photo, category, userId, Date.now()],
            function(err) {
                if (err) {
                    console.error('ОШИБКА ВСТАВКИ ОБЪЯВЛЕНИЯ:', err.message);
                    console.error('Данные объявления:', { id, title, category, userId, photoLength: photo?.length });
                    callback({ success: false, error: err.message });
                } else {
                    console.log('Объявление успешно добавлено в pending:', id);
                    callback({ success: true });
                }
            }
        );
    });

    // Остальные обработчики (delete-ad, get-all-ads и т.д.) остаются без изменений
    socket.on('delete-ad', ({ adId, userId }, callback) => {
        db.get('SELECT userId FROM ads WHERE id = ? AND status = "approved"', [adId], (err, row) => {
            if (row && row.userId === userId) {
                db.run('DELETE FROM ads WHERE id = ?', [adId], () => {
                    io.emit('delete-ad', adId);
                    if (callback) callback({ success: true });
                });
            } else {
                if (callback) callback({ success: false });
            }
        });
    });

    socket.on('get-all-ads', (secret, callback) => {
        if (secret === ADMIN_SECRET) {
            db.all(`SELECT * FROM ads ORDER BY timestamp DESC`, [], (err, rows) => {
                callback(rows || []);
            });
        } else {
            callback([]);
        }
    });

    socket.on('approve-ad', ({ secret, adId, premium = false }) => {
        if (secret === ADMIN_SECRET) {
            const isPrem = premium ? 1 : 0;
            db.run('UPDATE ads SET status = "approved", isPremium = ? WHERE id = ?', [isPrem, adId], () => {
                db.get('SELECT * FROM ads WHERE id = ?', [adId], (err, row) => {
                    if (row) io.emit('new-ad', row);
                });
            });
        }
    });

    socket.on('reject-ad', ({ secret, adId }) => {
        if (secret === ADMIN_SECRET) {
            db.run('DELETE FROM ads WHERE id = ?', [adId], () => {
                io.emit('delete-ad', adId);
            });
        }
    });

    socket.on('delete-any-ad', ({ secret, adId }) => {
        if (secret === ADMIN_SECRET) {
            db.run('DELETE FROM ads WHERE id = ?', [adId], () => {
                io.emit('delete-ad', adId);
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));