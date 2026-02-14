/**
 * 数据库操作函数（使用 Knex + MySQL）
 * 所有函数都使用 async/await，替代原来的回调风格
 */

// ============ 钱包状态管理 ============

/**
 * 设置钱包狙击状态
 */
async function setWalletSniperState(knex, walletId, isEnabled) {
  await knex('wallets')
    .where('id', walletId)
    .update({ sniper_enabled: isEnabled ? 1 : 0 });
}

async function setWalletSweepState(knex, walletId, isEnabled) {
  await knex('wallets')
    .where('id', walletId)
    .update({ sweep_enabled: isEnabled ? 1 : 0 });
}

/**
 * 获取用户是否有启用的狙击钱包
 */
async function getUserSniperStatus(knex, userId) {
  const result = await knex('wallets')
    .where({ user_id: userId, sniper_enabled: 1 })
    .count('* as count')
    .first();
  return result.count > 0;
}

/**
 * 获取当前激活钱包的狙击状态
 */
async function getActiveWalletSniperStatus(knex, userId) {
  const wallet = await knex('wallets')
    .where({ user_id: userId, is_active: 1 })
    .select('sniper_enabled')
    .first();
  return wallet ? wallet.sniper_enabled === 1 : false;
}

async function getActiveWalletSweepStatus(knex, userId) {
  const wallet = await knex('wallets')
    .where({ user_id: userId, is_active: 1 })
    .select('sweep_enabled')
    .first();
  return wallet ? wallet.sweep_enabled === 1 : false;
}

/**
 * 获取用户启用的狙击钱包
 */
async function getUserSniperWallets(knex, userId) {
  return await knex('wallets')
    .where({ user_id: userId, sniper_enabled: 1 })
    .select('*');
}

async function getUserSweepWallets(knex, userId) {
  return await knex('wallets')
    .where({ user_id: userId, sweep_enabled: 1 })
    .select('*');
}

// ============ 狙击记录管理 ============

/**
 * 添加狙击记录
 */
async function addSniperRecord(knex, userId, walletId, tokenAddress, tokenName, tokenSymbol, 
                                buyAmount, buyPrice, actualBuyPrice, tokenBalance, usdValue, 
                                txHash, gasUsed, status = 'success') {
  const [id] = await knex('sniper_records').insert({
    user_id: userId,
    wallet_id: walletId,
    token_address: tokenAddress,
    token_name: tokenName,
    token_symbol: tokenSymbol,
    buy_amount: buyAmount,
    buy_price: buyPrice,
    actual_buy_price: actualBuyPrice,
    token_balance: tokenBalance,
    usd_value: usdValue,
    tx_hash: txHash,
    gas_used: gasUsed,
    status: status
  });
  return id;
}

/**
 * 获取用户狙击记录
 */
async function getUserSniperRecords(knex, userId, limit = 20) {
  return await knex('sniper_records')
    .where('user_id', userId)
    .orderBy('created_at', 'desc')
    .limit(limit);
}

/**
 * 获取用户狙击统计
 */
async function getUserSniperStats(knex, userId) {
  const result = await knex('sniper_records')
    .where({ user_id: userId, status: 'success' })
    .select(
      knex.raw('COUNT(*) as total'),
      knex.raw('SUM(buy_amount) as total_amount'),
      knex.raw('AVG(buy_price) as avg_price'),
      knex.raw('AVG(actual_buy_price) as avg_actual_price'),
      knex.raw('SUM(usd_value) as total_usd_value')
    )
    .first();
  
  return {
    total: result.total || 0,
    total_amount: result.total_amount || 0,
    avg_price: result.avg_price || 0,
    avg_actual_price: result.avg_actual_price || 0,
    total_usd_value: result.total_usd_value || 0
  };
}

// ============ 用户管理 ============

/**
 * 创建或获取用户
 */
async function createOrGetUser(knex, userId, username, invitedBy = null) {
  // 先查询用户是否存在
  const user = await knex('users').where('user_id', userId).first();
  
  if (user) {
    return user;
  }
  
  // 创建新用户
  await knex('users').insert({
    user_id: userId,
    username: username,
    invited_by: invitedBy
  });
  
  // 如果有邀请人，更新邀请计数
  if (invitedBy) {
    await knex('users')
      .where('user_id', invitedBy)
      .increment('invite_count', 1);
  }
  
  return { user_id: userId, username, invited_by: invitedBy, invite_count: 0 };
}

