-- ============================================
-- Telegram Bot 数据库结构 v2（支持同钱包双模式+独立TPSL）
-- 建议先手动创建数据库并 USE 到目标库
-- ============================================

SET NAMES utf8mb4;

-- ============================================
-- 1. 用户表 (users)
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    user_id VARCHAR(50) PRIMARY KEY COMMENT 'Telegram 用户 ID',
    username VARCHAR(255) COMMENT '用户名',
    invited_by VARCHAR(50) COMMENT '邀请人 ID',
    invite_count INT DEFAULT 0 COMMENT '邀请人数',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    INDEX idx_invited_by (invited_by),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
COMMENT='用户基础信息表';

-- ============================================
-- 2. 钱包表 (wallets)
--  同一钱包可同时开启狙击/扫链，参数分开
-- ============================================
CREATE TABLE IF NOT EXISTS wallets (
    id INT PRIMARY KEY AUTO_INCREMENT COMMENT '钱包 ID',
    user_id VARCHAR(50) NOT NULL COMMENT '用户 ID',
    wallet_number INT NOT NULL COMMENT '钱包编号',
    address VARCHAR(42) NOT NULL COMMENT '钱包地址',
    private_key TEXT NOT NULL COMMENT '私钥（加密存储）',
    mnemonic TEXT NOT NULL COMMENT '助记词（加密存储）',
    is_active TINYINT(1) DEFAULT 0 COMMENT '是否激活 (0=否, 1=是)',

    -- 狙击通用参数
    buy_amount DECIMAL(18, 8) DEFAULT 0.01 COMMENT '购买金额 (BNB)',
    slippage DECIMAL(5, 2) DEFAULT 10.00 COMMENT '滑点 (%)',
    gas_price INT DEFAULT 5 COMMENT 'Gas 价格 (Gwei)',
    filter_social TINYINT(1) DEFAULT 0 COMMENT '过滤社交媒体',
    filter_min_holders INT DEFAULT 0 COMMENT '最小持币人数',
    filter_top10_max DECIMAL(5, 2) DEFAULT 100.00 COMMENT 'Top10 最大占比 (%)',
    filter_binance_only TINYINT(1) DEFAULT 0 COMMENT '仅币安发射',
    wait_for_drop TINYINT(1) NOT NULL DEFAULT 0 COMMENT '等待下跌启用(狙击)',
    drop_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.00 COMMENT '等待下跌百分比(狙击)',
    bribe_amount DECIMAL(18,8) NOT NULL DEFAULT 0.00000000 COMMENT '贿赂金额(BNB)',

    -- 开关
    sniper_enabled TINYINT(1) DEFAULT 0 COMMENT '狙击功能启用',

    -- 扫链独立参数
    sweep_enabled TINYINT(1) DEFAULT 0 COMMENT '扫链功能启用',
    sweep_buy_amount DECIMAL(18, 8) DEFAULT 0.01 COMMENT '扫链买入金额 (BNB)',
    sweep_slippage DECIMAL(5, 2) DEFAULT 10.00 COMMENT '扫链滑点 (%)',
    sweep_gas_price INT DEFAULT 5 COMMENT '扫链 Gas 价格 (Gwei)',
    sweep_filter_social TINYINT(1) DEFAULT 0 COMMENT '扫链过滤社交媒体',
    sweep_filter_min_holders INT DEFAULT 0 COMMENT '扫链最小持币人数',
    sweep_filter_top10_max DECIMAL(5, 2) DEFAULT 100.00 COMMENT '扫链 Top10 最大占比 (%)',
    sweep_filter_progress_min DECIMAL(6, 3) DEFAULT 0.000 COMMENT '扫链最小进度 progress(%)',

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',

    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE KEY uk_user_wallet (user_id, wallet_number),
    INDEX idx_user_id (user_id),
    INDEX idx_user_active (user_id, is_active),
    INDEX idx_user_sniper (user_id, sniper_enabled),
    INDEX idx_user_sweep (user_id, sweep_enabled),
    INDEX idx_address (address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
COMMENT='钱包信息表（支持同钱包双模式）';

-- ============================================
-- 3. 止盈止损表 (take_profit_stop_loss)
--  增加 mode 字段，分别存储 sniper / sweep
-- ============================================
CREATE TABLE IF NOT EXISTS take_profit_stop_loss (
    id INT PRIMARY KEY AUTO_INCREMENT COMMENT '记录 ID',
    wallet_id INT NOT NULL COMMENT '钱包 ID',
    type VARCHAR(20) NOT NULL COMMENT '类型 (take_profit / stop_loss)',
    price_percent DECIMAL(10, 2) NOT NULL COMMENT '价格变动百分比 (%)',
    sell_percent DECIMAL(5, 2) NOT NULL COMMENT '卖出百分比 (%)',
    mode VARCHAR(16) NOT NULL DEFAULT 'sniper' COMMENT '所属模式(sniper/sweep)',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',

    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
    INDEX idx_wallet_id (wallet_id),
    INDEX idx_wallet_type (wallet_id, type),
    INDEX idx_type (type),
    INDEX idx_wallet_type_mode (wallet_id, type, mode),
    INDEX idx_mode (mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
COMMENT='止盈止损配置表（按模式区分）';

-- ============================================
-- 4. 狙击记录表 (sniper_records)
-- ============================================
CREATE TABLE IF NOT EXISTS sniper_records (
    id INT PRIMARY KEY AUTO_INCREMENT COMMENT '记录 ID',
    user_id VARCHAR(50) NOT NULL COMMENT '用户 ID',
    wallet_id INT NOT NULL COMMENT '钱包 ID',
    token_address VARCHAR(42) NOT NULL COMMENT '代币合约地址',
    token_name VARCHAR(255) COMMENT '代币名称',
    token_symbol VARCHAR(50) COMMENT '代币符号',
    buy_amount DECIMAL(18, 8) NOT NULL COMMENT '购买金额 (BNB)',
    buy_price DECIMAL(36, 18) COMMENT '买入价格 (USD)',
    actual_buy_price DECIMAL(36, 18) COMMENT '实际买入价格 (USD/Token)',
    token_balance DECIMAL(36, 18) COMMENT '代币余额',
    usd_value DECIMAL(18, 8) COMMENT 'USD 价值',
    tx_hash VARCHAR(66) COMMENT '交易哈希',
    gas_used VARCHAR(20) COMMENT 'Gas 使用量',
    status VARCHAR(20) DEFAULT 'pending' COMMENT '状态 (pending/success/failed)',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',

    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_wallet_id (wallet_id),
    INDEX idx_user_created (user_id, created_at),
    INDEX idx_token_address (token_address),
    INDEX idx_tx_hash (tx_hash),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
COMMENT='狙击交易记录表';

-- ============================================
-- 5. 价格监控表 (price_monitors)
--  用于等待下跌后自动买入
-- ============================================
CREATE TABLE IF NOT EXISTS price_monitors (
  id INT PRIMARY KEY AUTO_INCREMENT COMMENT '记录 ID',
  user_id VARCHAR(50) NOT NULL COMMENT '用户 ID',
  wallet_id INT NOT NULL COMMENT '钱包 ID',
  token_address VARCHAR(42) NOT NULL COMMENT '代币合约地址',
  token_symbol VARCHAR(50) DEFAULT NULL COMMENT '代币符号',
  token_name VARCHAR(255) DEFAULT NULL COMMENT '代币名称',

  target_drop_percentage DECIMAL(10,2) NOT NULL COMMENT '触发下跌百分比 (%)',
  initial_price DECIMAL(36,18) DEFAULT 0 COMMENT '初始价格 (USD)',
  current_price DECIMAL(36,18) DEFAULT 0 COMMENT '当前价格 (USD)',
  lowest_price DECIMAL(36,18) DEFAULT 0 COMMENT '最低价格 (USD)',

  buy_amount DECIMAL(18,8) NOT NULL COMMENT '买入金额 (BNB)',
  slippage DECIMAL(5,2) NOT NULL COMMENT '滑点 (%)',
  gas_price INT NOT NULL COMMENT 'Gas 价格 (Gwei)',

  status VARCHAR(20) NOT NULL DEFAULT 'monitoring' COMMENT '状态 (monitoring/triggered/expired)',
  expires_at DATETIME DEFAULT NULL COMMENT '过期时间',
  triggered_at DATETIME DEFAULT NULL COMMENT '触发时间',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',

  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
  INDEX idx_pm_user (user_id),
  INDEX idx_pm_wallet (wallet_id),
  INDEX idx_pm_token (token_address),
  INDEX idx_pm_status (status),
  INDEX idx_pm_expires (expires_at),
  INDEX idx_pm_status_exp (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
COMMENT='价格监控：下跌触发自动买入';

-- 完成
SELECT '✅ Schema v2 created (users, wallets, TPSL with mode, sniper_records, price_monitors)' AS info;
