const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Исправлено: Храним базу в корне, чтобы работало на бесплатном тарифе
const dbPath = './ads.db'; 
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'mysecret123';

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к базе:', err);
    } else {
        console.log('Подключено к базе данных:', dbPath);
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS ads (
                id TEXT PRIMARY KEY,
                text TEXT,
                userId TEXT,
                timestamp INTEGER,
                status TEXT DEFAULT 'pending'
            )`);
        });
    }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Страница модерации
app.get('/moderate', (req, res) => {
    if (req.query.secret !== ADMIN_SECRET) return res.status(403).send('Доступ запрещен');
    res.sendFile(path.join(__dirname, 'public', 'moderate.html'));
});

// Socket.io логика
io.on('connection', (socket) => {
    db.all('SELECT * FROM ads WHERE status = "approved"', [], (err, rows) => {
        if (!err) socket.emit('init-ads', rows);
    });

    socket.on('new-ad', (data, callback) => {
        db.run('INSERT INTO ads (id, text, userId, timestamp, status) VALUES (?, ?, ?, ?, ?)',
            [data.id, data.text, data.userId, Date.now(), 'pending'], (err) => {
                if (err) callback({ success: false });
                else callback({ success: true });
            });
    });

    socket.on('get-pending-ads', (secret, callback) => {
        if (secret === ADMIN_SECRET) {
            db.all('SELECT * FROM ads WHERE status = "pending"', [], (err, rows) => {
                callback(rows || []);
            });
        }
    });

    socket.on('approve-ad', (data) => {
        if (data.secret === ADMIN_SECRET) {
            db.run('UPDATE ads SET status = "approved" WHERE id = ?', [data.adId], () => {
                db.get('SELECT * FROM ads WHERE id = ?', [data.adId], (err, row) => {
                    if (row) io.emit('new-ad', row);
                });
            });
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});