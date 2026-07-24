// src/server.js
const createApp = require('./app');
const config = require('./config');

const { app } = createApp();

app.listen(config.port, () => {
  console.log(`Flock Energy API listening on http://localhost:${config.port}`);
  console.log(`Docs available at http://localhost:${config.port}/docs`);
});
