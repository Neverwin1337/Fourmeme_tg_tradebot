const knexLib = require('knex');
const config = require('../config');
const createLogger = require('../utils/logger');

const logger = createLogger('db');

const knex = knexLib({
  client: 'mysql2',
  connection: {
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    charset: 'utf8mb4'
  },
  pool: { min: 2, max: 100 },
  debug: false
});

knex.raw('SELECT 1')
  .then(() => {
    logger.info('MySQL 连接成功');
    logger.info(`数据库: ${config.mysql.database || ''}`);
  })
  .catch((err) => {
    logger.error('MySQL 连接失败:', err.message);
    // 不退出进程，允许应用继续运行并在后续尝试重新连接
  });

module.exports = knex;
