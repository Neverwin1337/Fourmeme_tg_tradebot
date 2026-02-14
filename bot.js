require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { ethers } = require('ethers');
const path = require('path');
const fs = require('fs');

const BundleSubmitter = require('./utils/bundleSubmitter');
const { fork } = require('child_process');

const config = require('./config');
const createLogger = require('./utils/logger');
const knex = require('./db/knex');
const logger = createLogger('bot');
const { EventQueue } = require('./utils/eventQueue');
const { getTokenUsdPriceByRouter } = require('./lib/tokenPrice');
const formatUtils = require('./utils/format');
const tm2 = require('./services/tokenManager2');
const { localProvider, publicProvider } = require('./lib/providers');
const { waitForTransaction: waitForTransactionLib } = require('./lib/tx');
const { createTradeService } = require('./services/trade');
const { getTokenInfo: getTokenInfoLib, getTokenDynamicInfoV4: getTokenDynamicInfoV4Lib, getTokenMetaInfo: getTokenMetaInfoLib } = require('./lib/tokenInfo');
const { createScannerService } = require('./services/scanner');
const { checkTokenAgainstStrategy, checkSingleWalletStrategy, checkSingleWalletSweepStrategy } = require('./services/strategy');
const sweepLogger = require('./utils/sweepLogger');

// (移除放错位置的扫链处理程序，稍后在合适位置重新注册)

// 测试数据库连接

// PancakeSwap V2 合约地址
const PANCAKE_ROUTER_V2 = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';




// FeeCollector 合约配置（需要先部署合约）
// 如果还没部署，请先运行: npm run deploy
const FEE_COLLECTOR_ADDRESS = config.feeCollectorAddress || '0x16867Ce6E979A4694d93E5ae81EDC0831A43D714'; // 从环境变量读取


// PancakeSwap Router V2 ABI (简化版)
const PANCAKE_ROUTER_ABI = [
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external",
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function WETH() external pure returns (address)"
];

// 最小 ERC20 ABI，用于读取余额与精度
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

// FeeCollector 合约 ABI
const FEE_COLLECTOR_ABI = [
  "function swapBNBForTokens(address tokenOut, uint256 amountOutMin, uint256 deadline, bool supportFeeOnTransfer) external payable",
  "function swapTokensForBNB(address tokenIn, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bool supportFeeOnTransfer) external",
  "function swapTokensForTokens(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bool supportFeeOnTransfer) external",
  "function calculateFee(uint256 amount) external view returns (uint256 feeAmount, uint256 netAmount)",
  "function feePercentage() external view returns (uint256)"
];

// TokenManager2 (V2) 地址与最小 ABI（仅用到的接口）
const TM2_ADDRESS = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';



async function getTokenMode(tokenAddress) {
  try {
    return await tm2.getTokenMode(tokenAddress);
  } catch {
    return 0;
  }
}

function getTM2Contract(signer) {
  return tm2.getTM2Contract(signer);
}

async function buyViaTokenManager2({ signer, tokenAddress, fundsWei, minAmount = 0n, gasGwei, gasLimit = 200000n, nonce }) {
  return tm2.buyViaTokenManager2({ signer, tokenAddress, fundsWei, minAmount, gasGwei, gasLimit, nonce });
}

async function sellViaTokenManager2({ signer, tokenAddress, amount, gasGwei, gasLimit = 200000n, nonce }) {
  return tm2.sellViaTokenManager2({ signer, tokenAddress, amount, gasGwei, gasLimit, nonce });
}

// ============ Markdown 转义函数 ============
// 对 Telegram Markdown 特殊字符进行转义，防止解析错误
function escapeMarkdown(text) {
  return formatUtils.escapeMarkdown(text);
}

function getPriceFromWorker(tokenAddress, timeoutMs = 1500) {
  if (!priceWorker) startPriceWorker();
  const id = ++workerReqId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      workerPending.delete(id);
      resolve(0);
    }, timeoutMs);
    workerPending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(toNumberSafe(msg.price, 0));
    });
    try {
      safeWorkerSend({ type: 'get_price', token: tokenAddress, id });
    } catch {
      clearTimeout(timer);
      workerPending.delete(id);
      resolve(0);
    }
  });
}

const { toNumberSafe } = require('./utils/helpers');



// ============ RPC Provider 创建 ============
// 简化版：直接创建 Provider，不需要速率限制

// ============ 事件处理并发控制 ============
// 限制同时处理的事件数量，防止资源耗尽

// 创建全局事件队列，限制同时处理 10 个事件
const eventQueue = new EventQueue(10);

// 定期输出队列统计信息（每 5 分钟）

// 通过 Pancake V2 Router 获取 Token 的 USD 价格



// 卖出操作锁 - 防止并发卖出导致重复 approve
// Map<walletId_tokenAddress, Promise>
const sellLocks = new Map();

function getTokenKey(tokenAddress) {
  return (tokenAddress || '').toLowerCase();
}

let priceWorker = null;
let workerReqId = 0;
const workerPending = new Map();
let priceWorkerRestartAttempts = 0; // 指数退避重启计数
const workerOutbox = []; // 子进程未连通时待发送队列

const signerCache = new Map();
const feeCollectorCache = new Map();

function startPriceWorker() {
  if (priceWorker) return;
  const workerPath = path.join(__dirname, 'utils', 'priceWorker.js');
  priceWorker = fork(workerPath, [], {
    env: process.env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  });
  priceWorker.on('message', async (msg) => {
    try {
      if (!msg || !msg.type) return;
      if (msg.type === 'ready') {
        try { priceWorker.send({ type: 'start', intervalMs: 500 }); } catch { }
        // 子进程就绪，重置重启计数并刷新待发队列
        priceWorkerRestartAttempts = 0;
        try {
          while (workerOutbox.length > 0) {
            const msg0 = workerOutbox.shift();
            try { priceWorker.send(msg0); } catch { }
          }
        } catch { }
      } else if (msg.type === 'limit_hit') {
        const { token, price, listener } = msg;
        const userId = listener.userId;
        const walletId = listener.walletId;
        const buyAmount = toNumberSafe(listener.buyAmount, 0);
        const slippage = toNumberSafe(listener.slippage, 10);
        const gasPrice = toNumberSafe(listener.gasPrice, 5);
        try {
          const result = await autoBuyToken(
            userId,
            token,
            buyAmount,
            slippage,
            gasPrice,
            walletId,
            listener.walletData || null,
            'sniper'  // 限价单触发使用狙击模式
          );
          if (result && result.success) {
            const baseline = toNumberSafe(result.baselineUsdPrice, 0) || toNumberSafe(price, 0);
            await addTPSLListenersToWorker(userId, walletId, token, baseline, listener.walletData || null);
          }
        } catch (e) { }
      } else if (msg.type === 'tp_hit') {
        const { token, listener } = msg;
        const userId = listener.userId;
        const walletId = listener.walletId;
        const sellPercent = toNumberSafe(listener.sellPercent, 0);
        const slippage = toNumberSafe(listener.slippage, 10);
        const gasPrice = toNumberSafe(listener.gasPrice, 5);
        if (sellPercent > 0) {
          try { await autoSellToken(userId, walletId, token, sellPercent, slippage, gasPrice, listener.walletData || null); } catch { }
        }
      } else if (msg.type === 'sl_hit') {
        const { token, listener } = msg;
        const userId = listener.userId;
        const walletId = listener.walletId;
        const sellPercent = toNumberSafe(listener.sellPercent, 0);
        const slippage = toNumberSafe(listener.slippage, 10);
        const gasPrice = toNumberSafe(listener.gasPrice, 5);
        if (sellPercent > 0) {
          try { await autoSellToken(userId, walletId, token, sellPercent, slippage, gasPrice, listener.walletData || null); } catch { }
        }
      } else if (msg.type === 'price') {
        if (msg.id && workerPending.has(msg.id)) {
          try { workerPending.get(msg.id)(msg); } catch { } finally { workerPending.delete(msg.id); }
        }
      }
    } catch { }
  });
  const schedulePriceWorkerRestart = (reason) => {
    try { if (priceWorker) { priceWorker.removeAllListeners(); try { priceWorker.kill(); } catch { } } } catch { }
    priceWorker = null;
    try { workerPending.clear(); } catch { }
    const attempt = Math.min(priceWorkerRestartAttempts++, 6);
    const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
    console.error(`priceWorker not available (${reason}). Restarting in ${delay}ms ...`);
    setTimeout(() => startPriceWorker(), delay);
  };
  priceWorker.on('disconnect', () => schedulePriceWorkerRestart('disconnect'));
  priceWorker.on('error', () => schedulePriceWorkerRestart('error'));
  priceWorker.on('exit', () => schedulePriceWorkerRestart('exit'));
}

function safeWorkerSend(msg) {
  try {
    if (!priceWorker) startPriceWorker();
    // 如果通道不可用，则入队并触发重启
    if (!priceWorker || priceWorker.connected === false) {
      workerOutbox.push(msg);
      // 触发一次重启（若未在重启中）
      try { priceWorker.kill(); } catch { }
      priceWorker = null;
      startPriceWorker();
      return;
    }
    priceWorker.send(msg);
  } catch (e) {
    // 发送失败，缓存消息并重启
    try { workerOutbox.push(msg); } catch { }
    try { if (priceWorker) priceWorker.kill(); } catch { }
    priceWorker = null;
    startPriceWorker();
  }
}

async function addLimitListenerToWorker(userId, walletId, tokenAddress, initial, dropPct, buyAmount, slippage, gasPrice, walletOverride = null) {
  if (!priceWorker) startPriceWorker();
  let walletData = null;
  if (walletOverride && walletOverride.address && walletOverride.private_key) {
    walletData = {
      id: walletOverride.id,
      address: walletOverride.address,
      private_key: walletOverride.private_key,
      wallet_number: walletOverride.wallet_number,
      bribe_amount: walletOverride.bribe_amount
    };
  } else {
    try {
      if (walletId) {
        const w = await knex('wallets')
          .where({ id: walletId, user_id: userId, sniper_enabled: 1 })
          .first();
        if (w) {
          walletData = {
            id: w.id,
            address: w.address,
            private_key: w.private_key,
            wallet_number: w.wallet_number,
            bribe_amount: w.bribe_amount
          };
        }
      }
    } catch { }
  }
  const listener = {
    kind: 'limit',
    userId,
    walletId,
    walletData,
    initial: toNumberSafe(initial, 0),
    dropPct: toNumberSafe(dropPct, 0),
    buyAmount: toNumberSafe(buyAmount, 0),
    slippage: toNumberSafe(slippage, 10),
    gasPrice: toNumberSafe(gasPrice, 5),
    triggered: false
  };
  safeWorkerSend({ type: 'add_listener', token: tokenAddress, listener });
}

async function addTPSLListenersToWorker(userId, walletId, tokenAddress, baselinePrice, walletOverride = null, mode = 'sniper') {
  if (!priceWorker) startPriceWorker();
  // 根据模式选择日志记录器
  const logger = mode === 'sweep' ? sweepLogger : console;

  try {
    const [takeProfits, stopLosses] = await Promise.all([
      db.getTPSL(knex, walletId, 'take_profit', mode),
      db.getTPSL(knex, walletId, 'stop_loss', mode)
    ]);
    const tpList = takeProfits || [];
    const slList = stopLosses || [];

    if (tpList.length === 0 && slList.length === 0) {
      logger.log(`ℹ️ 代币 ${tokenAddress.slice(0, 8)}... 没有设置止盈止损 (模式=${mode})`);
      return;
    }

    logger.log(`📊 添加止盈止损监听器: 代币=${tokenAddress.slice(0, 8)}... 模式=${mode} 基准价=$${toNumberSafe(baselinePrice, 0).toFixed(8)} 止盈=${tpList.length}个 止损=${slList.length}个`);

    let wallet = walletOverride;
    if (!wallet) {
      try { wallet = await knex('wallets').where({ id: walletId, user_id: userId }).first(); } catch { }
    }
    const walletData = wallet ? {
      id: wallet.id,
      address: wallet.address,
      private_key: wallet.private_key,
      wallet_number: wallet.wallet_number,
      bribe_amount: wallet.bribe_amount
    } : null;
    for (const tp of tpList) {
      const baseline = toNumberSafe(baselinePrice, 0);
      const percent = toNumberSafe(tp.price_percent, 0);
      const targetPrice = baseline * (1 + percent / 100);
      logger.log(`  🎯 止盈: +${percent}% → $${targetPrice.toFixed(8)} (卖${tp.sell_percent}%)`);
      const listener = {
        kind: 'tp',
        userId,
        walletId,
        walletData,
        baseline,
        percent,
        sellPercent: toNumberSafe(tp.sell_percent, 0),
        slippage: 10,
        gasPrice: 5,
        triggered: false,
        mode: mode  // 添加模式信息，供 priceWorker 使用
      };
      safeWorkerSend({ type: 'add_listener', token: tokenAddress, listener });
    }
    for (const sl of slList) {
      const baseline = toNumberSafe(baselinePrice, 0);
      const percent = Math.abs(toNumberSafe(sl.price_percent, 0));
      const targetPrice = baseline * (1 - percent / 100);
      logger.log(`  🛑 止损: -${percent}% → $${targetPrice.toFixed(8)} (卖${sl.sell_percent}%)`);
      const listener = {
        kind: 'sl',
        userId,
        walletId,
        walletData,
        baseline,
        percent,
        sellPercent: toNumberSafe(sl.sell_percent, 0),
        slippage: 10,
        gasPrice: 5,
        triggered: false,
        mode: mode  // 添加模式信息，供 priceWorker 使用
      };
      safeWorkerSend({ type: 'add_listener', token: tokenAddress, listener });
    }
  } catch (e) {
    logger.error(`❌ 添加止盈止损监听器失败: ${e.message}`);
  }
}


// 启动价格监听（按代币分组，共享价格查询）


// 检查单个监听者的止盈止损


// 简化版启动函数（向后兼容）


// 初始化机器人
const bot = new Telegraf(config.botToken);

// ============ 全局错误处理 ============
// 捕获所有未处理的错误，防止机器人崩溃
bot.catch((err, ctx) => {
  console.error('❌ Bot 错误:', err);
  try {
    // 尝试通知用户
    if (ctx && ctx.answerCbQuery) {
      ctx.answerCbQuery('❌ 操作失败，请重试').catch(() => { });
    }
    if (ctx && ctx.reply) {
      ctx.reply('❌ 操作失败，请使用 /start 重新开始').catch(() => { });
    }
  } catch (notifyError) {
    console.error('通知用户错误失败:', notifyError);
  }
});

// MySQL 数据库已通过 Knex 连接（参见文件顶部配置）

// 引入数据库操作函数
const db = require('./database');

// 用户输入状态管理
const { setUserInputState, getUserInputState, clearUserInputState, pruneOldStates } = require('./utils/userInputState');

// ============================================
// 数据库函数已移至 database.js（使用 Knex + MySQL）
// ============================================

// 为用户创建新钱包（工具函数）
function createWallet(userId) {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic.phrase,
    createdAt: new Date().toISOString()
  };
}

// 懒加载 Trade 服务，保持对外接口不变
let __tradeService = null;
function ensureTradeService() {
  if (!__tradeService) {
    __tradeService = createTradeService({ bot, sendInviteCommission, getTokenInfo, getTokenMetaInfo });
  }
  return __tradeService;
}

// 增强的交易等待函数（处理 RPC indexing 错误）
async function waitForTransaction(tx, maxRetries = 5, initialDelay = 2000) {
  return await waitForTransactionLib(tx, maxRetries, initialDelay);
}

// 获取钱包余额（使用 ethers.js）
async function getWalletBalance(address) {
  try {
    const balance = await publicProvider.getBalance(address);
    return ethers.formatEther(balance);
  } catch (error) {
    console.error('获取余额失败:', error);
    return '0';
  }
}

// 使用 pending transactions 监听新币发布
const CONTRACT_ADDRESS = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';
const FUNCTION_SELECTOR = '0xe3412e3d'; // 发布代币的 function selector

// 扫描器运行状态（保留字段以兼容原有调用，但实际委托给服务）
const scannerState = {
  starting: false,
  running: false,
  provider: null,
  websocket: null,
  subscriptionId: null,
  reconnectTimer: null,
  shouldStop: false,
  reconnectAttempts: 0,
  maxReconnectAttempts: 10
};

// 委托到扫描器服务
let __scannerService = null;
function ensureScannerService() {
  if (!__scannerService) {
    __scannerService = createScannerService({
      wsUrl: config.rpc.ws,
      contractAddress: CONTRACT_ADDRESS,
      functionSelector: FUNCTION_SELECTOR,
      eventQueue,
      knex,
      db,
      getTokenInfo: getTokenInfo,
      getTokenMetaInfo: getTokenMetaInfo,
      getTokenDynamicInfoV4: getTokenDynamicInfoV4,
      toNumberSafe,
      getTokenUsdPriceByRouter,
      addLimitListenerToWorker,
      addTPSLListenersToWorker,
      autoBuyToken,
      checkSingleWalletStrategy,
      logger: console
    });
  }
  return __scannerService;
}

function cleanupScanner() {
  scannerState.shouldStop = true;
  return ensureScannerService().stop();
}

async function initEventScanner() {
  return ensureScannerService().start();
}

// 获取代币详细信息
async function getTokenInfo(contractAddress) {
  return await getTokenInfoLib(contractAddress);
}

// 动态信息（v4，容错 code=="000000"）
async function getTokenDynamicInfoV4(contractAddress) {
  return await getTokenDynamicInfoV4Lib(contractAddress);
}

// ============================================
// 邀请返佣系统
// ============================================

/**
 * 发送邀请返佣
 * @param {string} userId - 用户ID
 * @param {string} fromWallet - 发送方钱包（用户的钱包）
 * @param {string} bnbAmount - BNB 金额（字符串）
 * @param {string} type - 类型 'buy' 或 'sell'
 */
