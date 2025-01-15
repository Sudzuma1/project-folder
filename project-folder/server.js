const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Настройка хранилища для изображений
const upload = multer({ dest: 'uploads/' });

// Статические файлы (HTML, CSS, JS, изображения)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Хранилище объявлений
let ads = [];

// Получить все объявления
app.get('/ads', (req, res) => {
    res.json(ads);
});

// Добавить объявление
app.post('/ads', upload.single('photo'), (req, res) => {
    const { title, description } = req.body;
    const photo = `/uploads/${req.file.filename}`;
    ads.push({ title, description, photo });
    res.status(201).send('Объявление добавлено!');
});

// Отдавать загруженные файлы
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});
