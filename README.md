# fourmeme-bsc-sniper-bot

Telegram 狙击机器人：面向 **BSC 链** 的 **Fourmeme 内盘**（以及相关交易路由/合约）自动化交易与风控。

## 功能概览

- **钱包管理**
  - 多钱包（同一 Telegram 用户可创建多个钱包、切换激活钱包）
  - 狙击（sniper）与扫链（sweep）可在同一钱包上分别启用与独立配置
- **交易/策略**
  - 面向 Fourmeme 内盘的狙击/扫链策略（以项目内实现为准）
  - 通过合约（FeeCollector / TokenManager2）与路由进行 swap（依项目内实现为准）
  - 止盈/止损（TPSL）
  - 价格监控（等待下跌触发自动买入）
- **价格服务**
  - 内置 `utils/priceWorker.js` 子进程，轮询获取代币价格并触发监听事件

> 注意：本项目涉及私钥/助记词/链上交易与资金风险，请仅在你完全理解代码与风险的前提下使用。

## 技术栈
<img width="321" height="580" alt="image" src="https://github.com/user-attachments/assets/f72af1f9-7c3d-497b-8f4e-d77cb253f363" />
<img width="488" height="727" alt="image" src="https://github.com/user-attachments/assets/1e9e5a83-dc71-4aee-857f-d676dc718f4f" />

- **Node.js**
  - `telegraf`（Telegram Bot Framework）
  - `ethers`（链上交互）
  - `knex` + `mysql2`（MySQL 数据库）
  - `dotenv`（环境变量）
- **Python（可选工具脚本）**
  - `requests`、`web3`（用于部分辅助脚本，见 `requirements.txt`）

## 目录结构（简化）

- `bot.js`：主入口（Telegram bot）
- `config/index.js`：环境变量与配置聚合
- `db/knex.js`：MySQL 连接（Knex）
- `mysql_schema_v2.sql`：数据库结构（v2）
- `utils/priceWorker.js`：价格 worker 子进程
- `services/`、`lib/`、`utils/`：业务逻辑与工具


## 环境准备

- Node.js 18+（建议）
- MySQL 8+（建议）
- 一个 Telegram Bot Token（来自 @BotFather）
- 一个可用的 **BSC JSON-RPC / WebSocket RPC**（用于读链、发交易与价格轮询）

## 安装

使用 yarn：

```bash
yarn install
```

或使用 npm：

```bash
npm install
```

## 配置（.env）

项目使用 `dotenv`，需要在项目根目录创建 `.env`（已在 `.gitignore` 中忽略，不会提交）。

### 必填（通常）

- `BOT_TOKEN`：Telegram Bot Token
- `MYSQL_HOST`
- `MYSQL_PORT`（默认 3306）
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE`

### 可选（RPC/网络）

`config/index.js` 中会读取以下 RPC 配置（未填则有默认值）：

- `LOCAL_RPC_URL`（默认 `http://localhost:8545`）
- `PUBLIC_RPC_URL`（默认：`LOCAL_RPC_URL` 或 `http://localhost:8545`）
- `JSON_RPC_URL`（默认 `http://localhost:8545`）
- `WS_RPC_URL` / `WEBSOCKET_RPC_URL`（默认 `ws://localhost:8546`）

### 可选（合约/功能）

- `FEE_COLLECTOR_ADDRESS`：FeeCollector 合约地址（未设置时，代码内有默认地址兜底）

### 可选（价格 Worker）

`utils/priceWorker.js` 额外读取：

- `PRICE_WORKER_RPC`：价格轮询专用 RPC（默认使用 `PUBLIC_RPC_URL`）
- `PRICE_WORKER_MAX_PER_TICK`：每轮轮询的最大 token 数（默认 20）

### 示例 .env（示意，不要把真实密钥提交到 git）

```env
NODE_ENV=production

BOT_TOKEN=123456:ABCDEF

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=fourmeme_sniper_bot

PUBLIC_RPC_URL=https://bsc-dataseed.binance.org/
WS_RPC_URL=wss://bsc-ws-node.nariox.org:443

FEE_COLLECTOR_ADDRESS=0xYourFeeCollector

PRICE_WORKER_RPC=https://bsc-dataseed.binance.org/
PRICE_WORKER_MAX_PER_TICK=20
```

## 初始化数据库

1. 在 MySQL 创建数据库（示例）：

```sql
CREATE DATABASE fourmeme_sniper_bot DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

2. 导入表结构：

- 执行 `mysql_schema_v2.sql`

文件包含：

- `users`
- `wallets`
- `take_profit_stop_loss`（含 `mode` 字段区分 `sniper/sweep`）
- `sniper_records`
- `price_monitors`

## 启动

### 生产启动

```bash
yarn start
```

### 开发启动（热重载）

```bash
yarn dev
```

脚本定义见 `package.json`：

- `start`：`node bot.js`
- `dev`：`nodemon bot.js`

## 合约相关（可选）

项目内提供了脚本入口（若目录存在且你已配置好相关参数/私钥/网络）：

- 编译：

```bash
yarn compile
```

- 部署：

```bash
yarn deploy
```

- 部署到 Remix（脚本参数）：

```bash
yarn deploy:remix
```

> 具体合约与部署参数以 `scripts/` 目录实现为准。

## 常见问题

### 1) 启动后提示 MySQL 连接失败

- 检查 `.env` 中 `MYSQL_HOST/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE`
- 确保 MySQL 已启动，并允许该用户从你的主机连接

### 2) 价格为 0 或监听不触发

- 检查 `PUBLIC_RPC_URL` / `PRICE_WORKER_RPC` 是否可用、是否被限流
- 尝试更换更稳定的 RPC
- 适当调小 `PRICE_WORKER_MAX_PER_TICK` 以减少每轮请求量

### 3) Telegram bot 没有响应

- 确认 `BOT_TOKEN` 正确
- 检查是否有多个实例同时使用同一个 bot token（会导致 webhook/long polling 冲突）

## 安全提醒

- **不要提交 `.env`、数据库文件、私钥/助记词**
- 建议使用独立测试钱包进行验证
- 建议先在测试网或小额资金环境中运行

## License

ISC