async function sendInviteCommission(userId, fromWallet, bnbAmount, type = 'buy') {
  try {
    // 1. 获取用户信息，检查是否有邀请人
    const user = await knex('users').where('user_id', userId).first();

    if (!user || !user.invited_by) {
      // 没有邀请人，无需返佣
      return { success: false, reason: 'no_inviter' };
    }

    const inviterId = user.invited_by;
    console.log(`💝 用户 ${userId} 有邀请人 ${inviterId}，准备发送返佣...`);

    // 2. 获取邀请人的任意一个钱包地址
    const inviterWallet = await knex('wallets')
      .where('user_id', inviterId)
      .orderBy('id', 'asc')  // 取第一个钱包
      .first();

    if (!inviterWallet) {
      console.warn(`⚠️ 邀请人 ${inviterId} 没有钱包，无法发送返佣`);
      return { success: false, reason: 'no_inviter_wallet' };
    }

    // 3. 计算返佣金额（千分之一 = 0.1%）
    const bnbAmountBigInt = ethers.parseEther(bnbAmount.toString());
    const commissionAmount = bnbAmountBigInt / 1000n; // 千分之一

    // 无论金额多小都返佣（移除最小金额限制）
    if (commissionAmount === 0n) {

      return { success: false, reason: 'amount_zero' };
    }


    // 4. 创建发送方的钱包实例
    const senderWallet = new ethers.Wallet(fromWallet.private_key, localProvider);

    // 5. 获取当前 Gas 价格
    const feeData = await localProvider.getFeeData();
    const gasPrice = feeData.gasPrice;

    // 6. 发送 BNB 转账

    const tx = await senderWallet.sendTransaction({
      to: inviterWallet.address,
      value: commissionAmount,
      gasPrice: gasPrice,
      gasLimit: 21000
    });

    console.log(`📝 返佣交易已提交: ${tx.hash}`);

    // 7. 等待确认（增强版，处理 RPC indexing 错误）
    const receipt = await waitForTransaction(tx);

    if (receipt.status === 1) {


      // 8. 通知邀请人（可选）
      try {
        const typeText = type === 'buy' ? '买入' : '卖出';
        const message = `💝 *邀请返佣通知*\n\n` +
          `您的好友进行了${typeText}操作\n` +
          `返佣金额: ${ethers.formatEther(commissionAmount)} BNB\n` +
          `接收地址: \`${inviterWallet.address}\`\n\n` +
          `交易哈希: \`${tx.hash}\`\n` +
          `https://bscscan.com/tx/${tx.hash}`;

        await bot.telegram.sendMessage(inviterId, message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        }).catch(err => console.log('发送返佣通知失败:', err.message));
      } catch (notifyError) {
        console.log('通知邀请人失败:', notifyError.message);
      }

      return {
        success: true,
        amount: ethers.formatEther(commissionAmount),
        txHash: tx.hash,
        inviterId: inviterId,
        inviterAddress: inviterWallet.address
      };
    } else {
      throw new Error('返佣交易失败');
    }

  } catch (error) {
    console.error(`❌ 发送邀请返佣失败:`, error);
    return {
      success: false,
      reason: 'transaction_failed',
      error: error.message
    };
  }
}

// 自动购买代币
async function autoBuyToken(userId, tokenAddress, buyAmount, slippage, gasPrice, walletId = null, walletOverride = null) {
  return await ensureTradeService().autoBuyToken(userId, tokenAddress, buyAmount, slippage, gasPrice, walletId, walletOverride);
}

// ============================================
// 价格监控功能
// ============================================

// 创建价格监控记录


// 价格监控检查器（定期运行）
async function checkPriceMonitors() {
  try {
    // 获取所有活跃的价格监控
    const monitors = await knex('price_monitors')
      .where('status', 'monitoring')
      .where(builder => {
        builder.where('expires_at', '>', new Date()).orWhereNull('expires_at');
      });

    if (monitors.length === 0) {
      return;
    }

    console.log(`📊 检查 ${monitors.length} 个价格监控...`);

    // 并行处理所有监控
    const promises = monitors.map(async (monitor) => {
      try {
        // 获取当前价格
        const currentPrice = await getCurrentTokenPrice(monitor.token_address);
        if (!currentPrice || currentPrice <= 0) {
          console.warn(`⚠️ 无法获取代币 ${monitor.token_symbol} 的价格`);
          return;
        }

        // 更新当前价格和最低价格
        let init = toNumberSafe(monitor.initial_price, 0);
        const curr = toNumberSafe(currentPrice, 0);
        const lowest = toNumberSafe(monitor.lowest_price ?? curr, curr);
        if (init <= 0 && curr > 0) {
          await knex('price_monitors')
            .where('id', monitor.id)
            .update({ initial_price: curr });
          init = curr;
        }
        const updateData = {
          current_price: curr,
          lowest_price: Math.min(lowest, curr)
        };

        await knex('price_monitors')
          .where('id', monitor.id)
          .update(updateData);

        // 计算当前下跌百分比
        const dropPercentage = init > 0 ? ((init - curr) / init) * 100 : 0;

        console.log(`📊 ${monitor.token_symbol}: 初始$${toNumberSafe(monitor.initial_price, 0).toFixed(8)} -> 当前$${curr.toFixed(8)} (${dropPercentage.toFixed(2)}%)`);

        // 检查是否达到目标下跌百分比
        const targetDrop = toNumberSafe(monitor.target_drop_percentage, 0);
        if (dropPercentage >= targetDrop) {
          if (monitorBuyLocks.has(monitor.id)) {
            return; // 已在进行中，避免并发
          }
          monitorBuyLocks.set(monitor.id, true);
          try {
            console.log(`🎯 ${monitor.token_symbol} 达到目标下跌 ${monitor.target_drop_percentage}%，触发买入！`);

            const triggerMessage = `🎯 *价格监控触发*\n\n` +
              `🪙 *代币:* ${monitor.token_name} (${monitor.token_symbol})\n` +
              `📉 *价格下跌:* ${dropPercentage.toFixed(2)}%\n` +
              `💰 *触发价格:* $${curr.toFixed(8)}\n\n` +
              `🚀 *开始自动买入...*`;
            await bot.telegram.sendMessage(monitor.user_id, triggerMessage, {
              parse_mode: 'Markdown',
              disable_web_page_preview: true
            });

            const monitorWallet = await knex('wallets')
              .where({ id: monitor.wallet_id, user_id: monitor.user_id, sniper_enabled: 1 })
              .first()
              .catch(() => null);

            const result = await autoBuyToken(
              monitor.user_id,
              monitor.token_address,
              monitor.buy_amount,
              monitor.slippage,
              monitor.gas_price,
              monitor.wallet_id,
              monitorWallet || null,
              'sniper'  // 价格监控使用狙击模式
            );

            if (result && result.success) {
              await knex('price_monitors')
                .where('id', monitor.id)
                .update({
                  status: 'triggered',
                  triggered_at: new Date()
                });
            } else {
              await bot.telegram.sendMessage(monitor.user_id, `❌ 自动买入失败，稍后将重试\n错误: ${result && result.error ? result.error : '未知错误'}`, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
              }).catch(() => { });
            }
          } catch (buyErr) {
            console.error('价格监控买入失败:', buyErr.message || buyErr);
            try {
              await bot.telegram.sendMessage(monitor.user_id, `❌ 自动买入失败\n错误: ${buyErr.message || buyErr}`, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
              });
            } catch { }
          } finally {
            monitorBuyLocks.delete(monitor.id);
          }
        }

      } catch (error) {
        console.error(`❌ 检查价格监控失败 (${monitor.token_symbol}):`, error);
      }
    });

    await Promise.allSettled(promises);

  } catch (error) {
    console.error('❌ 价格监控检查器失败:', error);
  }
}

// 获取代币当前价格
async function getCurrentTokenPrice(tokenAddress) {
  try {
    // 优先从子进程价格字典获取
    const pWorker = await getPriceFromWorker(tokenAddress);
    if (pWorker > 0) return pWorker;
    // 再次回退 Router/API
    const routerPrice = await getTokenUsdPriceByRouter(tokenAddress);
    const p1 = toNumberSafe(routerPrice, 0);
    if (p1 > 0) return p1;
    const tokenInfo = await getTokenInfo(tokenAddress);
    return toNumberSafe(tokenInfo?.price, 0);
  } catch (error) {
    console.error(`获取代币价格失败 (${tokenAddress}):`, error);
    return 0;
  }
}

// 清理过期的价格监控
async function cleanupExpiredMonitors() {
  try {
    const expiredCount = await knex('price_monitors')
      .where('expires_at', '<', new Date())
      .where('status', 'monitoring')
      .update({ status: 'expired' });

    if (expiredCount > 0) {
      console.log(`🧹 清理了 ${expiredCount} 个过期的价格监控`);
    }
  } catch (error) {
    console.error('❌ 清理过期监控失败:', error);
  }
}

// 启动价格监控定时器
let priceMonitorInterval = null;
let priceMonitorRunning = false;

function startPriceMonitorScheduler() {
  if (priceMonitorInterval) {
    clearInterval(priceMonitorInterval);
  }

  // 每30秒检查一次价格
  priceMonitorInterval = setInterval(async () => {
    if (priceMonitorRunning) return;
    priceMonitorRunning = true;
    try {
      await checkPriceMonitors();
      await cleanupExpiredMonitors();
    } finally {
      priceMonitorRunning = false;
    }
  }, 1000);

  console.log('✅ 价格监控调度器已启动 (30秒间隔)');
}

function stopPriceMonitorScheduler() {
  if (priceMonitorInterval) {
    clearInterval(priceMonitorInterval);
    priceMonitorInterval = null;
    console.log('⏹️ 价格监控调度器已停止');
  }
}

// 自动卖出代币
async function autoSellToken(userId, walletId, tokenAddress, sellPercent, slippage, gasPrice, walletOverride = null) {
  return await ensureTradeService().autoSellToken(userId, walletId, tokenAddress, sellPercent, slippage, gasPrice, walletOverride);
}



// 策略检查函数已从 services/strategy.js 导入，不再在此重复定义

// 扫链事件监听
const sweepState = { provider: null, contract: null, running: false, lastSuccessTime: 0 };
let sweepReconnectAttempts = 0;
let sweepReconnectTimer = null;
let sweepHeartbeatTimer = null;
const sweepRecent = new Set(); // 防止同钱包1小时内重复
const sweepTokenGate = new Set(); // 同一代币1秒内只处理一次（全局）

async function startSweepScanner() {
  if (sweepState.running) {
    sweepLogger.log('⚠️ 扫链监听已在运行中，跳过重复启动');
    return;
  }
  try {
    const wsUrl = config.rpc.ws;
    const abiPath = path.join(__dirname, 'TokenManager2.lite.abi');
    const abi = JSON.parse(fs.readFileSync(abiPath, 'utf-8'));
    const provider = new ethers.WebSocketProvider(wsUrl);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);

    const handleEvent = async (...args) => {
      try {
        const event = args[args.length - 1];
        const [token] = args;
        const tokenAddress = (token || '').toString();
        if (!ethers.isAddress(tokenAddress)) return;
        // 1) 代币级节流：同一个代币1秒内只处理一次
        const gateKey = tokenAddress.toLowerCase();
        if (sweepTokenGate.has(gateKey)) return;
        sweepTokenGate.add(gateKey);
        setTimeout(() => sweepTokenGate.delete(gateKey), 1000);
        const [dynamicInfo, metaInfo] = await Promise.all([
          getTokenDynamicInfoV4(tokenAddress),
          getTokenMetaInfo(tokenAddress)
        ]);
        if (!dynamicInfo) return;


        const users = await knex('wallets').where('sweep_enabled', 1).distinct('user_id').select('user_id');
        await Promise.all(users.map(async (u) => {
          // 同一个人不要买第二次：如果该用户已经买过此代币（pending/success），则跳过
          try {
            const already = await knex('sniper_records')
              .where('user_id', u.user_id)
              .andWhereRaw('LOWER(token_address) = ?', tokenAddress.toLowerCase())
              .whereIn('status', ['pending', 'success'])
              .first();
            if (already) return; // 已买过，跳过该用户
          } catch (e) { }

          const wallets = await db.getUserSweepWallets(knex, u.user_id);
          for (const w of wallets) {
            const key = `${w.id}_${tokenAddress.toLowerCase()}`;
            if (sweepRecent.has(key)) continue;
            const strategy = await checkSingleWalletSweepStrategy(w, dynamicInfo, metaInfo);

            if (strategy.match) {
              sweepRecent.add(key);
              setTimeout(() => sweepRecent.delete(key), 60 * 60 * 1000);
              try {
                const result = await autoBuyToken(
                  u.user_id,
                  tokenAddress,
                  toNumberSafe(w.sweep_buy_amount, toNumberSafe(w.buy_amount, 0.01)),
                  toNumberSafe(w.sweep_slippage, toNumberSafe(w.slippage, 10)),
                  toNumberSafe(w.sweep_gas_price, toNumberSafe(w.gas_price, 5)),
                  w.id,
                  w,
                  'sweep'  // 扫链模式
                );
                if (result && result.success) {
                  sweepLogger.log(`   💰 购买成功！`);
                  const baseline = toNumberSafe(result.baselineUsdPrice, 0) || toNumberSafe(await getTokenUsdPriceByRouter(tokenAddress), 0);
                  try {
                    const name = (metaInfo && metaInfo.name) ? metaInfo.name : 'Unknown';
                    const symbol = (metaInfo && metaInfo.symbol) ? metaInfo.symbol : '';
                    const title = symbol ? `${name} (${symbol})` : name;
                    const createTimeStr = metaInfo?.createTime ? new Date(metaInfo.createTime).toLocaleString('zh-CN') : '未知';
                    sweepLogger.log(`   📊 代币信息: ${title}, 地址: ${tokenAddress}, 发射时间: ${createTimeStr}`);
                    await bot.telegram.sendMessage(
                      u.user_id,
                      `🧹 扫链已自动购买\n\n${title}\n\`${tokenAddress}\`\n\n⏰ 发射时间: ${createTimeStr}`,
                      { parse_mode: 'Markdown', disable_web_page_preview: true }
                    );
                  } catch { }
                  await addTPSLListenersToWorker(u.user_id, w.id, tokenAddress, baseline, w, 'sweep');
                } else {
                  sweepLogger.error(`   ❌ 购买失败: ${result?.error || '未知错误'}`);
                }
              } catch (e) {
                sweepLogger.error(`   ❌ 购买异常:`, e.message || e);
              }
            }
          }
        }));
      } catch (e) { }
    };

    contract.on('TokenPurchase', handleEvent);
    contract.on('TokenSale', handleEvent);
    sweepState.provider = provider;
    sweepState.contract = contract;
    sweepState.running = true;
    sweepState.lastSuccessTime = Date.now();

    // 重置重连计数（连接成功）
    sweepReconnectAttempts = 0;
    sweepLogger.log('✅ 扫链事件监听已启动');

    const scheduleSweepRestart = (reason) => {
      // 清理心跳定时器
      if (sweepHeartbeatTimer) {
        clearInterval(sweepHeartbeatTimer);
        sweepHeartbeatTimer = null;
      }

      // 清理现有连接
      try { if (sweepState.contract) sweepState.contract.removeAllListeners(); } catch { }
      try { if (sweepState.provider) sweepState.provider.destroy().catch(() => { }); } catch { }
      sweepState.provider = null;
      sweepState.contract = null;
      sweepState.running = false;

      // 计算重连延迟（指数退避）
      const attempt = Math.min(sweepReconnectAttempts, 10);
      sweepReconnectAttempts++;
      const delay = Math.min(1000, 1000 * Math.pow(1.5, attempt)); // 最多60秒

      // 如果连接刚建立就断开（小于5秒），使用更长的延迟
      const uptime = Date.now() - sweepState.lastSuccessTime;
      const actualDelay = uptime < 5000 ? Math.max(delay, 10000) : delay;

      if (sweepReconnectTimer) {
        clearTimeout(sweepReconnectTimer);
        sweepReconnectTimer = null;
      }

      sweepLogger.error(`⚠️ Sweep WS断开 (${reason}), 重连次数: ${sweepReconnectAttempts}, ${actualDelay}ms后重连...`);

      sweepReconnectTimer = setTimeout(() => {
        sweepReconnectTimer = null;
        startSweepScanner();
      }, actualDelay);
    };

    // 设置心跳保活（每30秒）
    sweepHeartbeatTimer = setInterval(async () => {
      try {
        if (sweepState.provider && sweepState.running) {
          // 发送一个简单的查询保持连接活跃
          await sweepState.provider.getBlockNumber();
        }
      } catch (e) {
        sweepLogger.error('扫链心跳检测失败:', e.message);
        scheduleSweepRestart('heartbeat_failed');
      }
    }, 30000);

    // 监听WebSocket事件
    provider.on('error', (error) => {
      sweepLogger.error('扫链Provider错误:', error.message || error);
      scheduleSweepRestart('provider_error');
    });

    provider.on('close', () => {
      sweepLogger.log('扫链Provider关闭');
      scheduleSweepRestart('provider_close');
    });

    // 尝试访问底层WebSocket（ethers v6）
    try {
      const ws = provider.websocket;
      if (ws) {
        ws.on('error', (err) => {
          sweepLogger.error('扫链WS底层错误:', err.message || err);
        });
        ws.on('close', (code, reason) => {
          sweepLogger.log(`扫链WS底层关闭: code=${code}, reason=${reason}`);
        });
      }
    } catch { }
  } catch (e) {
    sweepLogger.error('启动扫链监听失败:', e.message || e);
  }
}

async function stopSweepScanner() {
  // 清理重连定时器
  if (sweepReconnectTimer) {
    clearTimeout(sweepReconnectTimer);
    sweepReconnectTimer = null;
  }

  // 清理心跳定时器
  if (sweepHeartbeatTimer) {
    clearInterval(sweepHeartbeatTimer);
    sweepHeartbeatTimer = null;
  }

  // 清理事件监听
  try {
    if (sweepState.contract) {
      sweepState.contract.removeAllListeners('TokenPurchase');
      sweepState.contract.removeAllListeners('TokenSale');
    }
  } catch { }

  // 清理Provider
  try {
    if (sweepState.provider) {
      sweepState.provider.removeAllListeners();
      await sweepState.provider.destroy();
    }
  } catch { }

  sweepState.provider = null;
  sweepState.contract = null;
  sweepState.running = false;
  sweepReconnectAttempts = 0;

  sweepLogger.log('⏹️ 扫链事件监听已停止');
}

// 获取代币元数据信息
async function getTokenMetaInfo(contractAddress) {
  return await getTokenMetaInfoLib(contractAddress);
}

// 广播消息给所有用户
async function broadcastToAllUsers(message) {
  try {
    const users = await knex('users')
      .distinct('user_id')
      .select('user_id');

    if (!users || users.length === 0) {
      console.log('没有用户');
      return;
    }

    console.log(`📢 向 ${users.length} 个用户广播消息...`);

    for (const user of users) {
      try {
        await bot.telegram.sendMessage(user.user_id, message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        });
      } catch (error) {
        console.error(`发送消息给用户 ${user.user_id} 失败:`, error.message);
      }
    }
  } catch (error) {
    console.error('广播消息失败:', error);
  }
}


// 主菜单键盘
async function getMainMenuKeyboard(userId) {
  const hasSniperEnabled = await db.getActiveWalletSniperStatus(knex, userId);
  const hasSweepEnabled = await db.getActiveWalletSweepStatus(knex, userId);
  const sniperButton = hasSniperEnabled ?
    Markup.button.callback('⏸️ 暂停狙击', 'stop_sniper') :
    Markup.button.callback('🚀 启动狙击', 'start_sniper');
  const sweepButton = hasSweepEnabled ?
    Markup.button.callback('🛑 停止扫链', 'stop_sweep') :
    Markup.button.callback('🧹 启动扫链', 'start_sweep');
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('💎 我的钱包', 'my_wallet'),
      Markup.button.callback('🗂️ 钱包列表', 'wallet_list')
    ],
    [
      Markup.button.callback('🎛️ 策略配置', 'strategy_management'),
      sniperButton
    ],
    [
      Markup.button.callback('🧰 扫链配置', 'sweep_strategy_management'),
      sweepButton
    ],
    [
      Markup.button.callback('📈 持仓监控', 'sniper_list'),
      Markup.button.callback('💰 收益统计', 'earnings')
    ],
    [
      Markup.button.callback('🎁 邀请返佣', 'invite'),
      Markup.button.callback('⚡ 帮助中心', 'help')
    ]
  ]);
}

