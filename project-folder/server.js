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

    // Отправляем одобренные объявления при подключении
    db.all(`SELECT * FROM ads WHERE status = 'approved' ORDER BY isPremium DESC, timestamp DESC`, [], (err, rows) => {
        if (err) {
            console.error('Ошибка загрузки initial-ads:', err.message);
        } else {
            console.log(`Отправлено ${rows.length} одобренных объявлений клиенту ${socket.id}`);
            socket.emit('initial-ads', rows || []);
        }
    });

    socket.on('new-ad', (ad, callback) => {
        const { id, title, description, photo, category, userId } = ad;
        console.log('Получено новое объявление на модерацию:', { id, title, category, userId });

        db.run(`INSERT INTO ads (id, title, description, photo, category, userId, timestamp, status, isPremium)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
            [id, title, description, photo, category, userId, Date.now()],
            function(err) {
                if (err) {
                    console.error('ОШИБКА ВСТАВКИ ОБЪЯВЛЕНИЯ:', err.message);
                    callback({ success: false, error: err.message });
                } else {
                    console.log('Объявление успешно добавлено в pending:', id);
                    callback({ success: true });
                }
            }
        );
    });

    socket.on('delete-ad', ({ adId, userId }, callback) => {
        db.get('SELECT userId FROM ads WHERE id = ? AND status = "approved"', [adId], (err, row) => {
            if (row && row.userId === userId) {
                db.run('DELETE FROM ads WHERE id = ?', [adId], () => {
                    console.log('Объявление удалено пользователем:', adId);
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
                if (err) {
                    console.error('Ошибка get-all-ads:', err.message);
                } else {
                    console.log(`Отправлено ${rows.length} всех объявлений модератору`);
                }
                callback(rows || []);
            });
        } else {
            callback([]);
        }
    });

    // Одобрение объявления — здесь добавлены подробные логи
    socket.on('approve-ad', ({ secret, adId, premium = false }) => {
        if (secret !== ADMIN_SECRET) {
            console.log('Попытка одобрения с неверным secret');
            return;
        }

        const isPrem = premium ? 1 : 0;
        console.log(`Одобрение объявления ${adId}, премиум: ${premium}`);

        db.run('UPDATE ads SET status = "approved", isPremium = ? WHERE id = ?', [isPrem, adId], function(err) {
            if (err) {
                console.error('ОШИБКА ОБНОВЛЕНИЯ статуса approved:', err.message);
                return;
            }
            console.log(`Статус объявления ${adId} успешно изменён на approved, isPremium=${isPrem}`);

            db.get('SELECT * FROM ads WHERE id = ?', [adId], (err, row) => {
                if (err) {
                    console.error('ОШИБКА чтения объявления после одобрения:', err.message);
                } else if (!row) {
                    console.error(`Объявление ${adId} НЕ НАЙДЕНО после обновления!`);
                } else {
                    console.log(`Отправка new-ad всем клиентам: ${row.id} (${row.title}), премиум: ${row.isPremium}`);
                    io.emit('new-ad', row);
                }
            });
        });
    });

    socket.on('reject-ad', ({ secret, adId }) => {
        if (secret === ADMIN_SECRET) {
            console.log(`Отклонение (удаление) объявления ${adId}`);
            db.run('DELETE FROM ads WHERE id = ?', [adId], () => {
                io.emit('delete-ad', adId);
            });
        }
    });

    socket.on('delete-any-ad', ({ secret, adId }) => {
        if (secret === ADMIN_SECRET) {
            console.log(`Модератор удаляет объявление ${adId}`);
            db.run('DELETE FROM ads WHERE id = ?', [adId], () => {
                io.emit('delete-ad', adId);
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));