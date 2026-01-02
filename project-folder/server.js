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
    if (err) console.error(err);
    else console.log('DB connected');
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
    )`);
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/moderate', (req, res) => {
    if (req.query.secret !== ADMIN_SECRET) return res.status(403).send('Доступ запрещён');
    res.sendFile(path.join(__dirname, 'public', 'moderate.html'));
});

io.on('connection', (socket) => {
    // Отправляем одобренные объявления
    db.all(`SELECT * FROM ads WHERE status = 'approved' ORDER BY isPremium DESC, timestamp DESC`, [], (err, rows) => {
        if (!err) socket.emit('initial-ads', rows || []);
    });

    socket.on('new-ad', (ad, callback) => {
        const { id, title, description, photo, category, userId } = ad;
        db.run(`INSERT INTO ads (id, title, description, photo, category, userId, timestamp, status, isPremium)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
            [id, title, description, photo, category, userId, Date.now()],
            function(err) {
                callback({ success: !err });
            }
        );
    });

    socket.on('delete-ad', ({ adId, userId }, callback) => {
        db.get('SELECT userId FROM ads WHERE id = ? AND status = "approved"', [adId], (err, row) => {
            if (row && row.userId === userId) {
                db.run('DELETE FROM ads WHERE id = ?', [adId], () => {
                    io.emit('delete-ad', adId);
                    callback({ success: true });
                });
            } else {
                callback({ success: false });
            }
        });
    });

    // Модерация
    socket.on('get-pending', (secret, callback) => {
        if (secret === ADMIN_SECRET) {
            db.all('SELECT * FROM ads WHERE status = "pending"', [], (err, rows) => {
                callback(rows || []);
            });
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
            db.run('DELETE FROM ads WHERE id = ?', [adId]);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));