// 测试命令
bot.command('test', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    await ctx.reply('🧪 开始测试策略匹配功能...');
    await testStrategyMatching();
    await ctx.reply('✅ 测试完成！请查看消息。');
  } catch (error) {
    console.error('测试命令失败:', error);
    await ctx.reply('❌ 测试失败，请稍后重试。');
  }
});

// 启动指定钱包的狙击
bot.action(/^start_sniper_wallet_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在');
      return;
    }
    await db.setWalletSniperState(knex, walletId, true);
    await ctx.answerCbQuery('✅ 已为该钱包开启狙击');
    // 返回该钱包详情页以刷新状态
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `select_wallet_${walletId}`
      }
    });
  } catch (e) {
    console.error('开启指定钱包狙击失败:', e);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 停止指定钱包的狙击
bot.action(/^stop_sniper_wallet_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在');
      return;
    }
    await db.setWalletSniperState(knex, walletId, false);
    await ctx.answerCbQuery('✅ 已为该钱包停止狙击');
    // 返回该钱包详情页以刷新状态
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `select_wallet_${walletId}`
      }
    });
  } catch (e) {
    console.error('停止指定钱包狙击失败:', e);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 测试购买命令
bot.command('testbuy', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    await ctx.reply('🛒 开始测试自动购买功能...');

    // 使用一个测试代币地址（USDT）
    const testTokenAddress = '0x55d398326f99059fF775485246999027B3197955'; // USDT on BSC
    const buyAmount = 0.001; // 0.001 BNB
    const slippage = 10; // 10%
    const gasPrice = 5; // 5 Gwei

    await ctx.reply(`📊 测试参数:\n代币: ${testTokenAddress}\n金额: ${buyAmount} BNB\n滑点: ${slippage}%\nGas: ${gasPrice} Gwei`);

    const activeWallet = await db.getActiveWallet(knex, userId).catch(() => null);
    const result = await autoBuyToken(
      userId,
      testTokenAddress,
      buyAmount,
      slippage,
      gasPrice,
      activeWallet ? activeWallet.id : null,
      activeWallet || null
    );

    if (result.success) {
      await ctx.reply(`✅ 测试购买成功！\n交易哈希: ${result.txHash}`);
    } else {
      await ctx.reply(`❌ 测试购买失败: ${result.error}`);
    }
  } catch (error) {
    console.error('测试购买失败:', error);
    await ctx.reply('❌ 测试购买失败，请稍后重试。');
  }
});

// 处理 /start 命令（支持邀请链接）
bot.command('start', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || '未知用户';

  try {
    // 检查是否有邀请人参数
    const invitedBy = ctx.message.text.split(' ')[1] || null;

    // 创建或获取用户
    const user = await db.createOrGetUser(knex, userId, username, invitedBy);

    // 检查用户是否已有钱包
    let wallet = await db.getActiveWallet(knex, userId);
    const walletCount = await db.getWalletCount(knex, userId);

    if (!wallet) {
      // 新用户，自动创建第一个钱包
      const newWallet = createWallet(userId);
      await db.addWallet(knex, userId, newWallet);
      wallet = await db.getActiveWallet(knex, userId);

      // 🔐 显示私钥5秒，提醒用户保存
      let privateKeyMessage = `🎉 *欢迎使用 MEME RUSH BOT！*\n\n`;
      privateKeyMessage += `━━━━━━━━━━━━━━━━━━━\n\n`;
      privateKeyMessage += `✅ *钱包已创建！*\n\n`;
      privateKeyMessage += `📍 *地址:*\n\`${escapeMarkdown(newWallet.address)}\`\n\n`;
      privateKeyMessage += `🔐 *私钥:*\n\`${escapeMarkdown(newWallet.privateKey)}\`\n\n`;
      privateKeyMessage += `📝 *助记词:*\n\`${escapeMarkdown(newWallet.mnemonic)}\`\n\n`;
      privateKeyMessage += `━━━━━━━━━━━━━━━━━━━\n\n`;
      privateKeyMessage += `⚠️ *重要提示（请立即保存！）*\n`;
      privateKeyMessage += `🔴 私钥和助记词只显示这一次\n`;
      privateKeyMessage += `🔴 请截图或抄写保存\n`;
      privateKeyMessage += `🔴 丢失后将无法找回资产\n`;
      privateKeyMessage += `🔴 不要分享给任何人\n\n`;
      privateKeyMessage += `⏱️ *5秒后进入主菜单...*`;

      await ctx.reply(privateKeyMessage, {
        parse_mode: 'Markdown'
      });

      // 等待5秒
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // 获取余额
    const balance = await getWalletBalance(wallet.address);

    // 获取 BNB 价格
    let bnbPrice = 0;
    let usdValue = 0;
    try {
      bnbPrice = await getTokenUsdPriceByRouter(WBNB_ADDRESS);
      if (bnbPrice > 0) {
        usdValue = parseFloat(balance) * bnbPrice;
      }
    } catch (e) {
      console.error('获取BNB价格失败:', e);
    }

    // 生成邀请链接
    const botUsername = ctx.botInfo.username;
    const inviteLink = `https://t.me/${botUsername}?start=${userId}`;

    // 构建欢迎消息
    let message = `🎯 *MEME RUSH SNIPER BOT*\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `⚡ *极速狙击 · 自动交易 · 智能止盈*\n\n`;

    message += `💎 *钱包 #${wallet.wallet_number}*\n`;
    message += `\`${wallet.address}\`\n`;
    message += `💰 余额: *${balance} BNB*\n`;
    if (bnbPrice > 0) {
      message += `💵 价值: *$${usdValue.toFixed(2)}* (BNB: $${bnbPrice.toFixed(2)})\n`;
    }
    message += `🌐 网络: BSC Mainnet\n\n`;

    if (walletCount > 1) {
      message += `📊 共有 *${walletCount}* 个钱包\n\n`;
    }

    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `🎁 *邀请返佣*\n`;
    message += `已邀请 *${user.invite_count}* 人\n`;
    if (user.invite_count > 0) {
      message += `🔥 继续邀请赚取更多奖励！\n\n`;
    } else {
      message += `💡 分享链接即可获得奖励\n\n`;
    }

    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `⚙️ *快速设置*\n`;
    message += `1️⃣ 充值 BNB 到钱包\n`;
    message += `2️⃣ 配置狙击策略\n`;
    message += `3️⃣ 启动自动狙击\n\n`;

    message += `⚠️ DYOR | NFA`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...(await getMainMenuKeyboard(userId))
    });

  } catch (error) {
    console.error('处理 /start 命令失败:', error);
    await ctx.reply('❌ 初始化失败，请稍后重试。');
  }
});

// 策略管理 - 直接配置当前激活钱包
bot.action('strategy_management', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const activeWallet = await db.getActiveWallet(knex, userId);

    if (!activeWallet) {
      await ctx.answerCbQuery('❌ 没有激活的钱包');
      return;
    }

    // 直接构造策略设置页面
    const walletId = activeWallet.id;

    let message = `🎛️ *钱包 #${activeWallet.wallet_number} 策略配置*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前配置*\n\n`;
    message += `💰 *买入金额:* ${activeWallet.buy_amount} BNB\n`;
    message += `每次自动购买新币使用的BNB数量\n\n`;
    message += `📈 *滑点:* ${activeWallet.slippage}%\n`;
    message += `允许的价格波动范围\n\n`;
    message += `⛽ *Gas价格:* ${activeWallet.gas_price} Gwei\n`;
    message += `交易的Gas费用设置\n\n`;
    message += `💸 *贿赂金额:* ${activeWallet.bribe_amount || 0} BNB\n`;
    message += `Bundle提交时的MEV保护费用\n\n`;
    message += `📉 *等待下跌:* ${activeWallet.wait_for_drop ? `🟢 ${activeWallet.drop_percentage}%` : '⚪ 关闭'}\n`;
    message += `等待代币价格下跌后再买入\n\n`;

    const buttons = [
      [
        Markup.button.callback('💰 买入金额', `set_amount_${walletId}`),
        Markup.button.callback('📈 滑点', `set_slippage_${walletId}`)
      ],
      [
        Markup.button.callback('⛽ Gas', `set_gas_${walletId}`),
        Markup.button.callback('📊 止盈止损', `tpsl_${walletId}`)
      ],
      [
        Markup.button.callback('💸 贿赂', `set_bribe_${walletId}`),
        Markup.button.callback('🔍 过滤选项', `filters_${walletId}`)
      ],
      [
        Markup.button.callback('📉 等待下跌', `wait_drop_${walletId}`)
      ],
      [Markup.button.callback('⬅️ 返回', 'back_to_menu')]
    ];

    // 防止 Telegram 400: message is not modified
    const keyboard = Markup.inlineKeyboard(buttons);
    const currentMsg = ctx.callbackQuery && ctx.callbackQuery.message;
    const sameText = currentMsg && currentMsg.text === message;
    const sameMarkup = currentMsg && currentMsg.reply_markup && keyboard &&
      JSON.stringify(currentMsg.reply_markup) === JSON.stringify(keyboard.reply_markup);
    if (sameText && sameMarkup) {
      await ctx.answerCbQuery('已是最新配置');
      return;
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...keyboard
    });
    await ctx.answerCbQuery();

  } catch (error) {
    console.error('策略管理错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 当前钱包
bot.action('my_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const wallet = await db.getActiveWallet(knex, userId);
    const walletCount = await db.getWalletCount(knex, userId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包未找到');
      return;
    }

    const balance = await getWalletBalance(wallet.address);

    let message = `💎 *钱包 #${wallet.wallet_number}*\n\n`;
    message += `\`${escapeMarkdown(wallet.address)}\`\n\n`;
    message += `📊 *余额*\n🟢 ${balance} BNB\n\n`;
    message += `🌐 BSC Mainnet\n`;
    message += `💼 ${wallet.wallet_number} / ${walletCount} 个钱包\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `💡 请充值 BNB 作为交易 Gas 费`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔐 导出私钥', 'show_private_key')],
        [Markup.button.callback('⬅️ 返回', 'back_to_menu')]
      ])
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('查看钱包错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 钱包管理 - 钱包列表
bot.action('wallet_list', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const activeWallet = await db.getActiveWallet(knex, userId);

    if (wallets.length === 0) {
      await ctx.answerCbQuery('❌ 没有钱包');
      return;
    }

    let message = `🗂️ *钱包列表*\n\n`;
    message += `📊 总计 ${wallets.length} 个钱包\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;

    // 构建钱包列表按钮
    const buttons = [];
    for (const wallet of wallets) {
      const shortAddr = `${wallet.address.substring(0, 6)}...${wallet.address.substring(38)}`;
      const isActive = wallet.id === activeWallet.id;
      const icon = isActive ? '✅' : '💼';
      const label = `${icon} #${wallet.wallet_number} ${shortAddr}`;

      buttons.push([Markup.button.callback(label, `select_wallet_${wallet.id}`)]);
    }

    // 添加创建钱包和返回按钮
    buttons.push([Markup.button.callback('➕ 创建新钱包', 'create_new_wallet')]);
    buttons.push([Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]);

    message += `💡 *提示:* ✅ 表示当前使用的钱包\n\n`;
    message += `点击钱包可查看详情或切换`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('钱包列表错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 选择钱包 - 显示钱包详情
bot.action(/^select_wallet_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在或已删除');
      // 返回钱包列表
      try {
        await ctx.editMessageText('❌ 该钱包不存在，请选择其他钱包', {
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回钱包列表', 'wallet_list')]])
        });
      } catch (editErr) {
        console.error('编辑消息失败:', editErr);
      }
      return;
    }

    const activeWallet = await db.getActiveWallet(knex, userId);

    if (!activeWallet) {
      await ctx.answerCbQuery('❌ 无法获取当前钱包');
      return;
    }

    const balance = await getWalletBalance(wallet.address);
    const isActive = wallet.id === activeWallet.id;

    let message = `💎 *钱包 #${wallet.wallet_number}* ${isActive ? '✅' : ''}\n\n`;
    message += `\`${escapeMarkdown(wallet.address)}\`\n\n`;
    message += `💰 余额: *${balance} BNB*\n`;
    message += `🎯 狙击: ${wallet.sniper_enabled ? '🟢 运行中' : '⚪ 已停止'}\n`;
    message += `🧹 扫链: ${wallet.sweep_enabled ? '🟢 运行中' : '⚪ 已停止'}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `⚙️ *当前策略*\n`;
    message += `💵 买入: ${wallet.buy_amount} BNB\n`;
    message += `📊 滑点: ${wallet.slippage}%\n`;
    message += `⛽ Gas: ${wallet.gas_price} Gwei\n\n`;

    const buttons = [];

    if (!isActive) {
      buttons.push([Markup.button.callback('🔄 切换为当前钱包', `switch_wallet_${walletId}`)]);
    }

    // 策略配置按钮
    buttons.push([Markup.button.callback('🎛️ 配置策略', `strategy_${walletId}`)]);

    // 针对该钱包的狙击开关
    if (wallet.sniper_enabled) {
      buttons.push([Markup.button.callback('⏸️ 停止该钱包狙击', `stop_sniper_wallet_${walletId}`)]);
    } else {
      buttons.push([Markup.button.callback('🚀 开始该钱包狙击', `start_sniper_wallet_${walletId}`)]);
    }
    // 针对该钱包的扫链开关
    if (wallet.sweep_enabled) {
      buttons.push([Markup.button.callback('🛑 停止该钱包扫链', `stop_sweep_wallet_${walletId}`)]);
    } else {
      buttons.push([Markup.button.callback('🧹 启动该钱包扫链', `start_sweep_wallet_${walletId}`)]);
    }

    buttons.push([Markup.button.callback('🔐 查看私钥', `show_key_wallet_${walletId}`)]);
    buttons.push([Markup.button.callback('⬅️ 返回', 'wallet_list')]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('查看钱包详情错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 切换钱包
bot.action(/^switch_wallet_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const success = await db.switchActiveWallet(knex, userId, walletId);

    if (success) {
      await ctx.answerCbQuery('✅ 已切换钱包');
      // 返回钱包列表
      ctx.match = null; // 清除 match
      await bot.handleUpdate({
        ...ctx.update,
        callback_query: {
          ...ctx.update.callback_query,
          data: 'wallet_list'
        }
      });
    } else {
      await ctx.answerCbQuery('❌ 切换失败');
    }
  } catch (error) {
    console.error('切换钱包错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 创建新钱包
bot.action('create_new_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const newWallet = createWallet(userId);
    await db.addWallet(knex, userId, newWallet);
    const walletCount = await db.getWalletCount(knex, userId);

    let message = `✅ *钱包创建成功！*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `💼 *钱包 #${walletCount}*\n\n`;
    message += `📍 *地址:*\n\`${escapeMarkdown(newWallet.address)}\`\n\n`;
    message += `🔐 *私钥:*\n\`${escapeMarkdown(newWallet.privateKey)}\`\n\n`;
    message += `📝 *助记词:*\n\`${escapeMarkdown(newWallet.mnemonic)}\`\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `⚠️ *重要提示（请立即保存！）*\n`;
    message += `🔴 私钥和助记词只显示这一次\n`;
    message += `🔴 请截图或抄写保存\n`;
    message += `🔴 丢失后将无法找回资产\n`;
    message += `🔴 不要分享给任何人\n\n`;
    message += `⏱️ *5秒后返回钱包列表...*`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown'
    });
    await ctx.answerCbQuery('✅ 钱包创建成功');

    // 5秒后返回钱包列表
    setTimeout(async () => {
      try {
        ctx.match = null;
        await bot.handleUpdate({
          ...ctx.update,
          callback_query: {
            ...ctx.update.callback_query,
            data: 'wallet_list'
          }
        });
      } catch (error) {
        console.error('返回钱包列表错误:', error);
      }
    }, 5000);

  } catch (error) {
    console.error('创建钱包错误:', error);
    await ctx.answerCbQuery('❌ 创建失败');
  }
});

// 策略设置界面
bot.action(/^strategy_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在或已删除');
      try {
        await ctx.editMessageText('❌ 该钱包不存在，请返回主菜单', {
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]])
        });
      } catch (editErr) {
        console.error('编辑消息失败:', editErr);
      }
      return;
    }

    let message = `🎛️ *钱包 #${wallet.wallet_number} 策略配置*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前配置*\n\n`;
    message += `💰 *买入金额:* ${wallet.buy_amount} BNB\n`;
    message += `每次自动购买新币使用的BNB数量\n\n`;
    message += `📈 *滑点:* ${wallet.slippage}%\n`;
    message += `允许的价格波动范围\n\n`;
    message += `⛽ *Gas价格:* ${wallet.gas_price} Gwei\n`;
    message += `交易的Gas费用设置\n\n`;
    message += `📉 *等待下跌:* ${wallet.wait_for_drop ? `🟢 ${wallet.drop_percentage}%` : '⚪ 关闭'}\n`;
    message += `等待代币价格下跌后再买入\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `点击下方按钮修改策略参数`;

    const buttons = [
      [
        Markup.button.callback('💰 买入金额', `set_amount_${walletId}`),
        Markup.button.callback('📈 滑点', `set_slippage_${walletId}`)
      ],
      [
        Markup.button.callback('⛽ Gas', `set_gas_${walletId}`),
        Markup.button.callback('📊 止盈止损', `tpsl_${walletId}`)
      ],
      [
        Markup.button.callback('💸 贿赂', `set_bribe_${walletId}`),
        Markup.button.callback('🔍 过滤选项', `filters_${walletId}`)
      ],
      [
        Markup.button.callback('📉 等待下跌', `wait_drop_${walletId}`)
      ],
      [Markup.button.callback('⬅️ 返回', 'back_to_menu')]
    ];

    // 防止 Telegram 400: message is not modified（内容与键盘都未变化）
    const keyboard = Markup.inlineKeyboard(buttons);
    const currentMsg = ctx.callbackQuery && ctx.callbackQuery.message;
    const sameText = currentMsg && currentMsg.text === message;
    const sameMarkup = currentMsg && currentMsg.reply_markup && keyboard &&
      JSON.stringify(currentMsg.reply_markup) === JSON.stringify(keyboard.reply_markup);
    if (sameText && sameMarkup) {
      await ctx.answerCbQuery('已是最新配置');
      return;
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...keyboard
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('策略设置错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 修改买入金额 - 显示选项
bot.action(/^set_amount_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在或已删除');
      try {
        await ctx.editMessageText('❌ 该钱包不存在，请返回主菜单', {
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]])
        });
      } catch (editErr) { }
      return;
    }

    let message = `💰 *设置买入金额*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${wallet.buy_amount} BNB\n\n`;
    message += `选择每次自动购买新币使用的BNB数量：`;

    const buttons = [
      [
        Markup.button.callback('0.001', `amount_${walletId}_0.001`),
        Markup.button.callback('0.005', `amount_${walletId}_0.005`)
      ],
      [
        Markup.button.callback('0.01', `amount_${walletId}_0.01`),
        Markup.button.callback('0.02', `amount_${walletId}_0.02`)
      ],
      [
        Markup.button.callback('0.05', `amount_${walletId}_0.05`),
        Markup.button.callback('0.1', `amount_${walletId}_0.1`)
      ],
      [
        Markup.button.callback('0.5', `amount_${walletId}_0.5`),
        Markup.button.callback('1.0', `amount_${walletId}_1`)
      ],
      [
        Markup.button.callback('✏️ 自定义', `custom_amount_${walletId}`),
        Markup.button.callback('🔙 返回', `strategy_${walletId}`)
      ]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('设置买入金额错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 修改滑点 - 显示选项
bot.action(/^set_slippage_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在或已删除');
      try {
        await ctx.editMessageText('❌ 该钱包不存在，请返回主菜单', {
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]])
        });
      } catch (editErr) { }
      return;
    }

    let message = `📈 *设置滑点*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${wallet.slippage}%\n\n`;
    message += `选择允许的价格波动范围：\n\n`;
    message += `💡 *提示:*\n`;
    message += `• 滑点越高，成交概率越大\n`;
    message += `• 滑点越低，价格偏差越小\n`;
    message += `• 建议新币使用较高滑点`;

    const buttons = [
      [
        Markup.button.callback('5%', `slippage_${walletId}_5`),
        Markup.button.callback('10%', `slippage_${walletId}_10`)
      ],
      [
        Markup.button.callback('15%', `slippage_${walletId}_15`),
        Markup.button.callback('20%', `slippage_${walletId}_20`)
      ],
      [
        Markup.button.callback('30%', `slippage_${walletId}_30`),
        Markup.button.callback('50%', `slippage_${walletId}_50`)
      ],
      [
        Markup.button.callback('✏️ 自定义', `custom_slippage_${walletId}`),
        Markup.button.callback('🔙 返回', `strategy_${walletId}`)
      ]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('设置滑点错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 修改Gas - 显示选项
bot.action(/^set_gas_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在或已删除');
      try {
        await ctx.editMessageText('❌ 该钱包不存在，请返回主菜单', {
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]])
        });
      } catch (editErr) { }
      return;
    }

    let message = `⛽ *设置Gas价格*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${wallet.gas_price} Gwei\n\n`;
    message += `选择交易的Gas价格：\n\n`;
    message += `💡 *提示:*\n`;
    message += `• Gas越高，交易越快\n`;
    message += `• Gas越低，手续费越少\n`;
    message += `• 抢新币建议使用高Gas`;

    const buttons = [
      [
        Markup.button.callback('3 Gwei', `gas_${walletId}_3`),
        Markup.button.callback('5 Gwei', `gas_${walletId}_5`)
      ],
      [
        Markup.button.callback('8 Gwei', `gas_${walletId}_8`),
        Markup.button.callback('10 Gwei', `gas_${walletId}_10`)
      ],
      [
        Markup.button.callback('15 Gwei', `gas_${walletId}_15`),
        Markup.button.callback('20 Gwei', `gas_${walletId}_20`)
      ],
      [
        Markup.button.callback('✏️ 自定义', `custom_gas_${walletId}`),
        Markup.button.callback('🔙 返回', `strategy_${walletId}`)
      ]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('设置Gas错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 修改贿赂金额 - 显示选项
bot.action(/^set_bribe_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在或已删除');
      try {
        await ctx.editMessageText('❌ 该钱包不存在，请返回主菜单', {
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]])
        });
      } catch (editErr) { }
      return;
    }

    let message = `💸 *设置贿赂金额*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${wallet.bribe_amount || 0} BNB\n\n`;
    message += `选择Bundle提交时的贿赂金额：\n\n`;
    message += `💡 *说明:*\n`;
    message += `• 贿赂用于MEV保护和优先打包\n`;
    message += `• 金额越高，越不容易被抢跑\n`;
    message += `• 设置为0则使用普通交易模式\n`;
    message += `• 贿赂会转账到BlockRazor验证者`;

    const buttons = [
      [
        Markup.button.callback('0 BNB (关闭)', `bribe_${walletId}_0`),
        Markup.button.callback('0.001 BNB', `bribe_${walletId}_0.001`)
      ],
      [
        Markup.button.callback('0.005 BNB', `bribe_${walletId}_0.005`),
        Markup.button.callback('0.01 BNB', `bribe_${walletId}_0.01`)
      ],
      [
        Markup.button.callback('0.02 BNB', `bribe_${walletId}_0.02`),
        Markup.button.callback('0.05 BNB', `bribe_${walletId}_0.05`)
      ],
      [
        Markup.button.callback('✏️ 自定义', `custom_bribe_${walletId}`),
        Markup.button.callback('🔙 返回', `strategy_${walletId}`)
      ]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('设置贿赂金额错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 确认修改贿赂金额
bot.action(/^bribe_(\d+)_(.+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const amount = parseFloat(ctx.match[2]);
  const userId = ctx.from.id.toString();

  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'bribe_amount', amount);
    await ctx.answerCbQuery(`✅ 已设置贿赂金额为 ${amount} BNB`);

    // 返回策略设置界面
    ctx.match = [null, walletId.toString()];
    try {
      await ctx.editMessageText('⏳ 正在更新...', {
        parse_mode: 'Markdown'
      });
    } catch (editErr) {
      // 忽略编辑错误
    }

    // 延迟一下再显示策略界面
    setTimeout(async () => {
      const strategyHandler = bot.handleUpdate.bind(bot);
      ctx.match = [null, walletId.toString()];
      ctx.callbackQuery.data = `strategy_${walletId}`;

      try {
        const wallets = await db.getUserWallets(knex, userId);
        const wallet = wallets.find(w => w.id === walletId);

        if (wallet) {
          let message = `🎛️ *钱包 #${wallet.wallet_number} 策略配置*\n\n`;
          message += `━━━━━━━━━━━━━━━━━━━\n\n`;
          message += `📊 *当前配置*\n\n`;
          message += `💰 *买入金额:* ${wallet.buy_amount} BNB\n`;
          message += `每次自动购买新币使用的BNB数量\n\n`;
          message += `📈 *滑点:* ${wallet.slippage}%\n`;
          message += `允许的价格波动范围\n\n`;
          message += `⛽ *Gas价格:* ${wallet.gas_price} Gwei\n`;
          message += `交易的Gas费用设置\n\n`;
          message += `💸 *贿赂金额:* ${wallet.bribe_amount || 0} BNB\n`;
          message += `Bundle提交时的MEV保护费用\n\n`;
          message += `📉 *等待下跌:* ${wallet.wait_for_drop ? `🟢 ${wallet.drop_percentage}%` : '⚪ 关闭'}\n`;
          message += `等待代币价格下跌后再买入\n\n`;

          const buttons = [
            [
              Markup.button.callback('💰 买入金额', `set_amount_${walletId}`),
              Markup.button.callback('📈 滑点', `set_slippage_${walletId}`)
            ],
            [
              Markup.button.callback('⛽ Gas', `set_gas_${walletId}`),
              Markup.button.callback('📊 止盈止损', `tpsl_${walletId}`)
            ],
            [
              Markup.button.callback('💸 贿赂', `set_bribe_${walletId}`),
              Markup.button.callback('🔍 过滤选项', `filters_${walletId}`)
            ],
            [
              Markup.button.callback('📉 等待下跌', `wait_drop_${walletId}`)
            ],
            [Markup.button.callback('⬅️ 返回', 'back_to_menu')]
          ];

          await ctx.editMessageText(message, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
          });
        }
      } catch (err) {
        console.error('显示策略界面错误:', err);
      }
    }, 500);
  } catch (error) {
    console.error('修改贿赂金额错误:', error);
    await ctx.answerCbQuery('❌ 修改失败');
  }
});

