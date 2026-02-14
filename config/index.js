require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  botToken: process.env.BOT_TOKEN,
  feeCollectorAddress: process.env.FEE_COLLECTOR_ADDRESS,
  mysql: {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  },
  rpc: {
    local: process.env.LOCAL_RPC_URL || 'http://localhost:8545',
    public: process.env.PUBLIC_RPC_URL || process.env.LOCAL_RPC_URL || 'http://localhost:8545',
    json: process.env.JSON_RPC_URL || 'http://localhost:8545',
    ws: process.env.WS_RPC_URL || process.env.WEBSOCKET_RPC_URL || 'ws://localhost:8546'
  }
};

module.exports = config;
