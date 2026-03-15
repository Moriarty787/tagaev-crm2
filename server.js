const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// Отдаём статику из корня проекта
app.use(express.static(path.join(__dirname)));

// Все маршруты → index.html (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`my.crm запущен на порту ${PORT}`);
});