// 自定义贿赂金额
bot.action(/^custom_bribe_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    setUserInputState(userId, {
      type: 'bribe_amount',
      walletId: walletId,
      messageId: ctx.callbackQuery.message.message_id
    });

    await ctx.editMessageText(
      `✏️ *自定义贿赂金额*\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `请直接输入您想要的BNB贿赂金额\n\n` +
      `💡 *示例:*\n` +
      `• \`0\` - 关闭Bundle模式\n` +
      `• \`0.001\` - 0.001 BNB\n` +
      `• \`0.01\` - 0.01 BNB\n\n` +
      `💡 *提示:* 贿赂金额用于MEV保护`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `strategy_${walletId}`)]])
      }
    );
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (error) {
    console.error('自定义贿赂金额错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 过滤选项管理
bot.action(/^filters_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在或已删除');
      try {
        await ctx.editMessageText('❌ 该钱包不存在，请返回主菜单', {
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]])
        });
      } catch (editErr) { }
      return;
    }

    let message = `🔍 *钱包 #${wallet.wallet_number} 过滤选项*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前过滤条件*\n\n`;

    // 社区链接
    const socialIcon = wallet.filter_social ? '✅' : '❌';
    message += `${socialIcon} *社区链接:* ${wallet.filter_social ? '必须有' : '不限制'}\n`;
    message += `└ 推特、TG等社交媒体链接\n\n`;

    // 持币人数
    const holdersText = wallet.filter_min_holders > 0 ? `≥${wallet.filter_min_holders}人` : '不限制';
    message += `👥 *持币人数:* ${holdersText}\n`;
    message += `└ 最少持币地址数量\n\n`;

    // Top10占比
    const top10Text = wallet.filter_top10_max < 100 ? `≤${wallet.filter_top10_max}%` : '不限制';
    message += `🔝 *Top10占比:* ${top10Text}\n`;
    message += `└ 前10地址持币总占比\n\n`;


    // 币安专属
    const binanceIcon = wallet.filter_binance_only ? '✅' : '❌';
    message += `${binanceIcon} *币安专属:* ${wallet.filter_binance_only ? '仅币安发射' : '不限制'}\n`;
    message += `└ 只接受币安平台发射的代币\n\n`;

    // 发射时间限制
    const launchTimeText = toNumberSafe(wallet.filter_max_launch_minutes, 0) > 0 ? `≤${wallet.filter_max_launch_minutes}分钟` : '不限制';
    message += `⏰ *发射时间:* ${launchTimeText}\n`;
    message += `└ 只买入发射时间在限制内的代币\n\n`;

    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `💡 *说明:* 开启过滤后，只有符合条件的代币才会被自动买入`;

    const buttons = [
      [
        Markup.button.callback('🌐 社区链接', `toggle_social_${walletId}`),
        Markup.button.callback('👥 持币人数', `set_holders_${walletId}`)
      ],
      [
        Markup.button.callback('🔝 Top10占比', `set_top10_${walletId}`),
        Markup.button.callback('⏰ 发射时间', `set_launch_time_${walletId}`)
      ],
      [
        Markup.button.callback('🟡 币安专属', `toggle_binance_${walletId}`)
      ],
      [Markup.button.callback('🔙 返回', `strategy_${walletId}`)]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('过滤选项错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 切换社区链接要求
bot.action(/^toggle_social_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    const newValue = wallet.filter_social ? 0 : 1;
    await db.updateWalletStrategy(knex, walletId, userId, 'filter_social', newValue);

    const statusText = newValue ? '已开启' : '已关闭';
    await ctx.answerCbQuery(`✅ 社区链接过滤${statusText}`);

    // 刷新界面
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `filters_${walletId}`
      }
    });
  } catch (error) {
    console.error('切换社区链接错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 切换币安专属要求
bot.action(/^toggle_binance_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    const newValue = wallet.filter_binance_only ? 0 : 1;
    await db.updateWalletStrategy(knex, walletId, userId, 'filter_binance_only', newValue);

    const statusText = newValue ? '已开启' : '已关闭';
    await ctx.answerCbQuery(`✅ 币安专属过滤${statusText}`);

    // 刷新界面
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `filters_${walletId}`
      }
    });
  } catch (error) {
    console.error('切换币安专属错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 设置发射时间限制（狙击模式）
bot.action(/^set_launch_time_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) { await ctx.answerCbQuery('❌ 钱包不存在或已删除'); return; }
    let message = `⏰ *设置发射时间限制(狙击)*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${toNumberSafe(wallet.filter_max_launch_minutes, 0) > 0 ? wallet.filter_max_launch_minutes + '分钟' : '不限制'}\n\n`;
    message += `💡 *说明:* 只买入发射时间在限制内的代币\n`;
    message += `例如设置5分钟，则只买入发射后5分钟内的代币\n\n`;
    const buttons = [
      [Markup.button.callback('不限制', `launch_time_${walletId}_0`), Markup.button.callback('1分钟', `launch_time_${walletId}_1`)],
      [Markup.button.callback('3分钟', `launch_time_${walletId}_3`), Markup.button.callback('5分钟', `launch_time_${walletId}_5`)],
      [Markup.button.callback('10分钟', `launch_time_${walletId}_10`), Markup.button.callback('30分钟', `launch_time_${walletId}_30`)],
      [Markup.button.callback('✏️ 自定义', `custom_launch_time_${walletId}`), Markup.button.callback('🔙 返回', `filters_${walletId}`)]
    ];
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    await ctx.answerCbQuery();
  } catch (e) { console.error('设置发射时间错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

bot.action(/^launch_time_(\d+)_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const value = parseInt(ctx.match[2]);
  const userId = ctx.from.id.toString();
  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'filter_max_launch_minutes', value);
    await ctx.answerCbQuery(`✅ 已设置为 ${value > 0 ? '≤' + value + '分钟' : '不限制'}`);
    await bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.update.callback_query, data: `filters_${walletId}` } });
  } catch (e) { console.error('确认发射时间错误:', e); await ctx.answerCbQuery('❌ 设置失败'); }
});

bot.action(/^custom_launch_time_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    setUserInputState(userId, { type: 'filter_max_launch_minutes', walletId, messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(`✏️ *自定义发射时间限制(狙击)*\n\n━━━━━━━━━━━━━━━━━━━\n\n请输入分钟数 (0表示不限制)`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `filters_${walletId}`)]]) });
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (e) { console.error('自定义发射时间错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

// ============================================
// 等待下跌功能设置
// ============================================

// 等待下跌设置界面
bot.action(/^wait_drop_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在或已删除');
      try {
        await ctx.editMessageText('❌ 该钱包不存在，请返回主菜单', {
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]])
        });
      } catch (editErr) { }
      return;
    }

    let message = `📉 *等待下跌设置*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前状态:* ${wallet.wait_for_drop ? `🟢 开启 (${wallet.drop_percentage}%)` : '⚪ 关闭'}\n\n`;
    message += `💡 *功能说明:*\n`;
    message += `• 开启后，检测到新代币时不会立即买入\n`;
    message += `• 系统会监控代币价格变化\n`;
    message += `• 当价格下跌达到设定百分比时自动买入\n`;
    message += `• 监控时间：24小时\n\n`;
    message += `⚠️ *注意:* 价格可能不会下跌到目标值`;

    const buttons = [
      [
        Markup.button.callback(wallet.wait_for_drop ? '⚪ 关闭功能' : '🟢 开启功能', `toggle_wait_drop_${walletId}`)
      ]
    ];

    if (wallet.wait_for_drop) {
      buttons.push([
        Markup.button.callback('5%', `drop_percent_${walletId}_5`),
        Markup.button.callback('10%', `drop_percent_${walletId}_10`)
      ]);
      buttons.push([
        Markup.button.callback('15%', `drop_percent_${walletId}_15`),
        Markup.button.callback('20%', `drop_percent_${walletId}_20`)
      ]);
      buttons.push([
        Markup.button.callback('30%', `drop_percent_${walletId}_30`),
        Markup.button.callback('✏️ 自定义', `custom_drop_${walletId}`)
      ]);
    }

    buttons.push([Markup.button.callback('🔙 返回', `strategy_${walletId}`)]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('等待下跌设置错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 切换等待下跌功能开关
bot.action(/^toggle_wait_drop_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    const newValue = wallet.wait_for_drop ? 0 : 1;
    await knex('wallets')
      .where({ id: walletId, user_id: userId })
      .update({ wait_for_drop: newValue });

    const statusText = newValue ? '已开启' : '已关闭';
    await ctx.answerCbQuery(`✅ 等待下跌功能${statusText}`);

    // 刷新界面
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `wait_drop_${walletId}`
      }
    });
  } catch (error) {
    console.error('切换等待下跌功能错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 设置下跌百分比
bot.action(/^drop_percent_(\d+)_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const percentage = parseInt(ctx.match[2]);
  const userId = ctx.from.id.toString();

  try {
    await knex('wallets')
      .where({ id: walletId, user_id: userId })
      .update({ drop_percentage: percentage });

    await ctx.answerCbQuery(`✅ 已设置等待下跌 ${percentage}%`);

    // 刷新界面
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `wait_drop_${walletId}`
      }
    });
  } catch (error) {
    console.error('设置下跌百分比错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 自定义下跌百分比
bot.action(/^custom_drop_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    // 设置用户状态为等待输入（需带上 messageId 以便保存后返回）
    setUserInputState(userId, {
      type: 'waiting_drop_percentage',
      walletId: walletId,
      messageId: ctx.callbackQuery.message.message_id
    });

    await ctx.editMessageText(
      `📉 *自定义等待下跌百分比*\n\n` +
      `请输入等待下跌的百分比 (1-100)：\n\n` +
      `💡 *建议:*\n` +
      `• 5-10%：适合快速买入\n` +
      `• 15-20%：平衡风险与机会\n` +
      `• 30%+：高风险高收益\n\n` +
      `⚠️ *注意:* 请输入 1-100 之间的数字`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `wait_drop_${walletId}`)]])
      }
    );
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (error) {
    console.error('自定义下跌百分比错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 设置最少持币人数
bot.action(/^set_holders_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在或已删除');
      try {
        await ctx.editMessageText('❌ 该钱包不存在，请返回主菜单', {
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]])
        });
      } catch (editErr) { }
      return;
    }

    let message = `👥 *设置最少持币人数*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${wallet.filter_min_holders > 0 ? wallet.filter_min_holders + '人' : '不限制'}\n\n`;
    message += `选择最少持币地址数量：`;

    const buttons = [
      [
        Markup.button.callback('不限制', `holders_${walletId}_0`),
        Markup.button.callback('50人', `holders_${walletId}_50`)
      ],
      [
        Markup.button.callback('100人', `holders_${walletId}_100`),
        Markup.button.callback('200人', `holders_${walletId}_200`)
      ],
      [
        Markup.button.callback('500人', `holders_${walletId}_500`),
        Markup.button.callback('1000人', `holders_${walletId}_1000`)
      ],
      [
        Markup.button.callback('✏️ 自定义', `custom_holders_${walletId}`),
        Markup.button.callback('🔙 返回', `filters_${walletId}`)
      ]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('设置持币人数错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 设置Top10占比
bot.action(/^set_top10_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在或已删除');
      try {
        await ctx.editMessageText('❌ 该钱包不存在，请返回主菜单', {
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]])
        });
      } catch (editErr) { }
      return;
    }

    let message = `🔝 *设置Top10最大占比*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${wallet.filter_top10_max < 100 ? wallet.filter_top10_max + '%' : '不限制'}\n\n`;
    message += `选择前10地址持币总占比上限：\n\n`;
    message += `💡 *提示:* 占比越低，代币分布越分散`;

    const buttons = [
      [
        Markup.button.callback('不限制', `top10_${walletId}_100`),
        Markup.button.callback('≤10%', `top10_${walletId}_10`)
      ],
      [
        Markup.button.callback('≤20%', `top10_${walletId}_20`),
        Markup.button.callback('≤30%', `top10_${walletId}_30`)
      ],
      [
        Markup.button.callback('≤40%', `top10_${walletId}_40`),
        Markup.button.callback('≤50%', `top10_${walletId}_50`)
      ],
      [
        Markup.button.callback('✏️ 自定义', `custom_top10_${walletId}`),
        Markup.button.callback('🔙 返回', `filters_${walletId}`)
      ]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('设置Top10占比错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});


// 确认持币人数
bot.action(/^holders_(\d+)_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const value = parseInt(ctx.match[2]);
  const userId = ctx.from.id.toString();

  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'filter_min_holders', value);
    const text = value > 0 ? `≥${value}人` : '不限制';
    await ctx.answerCbQuery(`✅ 已设置最少持币人数为 ${text}`);

    // 返回过滤选项
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `filters_${walletId}`
      }
    });
  } catch (error) {
    console.error('设置持币人数错误:', error);
    await ctx.answerCbQuery('❌ 设置失败');
  }
});