// ============ 钱包管理 ============

/**
 * 获取用户所有钱包
 */
async function getUserWallets(knex, userId) {
  return await knex('wallets')
    .where('user_id', userId)
    .orderBy('wallet_number', 'asc');
}

/**
 * 获取用户当前激活的钱包
 */
async function getActiveWallet(knex, userId) {
  return await knex('wallets')
    .where({ user_id: userId, is_active: 1 })
    .first();
}

/**
 * 获取用户钱包数量
 */
async function getWalletCount(knex, userId) {
  const result = await knex('wallets')
    .where('user_id', userId)
    .count('* as count')
    .first();
  return result.count;
}

/**
 * 添加钱包
 */
async function addWallet(knex, userId, wallet) {
  // 获取当前钱包数量，确定新钱包编号
  const count = await getWalletCount(knex, userId);
  const walletNumber = count + 1;
  const isActive = count === 0 ? 1 : 0; // 第一个钱包默认激活
  
  const [id] = await knex('wallets').insert({
    user_id: userId,
    wallet_number: walletNumber,
    address: wallet.address,
    private_key: wallet.privateKey,
    mnemonic: wallet.mnemonic,
    is_active: isActive
  });
  
  return id;
}

/**
 * 切换激活的钱包
 */
async function switchActiveWallet(knex, userId, walletId) {
  // 使用事务确保原子性
  return await knex.transaction(async (trx) => {
    // 先将所有钱包设为非激活
    await trx('wallets')
      .where('user_id', userId)
      .update({ is_active: 0 });
    
    // 激活指定钱包
    const count = await trx('wallets')
      .where({ id: walletId, user_id: userId })
      .update({ is_active: 1 });
    
    return count > 0;
  });
}

/**
 * 更新钱包策略
 */
async function updateWalletStrategy(knex, walletId, userId, field, value) {
  const count = await knex('wallets')
    .where({ id: walletId, user_id: userId })
    .update({ [field]: value });
  return count > 0;
}

// ============ 止盈止损管理 ============

/**
 * 获取钱包的止盈止损配置（按模式）
 * mode: 'sniper' | 'sweep'（默认 sniper，以保持兼容）
 */
async function getTPSL(knex, walletId, type = null, mode = 'sniper') {
  let query = knex('take_profit_stop_loss')
    .where('wallet_id', walletId);
  if (type) {
    query = query.where('type', type);
  }
  if (mode) {
    query = query.where('mode', mode);
  }
  return await query.orderBy('price_percent', 'asc');
}

/**
 * 添加止盈止损（按模式）
 */
async function addTPSL(knex, walletId, type, pricePercent, sellPercent, mode = 'sniper') {
  const [id] = await knex('take_profit_stop_loss').insert({
    wallet_id: walletId,
    type: type,
    price_percent: pricePercent,
    sell_percent: sellPercent,
    mode: mode || 'sniper'
  });
  return id;
}

/**
 * 删除止盈止损
 */
async function deleteTPSL(knex, id, walletId) {
  const count = await knex('take_profit_stop_loss')
    .where({ id, wallet_id: walletId })
    .del();
  return count > 0;
}

/**
 * 清空某种类型的止盈止损（可选按模式）
 */
async function clearTPSL(knex, walletId, type, mode = 'sniper') {
  let q = knex('take_profit_stop_loss')
    .where({ wallet_id: walletId, type: type });
  if (mode) {
    q = q.andWhere('mode', mode);
  }
  const count = await q.del();
  return count;
}

// ============ 导出所有函数 ============

module.exports = {
  // 钱包状态
  setWalletSniperState,
  setWalletSweepState,
  getUserSniperStatus,
  getActiveWalletSniperStatus,
  getActiveWalletSweepStatus,
  getUserSniperWallets,
  getUserSweepWallets,
  
  // 狙击记录
  addSniperRecord,
  getUserSniperRecords,
  getUserSniperStats,
  
  // 用户管理
  createOrGetUser,
  
  // 钱包管理
  getUserWallets,
  getActiveWallet,
  getWalletCount,
  addWallet,
  switchActiveWallet,
  updateWalletStrategy,
  
  // 止盈止损
  getTPSL,
  addTPSL,
  deleteTPSL,
  clearTPSL
};