// 确认Top10占比
bot.action(/^top10_(\d+)_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const value = parseInt(ctx.match[2]);
  const userId = ctx.from.id.toString();

  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'filter_top10_max', value);
    const text = value < 100 ? `≤${value}%` : '不限制';
    await ctx.answerCbQuery(`✅ 已设置Top10占比为 ${text}`);

    // 返回过滤选项
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `filters_${walletId}`
      }
    });
  } catch (error) {
    console.error('设置Top10占比错误:', error);
    await ctx.answerCbQuery('❌ 设置失败');
  }
});


// 自定义持币人数
bot.action(/^custom_holders_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    setUserInputState(userId, {
      type: 'filter_min_holders',
      walletId: walletId,
      messageId: ctx.callbackQuery.message.message_id
    });

    await ctx.editMessageText(
      `✏️ *自定义最少持币人数*\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `请输入最少持币地址数量\n\n` +
      `💡 *示例:*\n` +
      `• 输入 \`300\` 表示至少300个地址\n` +
      `• 输入 \`0\` 表示不限制\n\n` +
      `⚠️ *注意:* 请输入 ≥ 0 的整数`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `filters_${walletId}`)]])
      }
    );
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (error) {
    console.error('自定义持币人数错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 自定义Top10占比
bot.action(/^custom_top10_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    setUserInputState(userId, {
      type: 'filter_top10_max',
      walletId: walletId,
      messageId: ctx.callbackQuery.message.message_id
    });

    await ctx.editMessageText(
      `✏️ *自定义Top10占比上限*\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `请输入前10地址持币占比上限\n\n` +
      `💡 *示例:*\n` +
      `• 输入 \`35\` 表示上限35%\n` +
      `• 输入 \`100\` 表示不限制\n\n` +
      `⚠️ *注意:* 请输入 0-100 之间的数字`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `filters_${walletId}`)]])
      }
    );
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (error) {
    console.error('自定义Top10占比错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});


// 止盈止损管理（按模式）
bot.action(/^tpsl_(\d+)(?:_(sniper|sweep))?$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const mode = (ctx.match[2] || 'sniper');
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在或已删除');
      try {
        await ctx.editMessageText('❌ 该钱包不存在，请返回主菜单', {
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]])
        });
      } catch (editErr) { }
      return;
    }

    const takeProfits = await db.getTPSL(knex, walletId, 'take_profit', mode);
    const stopLosses = await db.getTPSL(knex, walletId, 'stop_loss', mode);

    let message = `📊 *钱包 #${wallet.wallet_number} 止盈止损*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `🎯 *当前模式:* ${mode === 'sweep' ? '扫链' : '狙击'}\n\n`;

    // 止盈配置
    message += `📈 *止盈设置* (${takeProfits.length}/5)\n`;
    if (takeProfits.length === 0) {
      message += `└ 未设置\n\n`;
    } else {
      takeProfits.forEach((tp, index) => {
        const prefix = index === takeProfits.length - 1 ? '└' : '├';
        message += `${prefix} 涨 ${tp.price_percent}% 时卖出 ${tp.sell_percent}%\n`;
      });
      message += `\n`;
    }

    // 止损配置
    message += `📉 *止损设置* (${stopLosses.length}/1)\n`;
    if (stopLosses.length === 0) {
      message += `└ 未设置\n\n`;
    } else {
      const sl = stopLosses[0];
      message += `└ 跌 ${Math.abs(sl.price_percent)}% 时卖出 ${sl.sell_percent}%\n\n`;
    }

    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `💡 *说明:*\n`;
    message += `• 止盈: 价格上涨到指定%时自动卖出\n`;
    message += `• 止损: 价格下跌到指定%时自动卖出`;

    const buttons = [];
    // 模式切换
    buttons.push([
      Markup.button.callback('狙击', `tpsl_${walletId}_sniper`),
      Markup.button.callback('扫链', `tpsl_${walletId}_sweep`)
    ]);
    // 操作按钮（带模式）
    buttons.push([
      Markup.button.callback('➕ 添加止盈', `add_tp_${walletId}_${mode}`),
      Markup.button.callback('➕ 添加止损', `add_sl_${walletId}_${mode}`)
    ]);

    if (takeProfits.length > 0) {
      buttons.push([Markup.button.callback('📈 管理止盈', `manage_tp_${walletId}_${mode}`)]);
    }

    if (stopLosses.length > 0) {
      buttons.push([Markup.button.callback('📉 管理止损', `manage_sl_${walletId}_${mode}`)]);
    }

    buttons.push([Markup.button.callback('🔙 返回', `strategy_${walletId}`)]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('止盈止损管理错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 添加止盈（按模式）
bot.action(/^add_tp_(\d+)(?:_(sniper|sweep))?$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const mode = (ctx.match[2] || 'sniper');
  const userId = ctx.from.id.toString();

  try {
    const takeProfits = await db.getTPSL(knex, walletId, 'take_profit', mode);

    if (takeProfits.length >= 5) {
      await ctx.answerCbQuery('❌ 最多只能设置5段止盈');
      return;
    }

    setUserInputState(userId, {
      type: 'add_take_profit',
      walletId: walletId,
      messageId: ctx.callbackQuery.message.message_id,
      tpslMode: mode
    });

    await ctx.editMessageText(
      `📈 *添加止盈 (${takeProfits.length}/5)*\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `请输入止盈参数，格式如下：\n\n` +
      `💡 *格式:* \`涨幅% 卖出%\`\n\n` +
      `📝 *示例:*\n` +
      `• \`50 50\` = 涨50%时卖出50%\n` +
      `• \`100 30\` = 涨100%时卖出30%\n` +
      `• \`200 100\` = 涨200%时卖出100%\n\n` +
      `⚠️ *注意:*\n` +
      `• 两个数字用空格分隔\n` +
      `• 涨幅必须 > 0\n` +
      `• 卖出比例 0-100`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `tpsl_${walletId}_${mode}`)]])
      }
    );
    await ctx.answerCbQuery('💬 请输入止盈参数');
  } catch (error) {
    console.error('添加止盈错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 添加止损（按模式）
bot.action(/^add_sl_(\d+)(?:_(sniper|sweep))?$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const mode = (ctx.match[2] || 'sniper');
  const userId = ctx.from.id.toString();

  try {
    const stopLosses = await db.getTPSL(knex, walletId, 'stop_loss', mode);

    if (stopLosses.length >= 1) {
      await ctx.answerCbQuery('❌ 最多只能设置1段止损');
      return;
    }

    setUserInputState(userId, {
      type: 'add_stop_loss',
      walletId: walletId,
      messageId: ctx.callbackQuery.message.message_id,
      tpslMode: mode
    });

    await ctx.editMessageText(
      `📉 *添加止损*\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `请输入止损参数，格式如下：\n\n` +
      `💡 *格式:* \`跌幅% 卖出%\`\n\n` +
      `📝 *示例:*\n` +
      `• \`20 100\` = 跌20%时卖出100%\n` +
      `• \`30 100\` = 跌30%时卖出100%\n` +
      `• \`50 100\` = 跌50%时卖出100%\n\n` +
      `⚠️ *注意:*\n` +
      `• 两个数字用空格分隔\n` +
      `• 跌幅必须 > 0\n` +
      `• 卖出比例 0-100`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `tpsl_${walletId}_${mode}`)]])
      }
    );
    await ctx.answerCbQuery('💬 请输入止损参数');
  } catch (error) {
    console.error('添加止损错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 管理止盈列表（按模式）
bot.action(/^manage_tp_(\d+)(?:_(sniper|sweep))?$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const mode = (ctx.match[2] || 'sniper');

  try {
    const takeProfits = await db.getTPSL(knex, walletId, 'take_profit', mode);

    let message = `📈 *管理止盈* (${takeProfits.length}/5)\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `点击要删除的止盈段：`;

    const buttons = [];
    takeProfits.forEach((tp) => {
      buttons.push([
        Markup.button.callback(
          `❌ 涨${tp.price_percent}% 卖${tp.sell_percent}%`,
          `del_tp_${walletId}_${tp.id}_${mode}`
        )
      ]);
    });

    buttons.push([
      Markup.button.callback('🗑️ 清空全部', `clear_tp_${walletId}_${mode}`),
      Markup.button.callback('🔙 返回', `tpsl_${walletId}_${mode}`)
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('管理止盈错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 管理止损（按模式）
bot.action(/^manage_sl_(\d+)(?:_(sniper|sweep))?$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const mode = (ctx.match[2] || 'sniper');

  try {
    const stopLosses = await db.getTPSL(knex, walletId, 'stop_loss', mode);

    if (stopLosses.length === 0) {
      await ctx.answerCbQuery('❌ 未设置止损');
      return;
    }

    const sl = stopLosses[0];

    await ctx.editMessageText(
      `📉 *管理止损*\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `当前设置: 跌${Math.abs(sl.price_percent)}% 卖${sl.sell_percent}%\n\n` +
      `确定要删除这个止损吗？`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ 删除止损', `del_sl_${walletId}_${sl.id}_${mode}`)],
          [Markup.button.callback('🔙 返回', `tpsl_${walletId}_${mode}`)]
        ])
      }
    );
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('管理止损错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 删除单个止盈（按模式）
bot.action(/^del_tp_(\d+)_(\d+)(?:_(sniper|sweep))?$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const tpId = parseInt(ctx.match[2]);
  const mode = (ctx.match[3] || 'sniper');

  try {
    await db.deleteTPSL(knex, tpId, walletId);
    await ctx.answerCbQuery('✅ 已删除');

    // 返回管理界面
    ctx.match = [null, walletId.toString(), mode];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `manage_tp_${walletId}_${mode}`
      }
    });
  } catch (error) {
    console.error('删除止盈错误:', error);
    await ctx.answerCbQuery('❌ 删除失败');
  }
});

// 删除止损（按模式）
bot.action(/^del_sl_(\d+)_(\d+)(?:_(sniper|sweep))?$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const slId = parseInt(ctx.match[2]);
  const mode = (ctx.match[3] || 'sniper');

  try {
    await db.deleteTPSL(knex, slId, walletId);
    await ctx.answerCbQuery('✅ 已删除');

    // 返回止盈止损界面
    ctx.match = [null, walletId.toString(), mode];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `tpsl_${walletId}_${mode}`
      }
    });
  } catch (error) {
    console.error('删除止损错误:', error);
    await ctx.answerCbQuery('❌ 删除失败');
  }
});

// 清空所有止盈（按模式）
bot.action(/^clear_tp_(\d+)(?:_(sniper|sweep))?$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const mode = (ctx.match[2] || 'sniper');

  try {
    await db.clearTPSL(knex, walletId, 'take_profit', mode);
    await ctx.answerCbQuery('✅ 已清空所有止盈');

    // 返回止盈止损界面
    ctx.match = [null, walletId.toString(), mode];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `tpsl_${walletId}_${mode}`
      }
    });
  } catch (error) {
    console.error('清空止盈错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 自定义买入金额
bot.action(/^custom_amount_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    // 设置用户输入状态
    setUserInputState(userId, {
      type: 'buy_amount',
      walletId: walletId,
      messageId: ctx.callbackQuery.message.message_id
    });

    await ctx.editMessageText(
      `✏️ *自定义买入金额*\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `请直接输入您想要的BNB数量\n\n` +
      `💡 *示例:*\n` +
      `• 输入 \`0.015\` 表示 0.015 BNB\n` +
      `• 输入 \`0.25\` 表示 0.25 BNB\n` +
      `• 输入 \`2\` 表示 2 BNB\n\n` +
      `⚠️ *注意:* 请输入大于 0 的数字`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `strategy_${walletId}`)]])
      }
    );
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (error) {
    console.error('自定义买入金额错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 自定义滑点
bot.action(/^custom_slippage_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    setUserInputState(userId, {
      type: 'slippage',
      walletId: walletId,
      messageId: ctx.callbackQuery.message.message_id
    });

    await ctx.editMessageText(
      `✏️ *自定义滑点*\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `请直接输入您想要的滑点百分比\n\n` +
      `💡 *示例:*\n` +
      `• 输入 \`8\` 表示 8%\n` +
      `• 输入 \`12.5\` 表示 12.5%\n` +
      `• 输入 \`25\` 表示 25%\n\n` +
      `⚠️ *注意:* 请输入 0-100 之间的数字`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `strategy_${walletId}`)]])
      }
    );
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (error) {
    console.error('自定义滑点错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 自定义Gas
bot.action(/^custom_gas_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    setUserInputState(userId, {
      type: 'gas_price',
      walletId: walletId,
      messageId: ctx.callbackQuery.message.message_id
    });

    await ctx.editMessageText(
      `✏️ *自定义Gas价格*\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `请直接输入您想要的Gas价格(Gwei)\n\n` +
      `💡 *示例:*\n` +
      `• 输入 \`6\` 表示 6 Gwei\n` +
      `• 输入 \`12\` 表示 12 Gwei\n` +
      `• 输入 \`25\` 表示 25 Gwei\n\n` +
      `⚠️ *注意:* 请输入正整数`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `strategy_${walletId}`)]])
      }
    );
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (error) {
    console.error('自定义Gas错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 确认修改买入金额
bot.action(/^amount_(\d+)_(.+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const amount = parseFloat(ctx.match[2]);
  const userId = ctx.from.id.toString();

  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'buy_amount', amount);
    await ctx.answerCbQuery(`✅ 已设置买入金额为 ${amount} BNB`);

    // 返回策略设置界面
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `strategy_${walletId}`
      }
    });
  } catch (error) {
    console.error('修改买入金额错误:', error);
    await ctx.answerCbQuery('❌ 修改失败');
  }
});

// 确认修改滑点
bot.action(/^slippage_(\d+)_(.+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const slippage = parseFloat(ctx.match[2]);
  const userId = ctx.from.id.toString();

  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'slippage', slippage);
    await ctx.answerCbQuery(`✅ 已设置滑点为 ${slippage}%`);

    // 返回策略设置界面
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `strategy_${walletId}`
      }
    });
  } catch (error) {
    console.error('修改滑点错误:', error);
    await ctx.answerCbQuery('❌ 修改失败');
  }
});

// 确认修改Gas
bot.action(/^gas_(\d+)_(.+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const gasPrice = parseInt(ctx.match[2]);
  const userId = ctx.from.id.toString();

  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'gas_price', gasPrice);
    await ctx.answerCbQuery(`✅ 已设置Gas价格为 ${gasPrice} Gwei`);

    // 返回策略设置界面
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: {
        ...ctx.update.callback_query,
        data: `strategy_${walletId}`
      }
    });
  } catch (error) {
    console.error('修改Gas错误:', error);
    await ctx.answerCbQuery('❌ 修改失败');
  }
});

// 查看指定钱包私钥
bot.action(/^show_key_wallet_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();

  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包不存在');
      return;
    }

    let message = `🔑 *钱包 #${wallet.wallet_number} 私钥信息*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📍 *地址:*\n\`${escapeMarkdown(wallet.address)}\`\n\n`;
    message += `🔐 *私钥:*\n\`${escapeMarkdown(wallet.private_key)}\`\n\n`;
    message += `📝 *助记词:*\n\`${escapeMarkdown(wallet.mnemonic)}\`\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `⚠️ *重要提示:*\n`;
    message += `• 请勿向任何人透露私钥！\n`;
    message += `• 建议立即保存并删除此消息\n\n`;
    message += `⏱️ *3秒后返回钱包详情...*`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown'
    });
    await ctx.answerCbQuery('✅ 已显示私钥');

    // 3秒后返回钱包详情
    setTimeout(async () => {
      try {
        ctx.match = [null, walletId.toString()];
        await bot.handleUpdate({
          ...ctx.update,
          callback_query: {
            ...ctx.update.callback_query,
            data: `select_wallet_${walletId}`
          }
        });
      } catch (error) {
        console.error('返回钱包详情错误:', error);
      }
    }, 3000);

  } catch (error) {
    console.error('查看私钥错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 邀请好友
bot.action('invite', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const user = await db.createOrGetUser(knex, userId, ctx.from.username || '未知');
    const botUsername = ctx.botInfo.username;
    const inviteLink = `https://t.me/${botUsername}?start=${userId}`;
    // 转义链接中的特殊字符（用于 Markdown 显示）
    const escapedInviteLink = inviteLink.replace(/_/g, '\\_');

    let message = `👥 *邀请好友*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `🎁 *邀请奖励*\n`;
    message += `邀请好友使用本机器人，获得更多收益！\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *邀请统计*\n`;
    message += `├ 已邀请: *${user.invite_count}* 人\n`;
    message += `└ 你的用户ID: \`${escapeMarkdown(userId)}\`\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `🔗 *你的邀请链接:*\n${escapedInviteLink}\n\n`;
    message += `💡 *如何邀请:*\n`;
    message += `将上方链接分享给朋友，他们点击即可注册并绑定为你的邀请！`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('📤 分享邀请链接', `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('🚀 加入币安 Meme Rush 自动购买机器人！')}`)],
        [Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]
      ])
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('邀请好友错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 查看私钥（当前钱包）
bot.action('show_private_key', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || '未知用户';

  try {
    const wallet = await db.getActiveWallet(knex, userId);
    const user = await db.createOrGetUser(knex, userId, username);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 钱包未找到');
      return;
    }

    // 先更新消息显示私钥
    await ctx.editMessageText(
      `🔑 *钱包 #${wallet.wallet_number} 私钥信息*\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `📍 *地址:*\n\`${escapeMarkdown(wallet.address)}\`\n\n` +
      `🔐 *私钥:*\n\`${escapeMarkdown(wallet.private_key)}\`\n\n` +
      `📝 *助记词:*\n\`${escapeMarkdown(wallet.mnemonic)}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ *重要提示:*\n` +
      `• 请勿向任何人透露私钥！\n` +
      `• 建议立即保存并删除此消息\n` +
      `• 私钥泄露将导致资产丢失\n\n` +
      `⏱️ *3秒后自动返回主菜单...*`,
      { parse_mode: 'Markdown' }
    );

    await ctx.answerCbQuery('✅ 已显示私钥信息，请注意安全！');

    // 3秒后自动返回主菜单
    setTimeout(async () => {
      try {
        const balance = await getWalletBalance(wallet.address);
        const walletCount = await db.getWalletCount(knex, userId);

        let message = `🚀 *币安 Meme Rush 自动购买机器人*\n\n`;
        message += `━━━━━━━━━━━━━━━━━━━\n\n`;
        message += `👤 *用户:* @${escapeMarkdown(username)}\n`;
        message += `💰 *余额:* ${balance} BNB\n`;
        message += `💼 *当前钱包:* #${wallet.wallet_number} / ${walletCount}\n`;
        message += `👥 *邀请:* ${user.invite_count} 人\n\n`;
        message += `请选择操作 👇`;

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...getMainMenuKeyboard()
        });
      } catch (error) {
        console.error('自动返回主菜单错误:', error);
      }
    }, 3000);

  } catch (error) {
    console.error('查看私钥错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 帮助信息
bot.action('help', async (ctx) => {
  try {
    let message = `📖 *使用帮助*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `🤖 *关于机器人*\n`;
    message += `币安 Meme Rush 自动购买机器人，帮助你自动购买所有新发射的 Meme 代币。\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `✨ *主要功能*\n`;
    message += `• 💰 查看钱包信息和余额\n`;
    message += `• 🔑 查看私钥和助记词\n`;
    message += `• 👥 邀请好友获得奖励\n`;
    message += `• 🤖 自动购买新币（即将开放）\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📝 *使用步骤*\n`;
    message += `1️⃣ 向钱包地址充值 BNB\n`;
    message += `2️⃣ 设置自动购买参数\n`;
    message += `3️⃣ 开启自动购买功能\n`;
    message += `4️⃣ 机器人自动监控新币\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `⚠️ *安全提示*\n`;
    message += `• 妥善保管私钥\n`;
    message += `• 建议小额测试\n`;
    message += `• 投资有风险\n`;
    message += `• 谨慎决策\n\n`;
    message += `💬 *联系客服:* @support (示例)`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]
      ])
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('显示帮助错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 开始狙击
bot.action('start_sniper', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const wallet = await db.getActiveWallet(knex, userId);
    if (!wallet) {
      await ctx.answerCbQuery('❌ 请先创建钱包');
      return;
    }

    // 启用当前钱包的狙击功能
    await db.setWalletSniperState(knex, wallet.id, true);

    let message = `🎯 *狙击模式已启动!*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `✅ *状态:* 正在监控新代币\n`;
    message += `💰 *购买金额:* ${wallet.buy_amount} BNB\n`;
    message += `📊 *滑点:* ${wallet.slippage}%\n`;
    message += `⛽ *Gas:* ${wallet.gas_price} Gwei\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `🔍 *过滤条件:*\n`;
    message += `├ 社区链接: ${wallet.filter_social ? '✅' : '❌'}\n`;
    message += `├ 持币人数: ${wallet.filter_min_holders > 0 ? `≥${wallet.filter_min_holders}人` : '不限制'}\n`;
    message += `├ Top10占比: ${wallet.filter_top10_max < 100 ? `≤${wallet.filter_top10_max}%` : '不限制'}\n`;
    message += `└ 币安专属: ${wallet.filter_binance_only ? '✅' : '❌'}\n\n`;
    message += `💡 *提示:* 机器人将自动购买符合条件的新代币`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🛑 停止狙击', 'stop_sniper')],
        [Markup.button.callback('📊 狙击列表', 'sniper_list')],
        [Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]
      ])
    });
    await ctx.answerCbQuery('✅ 狙击模式已启动');
  } catch (error) {
    console.error('启动狙击错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 停止狙击
bot.action('stop_sniper', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    // 停止当前钱包的狙击功能
    const wallet = await db.getActiveWallet(knex, userId);
    if (wallet) {
      await db.setWalletSniperState(knex, wallet.id, false);
    }

    let message = `🛑 *狙击模式已停止*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `❌ *状态:* 已停止监控\n`;
    message += `💡 *提示:* 可以随时重新启动狙击模式\n\n`;
    message += `📊 查看历史狙击记录:`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎯 开始狙击', 'start_sniper')],
        [Markup.button.callback('📊 狙击列表', 'sniper_list')],
        [Markup.button.callback('🔙 返回主菜单', 'back_to_menu')]
      ])
    });
    await ctx.answerCbQuery('✅ 狙击模式已停止');
  } catch (error) {
    console.error('停止狙击错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// =======================
// 扫链模式 开关与配置
// =======================

// 启动扫链（当前激活钱包）
bot.action('start_sweep', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const wallet = await db.getActiveWallet(knex, userId);
    if (!wallet) { await ctx.answerCbQuery('❌ 请先创建钱包'); return; }
    await db.setWalletSweepState(knex, wallet.id, true);
    await ctx.answerCbQuery('✅ 扫链已启动');
    try { await ctx.editMessageReplyMarkup((await getMainMenuKeyboard(userId)).reply_markup); } catch (_) { }
    startSweepScanner();
  } catch (error) {
    sweepLogger.error('启动扫链错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 停止扫链（当前激活钱包）
bot.action('stop_sweep', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const wallet = await db.getActiveWallet(knex, userId);
    if (wallet) { await db.setWalletSweepState(knex, wallet.id, false); }
    const cnt = await knex('wallets').where({ sweep_enabled: 1 }).count('* as c').first();
    const c = Number((cnt && (cnt.c || cnt.count)) || 0);
    if (c === 0) { await stopSweepScanner(); }
    await ctx.answerCbQuery('✅ 扫链已停止');
    try { await ctx.editMessageReplyMarkup((await getMainMenuKeyboard(userId)).reply_markup); } catch (_) { }
  } catch (error) {
    sweepLogger.error('停止扫链错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 针对指定钱包 启动扫链
bot.action(/^start_sweep_wallet_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    await db.setWalletSweepState(knex, walletId, true);
    await ctx.answerCbQuery('✅ 已为该钱包开启扫链');
    startSweepScanner();
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: { ...ctx.update.callback_query, data: `select_wallet_${walletId}` }
    });
  } catch (error) {
    sweepLogger.error('开启指定钱包扫链失败:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 针对指定钱包 停止扫链
bot.action(/^stop_sweep_wallet_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    await db.setWalletSweepState(knex, walletId, false);
    const cnt = await knex('wallets').where({ sweep_enabled: 1 }).count('* as c').first();
    const c = Number((cnt && (cnt.c || cnt.count)) || 0);
    if (c === 0) { await stopSweepScanner(); }
    await ctx.answerCbQuery('✅ 已为该钱包停止扫链');
    ctx.match = [null, walletId.toString()];
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: { ...ctx.update.callback_query, data: `select_wallet_${walletId}` }
    });
  } catch (error) {
    sweepLogger.error('停止指定钱包扫链失败:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 扫链策略管理（最简版展示当前配置）
bot.action('sweep_strategy_management', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const activeWallet = await db.getActiveWallet(knex, userId);
    if (!activeWallet) { await ctx.answerCbQuery('❌ 没有激活的钱包'); return; }
    let message = `🧰 *钱包 #${activeWallet.wallet_number} 扫链配置*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前配置*\n\n`;
    message += `💰 *买入金额:* ${(activeWallet.sweep_buy_amount ?? activeWallet.buy_amount) || 0} BNB\n`;
    message += `📈 *滑点:* ${(activeWallet.sweep_slippage ?? activeWallet.slippage) || 0}%\n`;
    message += `⛽ *Gas价格:* ${(activeWallet.sweep_gas_price ?? activeWallet.gas_price) || 0} Gwei\n`;
    message += `📈 *进度(progress)过滤:* ≥${activeWallet.sweep_filter_progress_min ?? 0}%\n\n`;
    const buttons = [
      [Markup.button.callback('💰 买入金额', `set_sweep_amount_${activeWallet.id}`), Markup.button.callback('📈 滑点', `set_sweep_slippage_${activeWallet.id}`)],
      [Markup.button.callback('⛽ Gas', `set_sweep_gas_${activeWallet.id}`), Markup.button.callback('🔍 过滤选项', `sweep_filters_${activeWallet.id}`)],
      [Markup.button.callback('📊 止盈止损', `tpsl_${activeWallet.id}_sweep`)],
      [Markup.button.callback('⬅️ 返回', 'back_to_menu')]
    ];
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    await ctx.answerCbQuery();
  } catch (error) {
    sweepLogger.error('扫链策略管理错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 扫链参数设置：买入金额
bot.action(/^set_sweep_amount_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) { await ctx.answerCbQuery('❌ 钱包不存在或已删除'); return; }
    let message = `💰 *设置扫链买入金额*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${(wallet.sweep_buy_amount ?? wallet.buy_amount) || 0} BNB\n\n`;
    const buttons = [
      [Markup.button.callback('0.001', `sweep_amount_${walletId}_0.001`), Markup.button.callback('0.005', `sweep_amount_${walletId}_0.005`)],
      [Markup.button.callback('0.01', `sweep_amount_${walletId}_0.01`), Markup.button.callback('0.02', `sweep_amount_${walletId}_0.02`)],
      [Markup.button.callback('0.05', `sweep_amount_${walletId}_0.05`), Markup.button.callback('0.1', `sweep_amount_${walletId}_0.1`)],
      [Markup.button.callback('✏️ 自定义', `custom_sweep_amount_${walletId}`), Markup.button.callback('🔙 返回', `sweep_strategy_management`)]
    ];
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    await ctx.answerCbQuery();
  } catch (e) { sweepLogger.error('设置扫链买入金额错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

bot.action(/^sweep_amount_(\d+)_(.+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const amount = parseFloat(ctx.match[2]);
  const userId = ctx.from.id.toString();
  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'sweep_buy_amount', amount);
    await ctx.answerCbQuery(`✅ 已设置扫链买入金额为 ${amount} BNB`);
    await bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.update.callback_query, data: `sweep_strategy_management` } });
  } catch (e) { sweepLogger.error('确认扫链买入金额错误:', e); await ctx.answerCbQuery('❌ 修改失败'); }
});

bot.action(/^custom_sweep_amount_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    setUserInputState(userId, { type: 'sweep_buy_amount', walletId, messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(`✏️ *自定义扫链买入金额*\n\n━━━━━━━━━━━━━━━━━━━\n\n请直接输入BNB数量`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', 'sweep_strategy_management')]]) });
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (e) { sweepLogger.error('自定义扫链买入金额错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

// 扫链参数设置：滑点
bot.action(/^set_sweep_slippage_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) { await ctx.answerCbQuery('❌ 钱包不存在或已删除'); return; }
    let message = `📈 *设置扫链滑点*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${(wallet.sweep_slippage ?? wallet.slippage) || 0}%\n\n`;
    const buttons = [
      [Markup.button.callback('5%', `sweep_slippage_${walletId}_5`), Markup.button.callback('10%', `sweep_slippage_${walletId}_10`)],
      [Markup.button.callback('15%', `sweep_slippage_${walletId}_15`), Markup.button.callback('20%', `sweep_slippage_${walletId}_20`)],
      [Markup.button.callback('30%', `sweep_slippage_${walletId}_30`), Markup.button.callback('50%', `sweep_slippage_${walletId}_50`)],
      [Markup.button.callback('✏️ 自定义', `custom_sweep_slippage_${walletId}`), Markup.button.callback('🔙 返回', `sweep_strategy_management`)]
    ];
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    await ctx.answerCbQuery();
  } catch (e) { sweepLogger.error('设置扫链滑点错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

bot.action(/^sweep_slippage_(\d+)_(.+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const slippage = parseFloat(ctx.match[2]);
  const userId = ctx.from.id.toString();
  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'sweep_slippage', slippage);
    await ctx.answerCbQuery(`✅ 已设置扫链滑点为 ${slippage}%`);
    await bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.update.callback_query, data: `sweep_strategy_management` } });
  } catch (e) { sweepLogger.error('确认扫链滑点错误:', e); await ctx.answerCbQuery('❌ 修改失败'); }
});

bot.action(/^custom_sweep_slippage_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    setUserInputState(userId, { type: 'sweep_slippage', walletId, messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(`✏️ *自定义扫链滑点*\n\n━━━━━━━━━━━━━━━━━━━\n\n请输入滑点百分比 0-100`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', 'sweep_strategy_management')]]) });
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (e) { sweepLogger.error('自定义扫链滑点错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

// 扫链参数设置：Gas
bot.action(/^set_sweep_gas_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) { await ctx.answerCbQuery('❌ 钱包不存在或已删除'); return; }
    let message = `⛽ *设置扫链Gas价格*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${(wallet.sweep_gas_price ?? wallet.gas_price) || 0} Gwei\n\n`;
    const buttons = [
      [Markup.button.callback('3 Gwei', `sweep_gas_${walletId}_3`), Markup.button.callback('5 Gwei', `sweep_gas_${walletId}_5`)],
      [Markup.button.callback('8 Gwei', `sweep_gas_${walletId}_8`), Markup.button.callback('10 Gwei', `sweep_gas_${walletId}_10`)],
      [Markup.button.callback('15 Gwei', `sweep_gas_${walletId}_15`), Markup.button.callback('20 Gwei', `sweep_gas_${walletId}_20`)],
      [Markup.button.callback('✏️ 自定义', `custom_sweep_gas_${walletId}`), Markup.button.callback('🔙 返回', `sweep_strategy_management`)]
    ];
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    await ctx.answerCbQuery();
  } catch (e) { sweepLogger.error('设置扫链Gas错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

bot.action(/^sweep_gas_(\d+)_(.+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const gasPrice = parseInt(ctx.match[2]);
  const userId = ctx.from.id.toString();
  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'sweep_gas_price', gasPrice);
    await ctx.answerCbQuery(`✅ 已设置扫链Gas为 ${gasPrice} Gwei`);
    await bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.update.callback_query, data: `sweep_strategy_management` } });
  } catch (e) { sweepLogger.error('确认扫链Gas错误:', e); await ctx.answerCbQuery('❌ 修改失败'); }
});

bot.action(/^custom_sweep_gas_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    setUserInputState(userId, { type: 'sweep_gas_price', walletId, messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(`✏️ *自定义扫链Gas价格*\n\n━━━━━━━━━━━━━━━━━━━\n\n请输入正整数(Gwei)`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', 'sweep_strategy_management')]]) });
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (e) { sweepLogger.error('自定义扫链Gas错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

// 扫链过滤选项
bot.action(/^sweep_filters_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) { await ctx.answerCbQuery('❌ 钱包不存在或已删除'); return; }
    let message = `🔍 *钱包 #${wallet.wallet_number} 扫链过滤*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前过滤条件*\n\n`;
    const socialIcon = wallet.sweep_filter_social ? '✅' : '❌';
    message += `${socialIcon} *社区链接:* ${wallet.sweep_filter_social ? '必须有' : '不限制'}\n\n`;
    const holdersText = toNumberSafe(wallet.sweep_filter_min_holders, 0) > 0 ? `≥${wallet.sweep_filter_min_holders}人` : '不限制';
    message += `👥 *持币人数:* ${holdersText}\n\n`;
    const top10Text = toNumberSafe(wallet.sweep_filter_top10_max, 100) < 100 ? `≤${wallet.sweep_filter_top10_max}%` : '不限制';
    message += `🔝 *Top10占比:* ${top10Text}\n\n`;
    const progressText = toNumberSafe(wallet.sweep_filter_progress_min, 0) > 0 ? `≥${wallet.sweep_filter_progress_min}%` : '不限制';
    message += `📈 *进度(progress):* ${progressText}\n\n`;
    const sweepLaunchTimeText = toNumberSafe(wallet.sweep_filter_max_launch_minutes, 0) > 0 ? `≤${wallet.sweep_filter_max_launch_minutes}分钟` : '不限制';
    message += `⏰ *发射时间:* ${sweepLaunchTimeText}\n\n`;
    const buttons = [
      [Markup.button.callback('🌐 社区链接', `toggle_sweep_social_${walletId}`), Markup.button.callback('👥 持币人数', `set_sweep_holders_${walletId}`)],
      [Markup.button.callback('🔝 Top10占比', `set_sweep_top10_${walletId}`), Markup.button.callback('📈 进度', `set_sweep_progress_${walletId}`)],
      [Markup.button.callback('⏰ 发射时间', `set_sweep_launch_time_${walletId}`)],
      [Markup.button.callback('🔙 返回', `sweep_strategy_management`)]
    ];
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    await ctx.answerCbQuery();
  } catch (e) { sweepLogger.error('扫链过滤选项错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

bot.action(/^toggle_sweep_social_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) { await ctx.answerCbQuery('❌ 钱包不存在或已删除'); return; }
    const newValue = wallet.sweep_filter_social ? 0 : 1;
    await db.updateWalletStrategy(knex, walletId, userId, 'sweep_filter_social', newValue);
    await ctx.answerCbQuery(`✅ 社区链接过滤${newValue ? '已开启' : '已关闭'}`);
    await bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.update.callback_query, data: `sweep_filters_${walletId}` } });
  } catch (e) { sweepLogger.error('切换扫链社区链接错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

// 设置扫链持币人数
bot.action(/^set_sweep_holders_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) { await ctx.answerCbQuery('❌ 钱包不存在或已删除'); return; }
    let message = `👥 *设置最少持币人数(扫链)*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${toNumberSafe(wallet.sweep_filter_min_holders, 0) > 0 ? wallet.sweep_filter_min_holders + '人' : '不限制'}\n\n`;
    const buttons = [
      [Markup.button.callback('不限制', `holders_sweep_${walletId}_0`), Markup.button.callback('50人', `holders_sweep_${walletId}_50`)],
      [Markup.button.callback('100人', `holders_sweep_${walletId}_100`), Markup.button.callback('200人', `holders_sweep_${walletId}_200`)],
      [Markup.button.callback('500人', `holders_sweep_${walletId}_500`), Markup.button.callback('1000人', `holders_sweep_${walletId}_1000`)],
      [Markup.button.callback('✏️ 自定义', `custom_sweep_holders_${walletId}`), Markup.button.callback('🔙 返回', `sweep_filters_${walletId}`)]
    ];
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    await ctx.answerCbQuery();
  } catch (e) { sweepLogger.error('设置扫链持币人数错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

bot.action(/^holders_sweep_(\d+)_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const value = parseInt(ctx.match[2]);
  const userId = ctx.from.id.toString();
  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'sweep_filter_min_holders', value);
    await ctx.answerCbQuery(`✅ 已设置为 ${value > 0 ? '≥' + value + '人' : '不限制'}`);
    await bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.update.callback_query, data: `sweep_filters_${walletId}` } });
  } catch (e) { sweepLogger.error('确认扫链持币人数错误:', e); await ctx.answerCbQuery('❌ 设置失败'); }
});

bot.action(/^custom_sweep_holders_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    setUserInputState(userId, { type: 'sweep_filter_min_holders', walletId, messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(`✏️ *自定义最少持币人数(扫链)*\n\n━━━━━━━━━━━━━━━━━━━\n\n请输入 ≥ 0 的整数`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `sweep_filters_${walletId}`)]]) });
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (e) { sweepLogger.error('自定义扫链持币人数错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

// 设置扫链Top10
bot.action(/^set_sweep_top10_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) { await ctx.answerCbQuery('❌ 钱包不存在或已删除'); return; }
    let message = `🔝 *设置Top10最大占比(扫链)*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${toNumberSafe(wallet.sweep_filter_top10_max, 100) < 100 ? wallet.sweep_filter_top10_max + '%' : '不限制'}\n\n`;
    const buttons = [
      [Markup.button.callback('不限制', `top10_sweep_${walletId}_100`), Markup.button.callback('≤10%', `top10_sweep_${walletId}_10`)],
      [Markup.button.callback('≤20%', `top10_sweep_${walletId}_20`), Markup.button.callback('≤30%', `top10_sweep_${walletId}_30`)],
      [Markup.button.callback('≤40%', `top10_sweep_${walletId}_40`), Markup.button.callback('≤50%', `top10_sweep_${walletId}_50`)],
      [Markup.button.callback('✏️ 自定义', `custom_sweep_top10_${walletId}`), Markup.button.callback('🔙 返回', `sweep_filters_${walletId}`)]
    ];
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    await ctx.answerCbQuery();
  } catch (e) { sweepLogger.error('设置扫链Top10错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

bot.action(/^top10_sweep_(\d+)_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const value = parseInt(ctx.match[2]);
  const userId = ctx.from.id.toString();
  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'sweep_filter_top10_max', value);
    await ctx.answerCbQuery(`✅ 已设置Top10占比为 ${value < 100 ? '≤' + value + '%' : '不限制'}`);
    await bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.update.callback_query, data: `sweep_filters_${walletId}` } });
  } catch (e) { sweepLogger.error('确认扫链Top10错误:', e); await ctx.answerCbQuery('❌ 设置失败'); }
});

bot.action(/^custom_sweep_top10_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    setUserInputState(userId, { type: 'sweep_filter_top10_max', walletId, messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(`✏️ *自定义Top10最大占比(扫链)*\n\n━━━━━━━━━━━━━━━━━━━\n\n请输入 0-100 的数字`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `sweep_filters_${walletId}`)]]) });
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (e) { sweepLogger.error('自定义扫链Top10错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

// 设置扫链进度(progress)
bot.action(/^set_sweep_progress_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) { await ctx.answerCbQuery('❌ 钱包不存在或已删除'); return; }
    let message = `📈 *设置进度(progress)最小值*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${toNumberSafe(wallet.sweep_filter_progress_min, 0)}%\n\n`;
    const buttons = [
      [Markup.button.callback('0%', `progress_sweep_${walletId}_0`), Markup.button.callback('50%', `progress_sweep_${walletId}_50`)],
      [Markup.button.callback('70%', `progress_sweep_${walletId}_70`), Markup.button.callback('85%', `progress_sweep_${walletId}_85`)],
      [Markup.button.callback('90%', `progress_sweep_${walletId}_90`), Markup.button.callback('✏️ 自定义', `custom_sweep_progress_${walletId}`)],
      [Markup.button.callback('🔙 返回', `sweep_filters_${walletId}`)]
    ];
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    await ctx.answerCbQuery();
  } catch (e) { sweepLogger.error('设置扫链进度错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

bot.action(/^progress_sweep_(\d+)_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const value = parseInt(ctx.match[2]);
  const userId = ctx.from.id.toString();
  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'sweep_filter_progress_min', value);
    await ctx.answerCbQuery(`✅ 已设置进度为 ≥${value}%`);
    await bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.update.callback_query, data: `sweep_filters_${walletId}` } });
  } catch (e) { sweepLogger.error('确认扫链进度错误:', e); await ctx.answerCbQuery('❌ 设置失败'); }
});

bot.action(/^custom_sweep_progress_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    setUserInputState(userId, { type: 'sweep_filter_progress_min', walletId, messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(`✏️ *自定义进度(progress)最小值*\n\n━━━━━━━━━━━━━━━━━━━\n\n请输入 0-100 的数字`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `sweep_filters_${walletId}`)]]) });
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (e) { sweepLogger.error('自定义扫链进度错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

// 设置扫链发射时间限制
bot.action(/^set_sweep_launch_time_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    const wallets = await db.getUserWallets(knex, userId);
    const wallet = wallets.find(w => w.id === walletId);
    if (!wallet) { await ctx.answerCbQuery('❌ 钱包不存在或已删除'); return; }
    let message = `⏰ *设置发射时间限制(扫链)*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *当前设置:* ${toNumberSafe(wallet.sweep_filter_max_launch_minutes, 0) > 0 ? wallet.sweep_filter_max_launch_minutes + '分钟' : '不限制'}\n\n`;
    message += `💡 *说明:* 只买入发射时间在限制内的代币\n`;
    message += `例如设置5分钟，则只买入发射后5分钟内的代币\n\n`;
    const buttons = [
      [Markup.button.callback('不限制', `sweep_launch_time_${walletId}_0`), Markup.button.callback('1分钟', `sweep_launch_time_${walletId}_1`)],
      [Markup.button.callback('3分钟', `sweep_launch_time_${walletId}_3`), Markup.button.callback('5分钟', `sweep_launch_time_${walletId}_5`)],
      [Markup.button.callback('10分钟', `sweep_launch_time_${walletId}_10`), Markup.button.callback('30分钟', `sweep_launch_time_${walletId}_30`)],
      [Markup.button.callback('✏️ 自定义', `custom_sweep_launch_time_${walletId}`), Markup.button.callback('🔙 返回', `sweep_filters_${walletId}`)]
    ];
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    await ctx.answerCbQuery();
  } catch (e) { sweepLogger.error('设置扫链发射时间错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

bot.action(/^sweep_launch_time_(\d+)_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const value = parseInt(ctx.match[2]);
  const userId = ctx.from.id.toString();
  try {
    await db.updateWalletStrategy(knex, walletId, userId, 'sweep_filter_max_launch_minutes', value);
    await ctx.answerCbQuery(`✅ 已设置为 ${value > 0 ? '≤' + value + '分钟' : '不限制'}`);
    await bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.update.callback_query, data: `sweep_filters_${walletId}` } });
  } catch (e) { sweepLogger.error('确认扫链发射时间错误:', e); await ctx.answerCbQuery('❌ 设置失败'); }
});

bot.action(/^custom_sweep_launch_time_(\d+)$/, async (ctx) => {
  const walletId = parseInt(ctx.match[1]);
  const userId = ctx.from.id.toString();
  try {
    setUserInputState(userId, { type: 'sweep_filter_max_launch_minutes', walletId, messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(`✏️ *自定义发射时间限制(扫链)*\n\n━━━━━━━━━━━━━━━━━━━\n\n请输入分钟数 (0表示不限制)`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ 取消', `sweep_filters_${walletId}`)]]) });
    await ctx.answerCbQuery('💬 请在聊天框输入数值');
  } catch (e) { sweepLogger.error('自定义扫链发射时间错误:', e); await ctx.answerCbQuery('❌ 操作失败'); }
});

// 狙击列表
bot.action('sniper_list', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const records = await db.getUserSniperRecords(knex, userId, 10);
    const stats = await db.getUserSniperStats(knex, userId);

    let message = `📈 *持仓监控*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *概览*\n`;
    message += `🎯 总计: ${stats.total} 笔\n`;
    message += `💵 投入: ${stats.total_amount ? parseFloat(stats.total_amount).toFixed(4) : '0'} BNB\n`;
    message += `💎 价值: $${stats.total_usd_value ? parseFloat(stats.total_usd_value).toFixed(2) : '0'}\n\n`;

    if (records.length === 0) {
      message += `📝 *暂无狙击记录*\n\n`;
      message += `💡 *提示:* 启动狙击模式后，符合条件的代币将自动购买`;
    } else {
      message += `📝 *最近狙击记录*\n\n`;
      records.forEach((record, index) => {
        const status = record.status === 'success' ? '✅' : '❌';
        const time = new Date(record.created_at).toLocaleString('zh-CN');
        const bribeAmount = record.bribe_amount && parseFloat(record.bribe_amount) > 0
          ? parseFloat(record.bribe_amount).toFixed(4)
          : null;

        message += `${index + 1}. ${status} ${record.token_symbol || 'Unknown'}\n`;
        message += `   ├ 地址: \`${record.token_address}\`\n`;
        message += `   ├ 金额: ${record.buy_amount} BNB\n`;
        if (bribeAmount) {
          message += `   ├ 贿赂: ${bribeAmount} BNB\n`;
        }
        message += `   ├ 预期价格: ${record.buy_price ? parseFloat(record.buy_price).toFixed(8) : 'N/A'}\n`;
        message += `   ├ 实际价格: ${record.actual_buy_price ? parseFloat(record.actual_buy_price).toFixed(8) : 'N/A'}\n`;
        message += `   ├ 代币余额: ${record.token_balance ? parseFloat(record.token_balance).toFixed(2) : 'N/A'}\n`;
        message += `   ├ USD价值: $${record.usd_value ? parseFloat(record.usd_value).toFixed(2) : 'N/A'}\n`;
        message += `   ├ 时间: ${time}\n`;
        if (record.tx_hash) {
          message += `   └ 交易: \`${record.tx_hash}\`\n`;
        }
        message += `\n`;
      });
    }

    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `💡 *操作提示:*\n`;
    message += `• 点击记录可查看详细信息\n`;
    message += `• 启动狙击模式开始自动购买`;

    const buttons = [];
    if (records.length > 0) {
      buttons.push([Markup.button.callback('🔍 查看详情', 'sniper_details')]);
    }
    buttons.push([
      Markup.button.callback('🎯 开始狙击', 'start_sniper'),
      Markup.button.callback('🔙 返回主菜单', 'back_to_menu')
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('狙击列表错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 收益统计
bot.action('earnings', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const stats = await db.getUserSniperStats(knex, userId);

    let message = `💰 *收益统计*\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 *交易统计*\n`;
    message += `🎯 总交易: ${stats.total || 0} 笔\n`;
    message += `💵 总投入: ${stats.total_amount ? parseFloat(stats.total_amount).toFixed(4) : '0'} BNB\n`;
    message += `💎 持仓价值: $${stats.total_usd_value ? parseFloat(stats.total_usd_value).toFixed(2) : '0'}\n\n`;

    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `🔥 *性能指标*\n`;
    message += `⚡ 平均成交价: ${stats.avg_actual_price ? parseFloat(stats.avg_actual_price).toFixed(8) : '0'}\n`;
    message += `🎲 成功率: ${stats.total > 0 ? ((stats.total / stats.total) * 100).toFixed(1) : '0'}%\n\n`;

    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `💡 *提示*\n`;
    message += `• 继续优化策略以提高收益\n`;
    message += `• 及时止盈止损控制风险`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📈 持仓监控', 'sniper_list')],
        [Markup.button.callback('⬅️ 返回', 'back_to_menu')]
      ])
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('收益统计错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 返回主菜单
bot.action('back_to_menu', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || '未知用户';

  try {
    const user = await db.createOrGetUser(knex, userId, username);
    const wallet = await db.getActiveWallet(knex, userId);
    const walletCount = await db.getWalletCount(knex, userId);

    if (!wallet) {
      await ctx.answerCbQuery('❌ 系统错误');
      return;
    }

    const balance = await getWalletBalance(wallet.address);
    const isSniperActive = await db.getActiveWalletSniperStatus(knex, userId);

    // 获取 BNB 价格
    let bnbPrice = 0;
    let usdValue = 0;
    try {
      bnbPrice = await getTokenUsdPriceByRouter(WBNB_ADDRESS);
      if (bnbPrice > 0) {
        usdValue = parseFloat(balance) * bnbPrice;
      }
    } catch (e) {
      console.error('获取BNB价格失败:', e);
    }

    let message = `🎯 *MEME RUSH SNIPER BOT*\n`;
    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `⚡ *极速狙击 · 自动交易 · 智能止盈*\n\n`;

    message += `💎 *钱包 #${wallet.wallet_number}*\n`;
    message += `\`${wallet.address}\`\n`;
    message += `💰 余额: *${balance} BNB*\n`;
    if (bnbPrice > 0) {
      message += `💵 价值: *$${usdValue.toFixed(2)}* (BNB: $${bnbPrice.toFixed(2)})\n`;
    }
    message += `🌐 网络: BSC Mainnet\n\n`;

    if (walletCount > 1) {
      message += `📊 共有 *${walletCount}* 个钱包\n\n`;
    }

    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `🎁 *邀请返佣*\n`;
    message += `已邀请 *${user.invite_count}* 人\n`;
    if (user.invite_count > 0) {
      message += `🔥 继续邀请赚取更多奖励！\n\n`;
    } else {
      message += `💡 分享链接即可获得奖励\n\n`;
    }

    message += `━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `⚙️ *快速设置*\n`;
    message += `1️⃣ 充值 BNB 到钱包\n`;
    message += `2️⃣ 配置狙击策略\n`;
    message += `3️⃣ 启动自动狙击\n\n`;

    message += `⚠️ DYOR | NFA`;

    // 防止 Telegram 400: message is not modified
    const keyboard = await getMainMenuKeyboard(userId);
    const currentMsg = ctx.callbackQuery && ctx.callbackQuery.message;
    const sameText = currentMsg && currentMsg.text === message;
    const sameMarkup = currentMsg && currentMsg.reply_markup && keyboard &&
      JSON.stringify(currentMsg.reply_markup) === JSON.stringify(keyboard.reply_markup);
    if (sameText && sameMarkup) {
      await ctx.answerCbQuery('已在主菜单');
      return;
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...keyboard
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('返回主菜单错误:', error);
    await ctx.answerCbQuery('❌ 操作失败');
  }
});

// 处理用户文本消息（用于自定义输入）
bot.on('text', async (ctx) => {
  if (!ctx || !ctx.from || !ctx.from.id || !ctx.message || typeof ctx.message.text !== 'string') {
    return;
  }
  const userId = ctx.from.id.toString();
  const inputState = getUserInputState(userId);

  // 如果没有输入状态或者是命令，忽略此消息
  if (!inputState || ctx.message.text.startsWith('/')) {
    return;
  }

  const text = ctx.message.text.trim();
  const { type, walletId, messageId } = inputState;

  try {
    let value;
    let isValid = false;
    let errorMsg = '';

    // 根据类型验证输入
    if (type === 'buy_amount') {
      value = parseFloat(text);
      if (isNaN(value) || value <= 0) {
        errorMsg = '❌ 请输入大于 0 的数字！';
      } else {
        isValid = true;
      }
    } else if (type === 'slippage') {
      value = parseFloat(text);
      if (isNaN(value) || value < 0 || value > 100) {
        errorMsg = '❌ 请输入 0-100 之间的数字！';
      } else {
        isValid = true;
      }
    } else if (type === 'gas_price') {
      value = parseInt(text);
      if (isNaN(value) || value <= 0 || !Number.isInteger(parseFloat(text))) {
        errorMsg = '❌ 请输入正整数！';
      } else {
        isValid = true;
      }
    } else if (type === 'bribe_amount') {
      value = parseFloat(text);
      if (isNaN(value) || value < 0) {
        errorMsg = '❌ 请输入大于等于 0 的数字！';
      } else {
        isValid = true;
      }
    } else if (type === 'add_take_profit' || type === 'add_stop_loss') {
      // 止盈止损输入格式: "涨幅% 卖出%"
      const parts = text.trim().split(/\s+/);
      if (parts.length !== 2) {
        errorMsg = '❌ 格式错误！请输入两个数字，用空格分隔';
      } else {
        const pricePercent = parseFloat(parts[0]);
        const sellPercent = parseFloat(parts[1]);

        if (isNaN(pricePercent) || isNaN(sellPercent)) {
          errorMsg = '❌ 请输入有效的数字！';
        } else if (pricePercent <= 0) {
          errorMsg = '❌ 涨幅/跌幅必须大于 0！';
        } else if (sellPercent < 0 || sellPercent > 100) {
          errorMsg = '❌ 卖出比例必须在 0-100 之间！';
        } else {
          value = {
            pricePercent: type === 'add_stop_loss' ? -Math.abs(pricePercent) : pricePercent,
            sellPercent: sellPercent
          };
          isValid = true;
        }
      }
    } else if (type === 'filter_min_holders') {
      // 持币人数
      value = parseInt(text);
      if (isNaN(value) || value < 0 || !Number.isInteger(parseFloat(text))) {
        errorMsg = '❌ 请输入 ≥ 0 的整数！';
      } else {
        isValid = true;
      }
    } else if (type === 'filter_top10_max') {
      // Top10占比
      value = parseFloat(text);
      if (isNaN(value) || value < 0 || value > 100) {
        errorMsg = '❌ 请输入 0-100 之间的数字！';
      } else {
        isValid = true;
      }
    } else if (type === 'waiting_drop_percentage') {
      // 等待下跌百分比
      value = parseFloat(text);
      if (isNaN(value) || value < 1 || value > 100) {
        errorMsg = '❌ 请输入 1-100 之间的数字！';
      } else {
        isValid = true;
      }
    } else if (type === 'sweep_buy_amount') {
      value = parseFloat(text);
      if (isNaN(value) || value <= 0) {
        errorMsg = '❌ 请输入大于 0 的数字！';
      } else {
        isValid = true;
      }
    } else if (type === 'sweep_slippage') {
      value = parseFloat(text);
      if (isNaN(value) || value < 0 || value > 100) {
        errorMsg = '❌ 请输入 0-100 之间的数字！';
      } else {
        isValid = true;
      }
    } else if (type === 'sweep_gas_price') {
      value = parseInt(text);
      if (isNaN(value) || value <= 0 || !Number.isInteger(parseFloat(text))) {
        errorMsg = '❌ 请输入正整数！';
      } else {
        isValid = true;
      }
    } else if (type === 'sweep_filter_min_holders') {
      value = parseInt(text);
      if (isNaN(value) || value < 0 || !Number.isInteger(parseFloat(text))) {
        errorMsg = '❌ 请输入 ≥ 0 的整数！';
      } else {
        isValid = true;
      }
    } else if (type === 'sweep_filter_top10_max' || type === 'sweep_filter_progress_min') {
      value = parseFloat(text);
      if (isNaN(value) || value < 0 || value > 100) {
        errorMsg = '❌ 请输入 0-100 之间的数字！';
      } else {
        isValid = true;
      }
    } else if (type === 'filter_max_launch_minutes' || type === 'sweep_filter_max_launch_minutes') {
      value = parseInt(text);
      if (isNaN(value) || value < 0 || !Number.isInteger(parseFloat(text))) {
        errorMsg = '❌ 请输入 ≥ 0 的整数！';
      } else {
        isValid = true;
      }
    }

    if (isValid) {
      // 保存设置
      if (type === 'add_take_profit' || type === 'add_stop_loss') {
        // 止盈止损特殊处理（支持模式）
        const tpslType = type === 'add_take_profit' ? 'take_profit' : 'stop_loss';
        const mode = (inputState && inputState.tpslMode) ? inputState.tpslMode : 'sniper';
        await db.addTPSL(knex, walletId, tpslType, value.pricePercent, value.sellPercent, mode);

        // 清除输入状态
        clearUserInputState(userId);

        const typeText = type === 'add_take_profit' ? '止盈' : '止损';
        const priceText = type === 'add_take_profit' ? `涨${value.pricePercent}%` : `跌${Math.abs(value.pricePercent)}%`;
        await ctx.reply(`✅ ${typeText}添加成功！\n${priceText} 时卖出 ${value.sellPercent}%`);

        // 返回止盈止损界面
        const wallets = await db.getUserWallets(knex, userId);
        const wallet = wallets.find(w => w.id === walletId);

        if (wallet) {
          const mode = (inputState && inputState.tpslMode) ? inputState.tpslMode : 'sniper';
          const takeProfits = await db.getTPSL(knex, walletId, 'take_profit', mode);
          const stopLosses = await db.getTPSL(knex, walletId, 'stop_loss', mode);

          let message = `📊 *钱包 #${wallet.wallet_number} 止盈止损*\n\n`;
          message += `━━━━━━━━━━━━━━━━━━━\n\n`;

          // 止盈配置
          message += `📈 *止盈设置* (${takeProfits.length}/5)\n`;
          if (takeProfits.length === 0) {
            message += `└ 未设置\n\n`;
          } else {
            takeProfits.forEach((tp, index) => {
              const prefix = index === takeProfits.length - 1 ? '└' : '├';
              message += `${prefix} 涨 ${tp.price_percent}% 时卖出 ${tp.sell_percent}%\n`;
            });
            message += `\n`;
          }

          // 止损配置
          message += `📉 *止损设置* (${stopLosses.length}/1)\n`;
          if (stopLosses.length === 0) {
            message += `└ 未设置\n\n`;
          } else {
            const sl = stopLosses[0];
            message += `└ 跌 ${Math.abs(sl.price_percent)}% 时卖出 ${sl.sell_percent}%\n\n`;
          }

          message += `━━━━━━━━━━━━━━━━━━━\n\n`;
          message += `💡 *说明:*\n`;
          message += `• 止盈: 价格上涨到指定%时自动卖出\n`;
          message += `• 止损: 价格下跌到指定%时自动卖出`;

          const buttons = [
            [
              Markup.button.callback('➕ 添加止盈', `add_tp_${walletId}_${mode}`),
              Markup.button.callback('➕ 添加止损', `add_sl_${walletId}_${mode}`)
            ]
          ];

          if (takeProfits.length > 0) {
            buttons.push([Markup.button.callback('📈 管理止盈', `manage_tp_${walletId}_${mode}`)]);
          }

          if (stopLosses.length > 0) {
            buttons.push([Markup.button.callback('📉 管理止损', `manage_sl_${walletId}_${mode}`)]);
          }

          buttons.push([Markup.button.callback('🔙 返回', `strategy_${walletId}`)]);

          await bot.telegram.editMessageText(
            ctx.chat.id,
            messageId,
            undefined,
            message,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard(buttons)
            }
          );
        }
      } else if (type === 'filter_min_holders' || type === 'filter_top10_max' || type === 'filter_max_launch_minutes') {
        // 过滤选项特殊处理
        await db.updateWalletStrategy(knex, walletId, userId, type, value);

        // 清除输入状态
        clearUserInputState(userId);

        let unitText = '';
        let successText = '';
        if (type === 'filter_min_holders') {
          successText = value > 0 ? `最少持币人数 ${value}人` : '持币人数不限制';
        } else if (type === 'filter_top10_max') {
          successText = value < 100 ? `Top10占比 ≤${value}%` : 'Top10占比不限制';
        } else if (type === 'filter_max_launch_minutes') {
          successText = value > 0 ? `发射时间 ≤${value}分钟` : '发射时间不限制';
        }

        await ctx.reply(`✅ 设置成功！\n${successText}`);

        // 返回过滤选项界面
        const wallets = await db.getUserWallets(knex, userId);
        const wallet = wallets.find(w => w.id === walletId);

        if (wallet) {
          let message = `🔍 *钱包 #${wallet.wallet_number} 过滤选项*\n\n`;
          message += `━━━━━━━━━━━━━━━━━━━\n\n`;
          message += `📊 *当前过滤条件*\n\n`;

          // 社区链接
          const socialIcon = wallet.filter_social ? '✅' : '❌';
          message += `${socialIcon} *社区链接:* ${wallet.filter_social ? '必须有' : '不限制'}\n`;
          message += `└ 推特、TG等社交媒体链接\n\n`;

          // 持币人数
          const holdersText = wallet.filter_min_holders > 0 ? `≥${wallet.filter_min_holders}人` : '不限制';
          message += `👥 *持币人数:* ${holdersText}\n`;
          message += `└ 最少持币地址数量\n\n`;

          // Top10占比
          const top10Text = wallet.filter_top10_max < 100 ? `≤${wallet.filter_top10_max}%` : '不限制';
          message += `🔝 *Top10占比:* ${top10Text}\n`;
          message += `└ 前10地址持币总占比\n\n`;


          // 币安专属
          const binanceIcon = wallet.filter_binance_only ? '✅' : '❌';
          message += `${binanceIcon} *币安专属:* ${wallet.filter_binance_only ? '仅币安发射' : '不限制'}\n`;
          message += `└ 只接受币安平台发射的代币\n\n`;

          // 发射时间限制
          const launchTimeText = toNumberSafe(wallet.filter_max_launch_minutes, 0) > 0 ? `≤${wallet.filter_max_launch_minutes}分钟` : '不限制';
          message += `⏰ *发射时间:* ${launchTimeText}\n`;
          message += `└ 只买入发射时间在限制内的代币\n\n`;

          message += `━━━━━━━━━━━━━━━━━━━\n\n`;
          message += `💡 *说明:* 开启过滤后，只有符合条件的代币才会被自动买入`;

          const buttons = [
            [
              Markup.button.callback('🌐 社区链接', `toggle_social_${walletId}`),
              Markup.button.callback('👥 持币人数', `set_holders_${walletId}`)
            ],
            [
              Markup.button.callback('🔝 Top10占比', `set_top10_${walletId}`),
              Markup.button.callback('⏰ 发射时间', `set_launch_time_${walletId}`)
            ],
            [
              Markup.button.callback('🟡 币安专属', `toggle_binance_${walletId}`)
            ],
            [Markup.button.callback('🔙 返回', `strategy_${walletId}`)]
          ];

          await bot.telegram.editMessageText(
            ctx.chat.id,
            messageId,
            undefined,
            message,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard(buttons)
            }
          );
        }
      } else if (type === 'waiting_drop_percentage') {
        // 等待下跌百分比特殊处理
        await knex('wallets')
          .where({ id: walletId, user_id: userId })
          .update({ drop_percentage: value });

        // 清除输入状态
        clearUserInputState(userId);

        await ctx.reply(`✅ 设置成功！等待下跌 ${value}%`);

        // 返回等待下跌设置界面
        const wallets = await db.getUserWallets(knex, userId);
        const wallet = wallets.find(w => w.id === walletId);

        if (wallet) {
          let message = `📉 *等待下跌设置*\n\n`;
          message += `━━━━━━━━━━━━━━━━━━━\n\n`;
          message += `📊 *当前状态:* ${wallet.wait_for_drop ? `🟢 开启 (${value}%)` : '⚪ 关闭'}\n\n`;
          message += `💡 *功能说明:*\n`;
          message += `• 开启后，检测到新代币时不会立即买入\n`;
          message += `• 系统会监控代币价格变化\n`;
          message += `• 当价格下跌达到设定百分比时自动买入\n`;
          message += `• 监控时间：24小时\n\n`;
          message += `⚠️ *注意:* 价格可能不会下跌到目标值`;

          const buttons = [
            [
              Markup.button.callback(wallet.wait_for_drop ? '⚪ 关闭功能' : '🟢 开启功能', `toggle_wait_drop_${walletId}`)
            ]
          ];

          if (wallet.wait_for_drop) {
            buttons.push([
              Markup.button.callback('5%', `drop_percent_${walletId}_5`),
              Markup.button.callback('10%', `drop_percent_${walletId}_10`)
            ]);
            buttons.push([
              Markup.button.callback('15%', `drop_percent_${walletId}_15`),
              Markup.button.callback('20%', `drop_percent_${walletId}_20`)
            ]);
            buttons.push([
              Markup.button.callback('30%', `drop_percent_${walletId}_30`),
              Markup.button.callback('✏️ 自定义', `custom_drop_${walletId}`)
            ]);
          }

          buttons.push([Markup.button.callback('🔙 返回', `strategy_${walletId}`)]);

          await bot.telegram.editMessageText(
            ctx.chat.id,
            messageId,
            undefined,
            message,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard(buttons)
            }
          );
        }
      } else if (type === 'sweep_filter_min_holders' || type === 'sweep_filter_top10_max' || type === 'sweep_filter_progress_min' || type === 'sweep_filter_max_launch_minutes') {
        // 扫链过滤选项（保存后返回过滤页面）
        await db.updateWalletStrategy(knex, walletId, userId, type, value);
        clearUserInputState(userId);
        await ctx.reply('✅ 设置成功！');
        // 重建过滤界面并编辑原消息
        const wallets2 = await db.getUserWallets(knex, userId);
        const wallet2 = wallets2.find(w => w.id === walletId);
        if (wallet2) {
          let message2 = `🔍 *钱包 #${wallet2.wallet_number} 扫链过滤*\n\n`;
          message2 += `━━━━━━━━━━━━━━━━━━━\n\n`;
          message2 += `📊 *当前过滤条件*\n\n`;
          const socialIcon2 = wallet2.sweep_filter_social ? '✅' : '❌';
          message2 += `${socialIcon2} *社区链接:* ${wallet2.sweep_filter_social ? '必须有' : '不限制'}\n\n`;
          const holdersText2 = toNumberSafe(wallet2.sweep_filter_min_holders, 0) > 0 ? `≥${wallet2.sweep_filter_min_holders}人` : '不限制';
          message2 += `👥 *持币人数:* ${holdersText2}\n\n`;
          const top10Text2 = toNumberSafe(wallet2.sweep_filter_top10_max, 100) < 100 ? `≤${wallet2.sweep_filter_top10_max}%` : '不限制';
          message2 += `🔝 *Top10占比:* ${top10Text2}\n\n`;
          const progressText2 = toNumberSafe(wallet2.sweep_filter_progress_min, 0) > 0 ? `≥${wallet2.sweep_filter_progress_min}%` : '不限制';
          message2 += `📈 *进度(progress):* ${progressText2}\n\n`;
          const sweepLaunchTimeText2 = toNumberSafe(wallet2.sweep_filter_max_launch_minutes, 0) > 0 ? `≤${wallet2.sweep_filter_max_launch_minutes}分钟` : '不限制';
          message2 += `⏰ *发射时间:* ${sweepLaunchTimeText2}\n\n`;
          const buttons2 = [
            [Markup.button.callback('🌐 社区链接', `toggle_sweep_social_${walletId}`), Markup.button.callback('👥 持币人数', `set_sweep_holders_${walletId}`)],
            [Markup.button.callback('🔝 Top10占比', `set_sweep_top10_${walletId}`), Markup.button.callback('📈 进度', `set_sweep_progress_${walletId}`)],
            [Markup.button.callback('⏰ 发射时间', `set_sweep_launch_time_${walletId}`)],
            [Markup.button.callback('🔙 返回', `sweep_strategy_management`)]
          ];
          await bot.telegram.editMessageText(
            ctx.chat.id,
            messageId,
            undefined,
            message2,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons2) }
          );
        }
      } else if (type === 'sweep_buy_amount' || type === 'sweep_slippage' || type === 'sweep_gas_price') {
        // 扫链基础参数（保存后返回扫链配置页）
        await db.updateWalletStrategy(knex, walletId, userId, type, value);
        clearUserInputState(userId);
        await ctx.reply('✅ 设置成功！');
        // 使用 walletId 重建扫链配置界面
        const wallets3 = await db.getUserWallets(knex, userId);
        const wallet3 = wallets3.find(w => w.id === walletId);
        if (wallet3) {
          let message3 = `🧰 *扫链配置*\n\n`;
          message3 += `━━━━━━━━━━━━━━━━━━━\n\n`;
          message3 += `💰 *买入金额:* ${(wallet3.sweep_buy_amount ?? wallet3.buy_amount) || 0} BNB\n`;
          message3 += `📈 *滑点:* ${(wallet3.sweep_slippage ?? wallet3.slippage) || 0}%\n`;
          message3 += `⛽ *Gas:* ${(wallet3.sweep_gas_price ?? wallet3.gas_price) || 0} Gwei\n`;
          message3 += `📈 *进度(progress)过滤:* ≥${wallet3.sweep_filter_progress_min ?? 0}%\n\n`;
          const buttons3 = [
            [Markup.button.callback('💰 买入金额', `set_sweep_amount_${wallet3.id}`), Markup.button.callback('📈 滑点', `set_sweep_slippage_${wallet3.id}`)],
            [Markup.button.callback('⛽ Gas', `set_sweep_gas_${wallet3.id}`), Markup.button.callback('🔍 过滤选项', `sweep_filters_${wallet3.id}`)],
            [Markup.button.callback('⬅️ 返回', 'back_to_menu')]
          ];
          await bot.telegram.editMessageText(
            ctx.chat.id,
            messageId,
            undefined,
            message3,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons3) }
          );
        }
      } else {
        // 常规策略设置
        await db.updateWalletStrategy(knex, walletId, userId, type, value);

        // 清除输入状态
        clearUserInputState(userId);

        // 显示成功消息
        let unitText = '';
        if (type === 'buy_amount') unitText = ' BNB';
        else if (type === 'slippage') unitText = '%';
        else if (type === 'gas_price') unitText = ' Gwei';
        else if (type === 'bribe_amount') unitText = ' BNB';

        await ctx.reply(`✅ 设置成功！${value}${unitText}`);

        // 返回策略设置界面
        const wallets = await db.getUserWallets(knex, userId);
        const wallet = wallets.find(w => w.id === walletId);

        if (wallet) {
          let message = `⚙️ *钱包 #${wallet.wallet_number} 策略设置*\n\n`;
          message += `━━━━━━━━━━━━━━━━━━━\n\n`;
          message += `📊 *当前策略配置*\n\n`;
          message += `💰 *买入金额:* ${wallet.buy_amount} BNB\n`;
          message += `每次自动购买新币使用的BNB数量\n\n`;
          message += `📈 *滑点:* ${wallet.slippage}%\n`;
          message += `允许的价格波动范围\n\n`;
          message += `⛽ *Gas价格:* ${wallet.gas_price} Gwei\n`;
          message += `交易的Gas费用设置\n\n`;
          message += `📉 *等待下跌:* ${wallet.wait_for_drop ? `🟢 ${wallet.drop_percentage}%` : '⚪ 关闭'}\n`;
          message += `等待代币价格下跌后再买入\n\n`;
          message += `━━━━━━━━━━━━━━━━━━━\n\n`;
          message += `点击下方按钮修改策略参数`;

          const buttons = [
            [
              Markup.button.callback('💰 买入金额', `set_amount_${walletId}`),
              Markup.button.callback('📈 滑点', `set_slippage_${walletId}`)
            ],
            [
              Markup.button.callback('⛽ Gas', `set_gas_${walletId}`),
              Markup.button.callback('📊 止盈止损', `tpsl_${walletId}`)
            ],
            [
              Markup.button.callback('💸 贿赂', `set_bribe_${walletId}`),
              Markup.button.callback('🔍 过滤选项', `filters_${walletId}`)
            ],
            [
              Markup.button.callback('📉 等待下跌', `wait_drop_${walletId}`)
            ],
            [Markup.button.callback('⬅️ 返回', 'back_to_menu')]
          ];

          await bot.telegram.editMessageText(
            ctx.chat.id,
            messageId,
            undefined,
            message,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard(buttons)
            }
          );
        }
      }
    } else {
      // 显示错误消息
      await ctx.reply(errorMsg + '\n\n请重新输入或点击取消按钮返回。');
    }
  } catch (error) {
    console.error('处理用户输入错误:', error);
    await ctx.reply('❌ 设置失败，请重试');
    clearUserInputState(userId);
  }
});

// 初始化数据库并启动机器人
async function startBot() {
  try {
    // MySQL schema already created
    if (process.env.SCANNER_ENABLED !== '0') {
      initEventScanner();
    } else {
      console.log('⏭️ 跳过 WS 扫描器 (SCANNER_ENABLED=0)');
    }

    // 检查 FeeCollector 配置
    if (!FEE_COLLECTOR_ADDRESS) {

      setTimeout(() => process.exit(1), 5000);
      return;
    }
    // 启动价格子进程（统一 LIMIT/TP/SL 与价格字典）
    startPriceWorker();
    await bot.launch();

    // 如有钱包已开启扫链，则自动启动扫链监听
    try {
      const cnt = await knex('wallets').where({ sweep_enabled: 1 }).count('* as c').first();
      const c = Number((cnt && (cnt.c || cnt.count)) || 0);
      if (c > 0) {
        startSweepScanner();
        sweepLogger.log('▶️ 检测到有钱包开启扫链，已自动启动扫链监听');
      }
    } catch (e) {
      sweepLogger.error('检查扫链状态失败:', e);
    }

    // 启动价格监控调度器
    if (process.env.USE_DB_PRICE_SCHEDULER === '1') {
      startPriceMonitorScheduler();
    } else {
      console.log('⏭️ 跳过 DB 价格监控调度器，使用子进程 priceWorker');
    }

    // 恢复价格监听状态（从文件恢复）

  } catch (error) {
    console.error('启动机器人失败:', error);
    process.exit(1);
  }
}

// 优雅关闭
process.once('SIGINT', () => {
  console.log('收到 SIGINT 信号，正在关闭...');

  // 保存监听器状态
  console.log('💾 正在保存监听器状态...');


  // 停止价格监控调度器
  stopPriceMonitorScheduler();

  cleanupScanner();
  console.log('WebSocket 连接已关闭');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('收到 SIGTERM 信号，正在关闭...');

  // 保存监听器状态
  console.log('💾 正在保存监听器状态...');
  savePriceMonitorsState();

  // 停止价格监控调度器
  stopPriceMonitorScheduler();

  cleanupScanner();
  console.log('WebSocket 连接已关闭');
  bot.stop('SIGTERM');
});

// 测试策略匹配功能


// ============ 全局错误捕获（防止程序崩溃）============

// 捕获未处理的 Promise 拒绝
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未处理的 Promise 拒绝:', reason);
  console.error('Promise:', promise);
  // 不要退出进程，继续运行
});

// 捕获未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获的异常:', error);
  console.error('堆栈:', error.stack);

  // 尝试清理资源
  try {
    savePriceMonitorsState();
    console.log('💾 已保存监听器状态');
  } catch (e) {
    console.error('保存状态失败:', e);
  }

  // 不要退出进程，继续运行
  // 注意：在生产环境中，可能需要根据错误类型决定是否重启
});

// 捕获警告（包括 Promise 相关警告）
process.on('warning', (warning) => {
  console.warn('⚠️ 进程警告:', warning.name);
  console.warn('消息:', warning.message);
  if (warning.stack) {
    console.warn('堆栈:', warning.stack);
  }
});

// 定期输出内存使用情况（每30分钟）
setInterval(() => {
  const used = process.memoryUsage();
  console.log('📊 内存使用情况:');
  console.log(`  - RSS: ${Math.round(used.rss / 1024 / 1024)}MB`);
  console.log(`  - Heap Total: ${Math.round(used.heapTotal / 1024 / 1024)}MB`);
  console.log(`  - Heap Used: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
  console.log(`  - External: ${Math.round(used.external / 1024 / 1024)}MB`);

  // 清理用户输入状态（超过1小时未使用的）
  pruneOldStates(60 * 60 * 1000);
}, 30 * 60 * 1000);

// 启动
startBot();

// 安全的监听器状态保存（占位实现，避免未定义导致崩溃）
function savePriceMonitorsState() {
  try {
    const file = path.join(__dirname, 'price_monitors.json');
    const payload = { ts: Date.now() };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  } catch (e) {
    // 忽略写入失败
  }
}
