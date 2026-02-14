const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const PANCAKE_ROUTER_V2 = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const TOKEN_MANAGER_HELPER_V3 = '0xF251F83e40a78868FcfA3FA4599Dad6494E46034';

const RPC_URL = process.env.PRICE_WORKER_RPC || (config && config.rpc && config.rpc.public) || 'http://localhost:8545';
const provider = new ethers.JsonRpcProvider(RPC_URL);

const PANCAKE_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
];

const TOKEN_MODE_ABI = [
  'function _mode() view returns (uint256)'
];

const TOKEN_MANAGER_HELPER_V3_ABI = [
  `function getTokenInfo(address token) external view returns (
    uint256 version,
    address tokenManager,
    address quote,
    uint256 lastPrice,
    uint256 tradingFeeRate,
    uint256 minTradingFee,
    uint256 launchTime,
    uint256 offers,
    uint256 maxOffers,
    uint256 funds,
    uint256 maxFunds,
    bool liquidityAdded
  )`
];

const router = new ethers.Contract(PANCAKE_ROUTER_V2, PANCAKE_ROUTER_ABI, provider);
const helperV3 = new ethers.Contract(TOKEN_MANAGER_HELPER_V3, TOKEN_MANAGER_HELPER_V3_ABI, provider);

const priceDict = new Map();
const tokenSet = new Set();
const listenersByToken = new Map();
const decimalsCache = new Map();
const tokenModeCache = new Map(); // 缓存代币的 mode
let bnbPriceCache = { price: 0, updatedAt: 0 }; // 缓存 BNB 价格

const STATE_FILE = path.join(__dirname, 'price_state.json');
let saveTimer = null;

function toNumberSafe(v, f = 0) { const n = Number(v); return Number.isFinite(n) ? n : f; }

function safeSend(msg) {
  try { if (typeof process.send === 'function') { process.send(msg); } } catch {}
}

// Round-robin batching to avoid polling all tokens every tick
let rrIndex = 0;
const DEFAULT_MAX_PER_TICK = 20;

/**
 * 获取 BNB 的 USDT 价格（带缓存，30秒更新一次）
 */
async function getBnbPrice() {
  const now = Date.now();
  const cacheTime = 30000; // 30秒缓存
  if (bnbPriceCache.price > 0 && (now - bnbPriceCache.updatedAt) < cacheTime) {
    return bnbPriceCache.price;
  }
  try {
    const out = await router.getAmountsOut(ethers.parseEther('1'), [WBNB_ADDRESS, USDT_ADDRESS]);
    const price = toNumberSafe(ethers.formatUnits(out[1], 18), 0);
    bnbPriceCache = { price, updatedAt: now };
    return price;
  } catch {
    return bnbPriceCache.price || 0;
  }
}

/**
 * 获取代币的 mode（0=普通代币，1=TokenManager2代币）
 */
async function getTokenMode(token) {
  const t = token.toLowerCase();
  if (tokenModeCache.has(t)) {
    return tokenModeCache.get(t);
  }
  try {
    const modeContract = new ethers.Contract(token, TOKEN_MODE_ABI, provider);
    const mode = await modeContract._mode();
    const modeNum = Number(mode || 0);
    tokenModeCache.set(t, modeNum);
    return modeNum;
  } catch {
    // 如果调用失败，说明不是 TokenManager2 代币，mode = 0
    tokenModeCache.set(t, 0);
    return 0;
  }
}

/**
 * 使用 TokenManagerHelper3 V3 获取 mode=1 代币的价格
 */
async function getPriceFromV3Helper(token) {
  try {
    const result = await helperV3.getTokenInfo(token);
    const lastPrice = result[3]; // lastPrice 在返回值的第4个位置（索引3）
    const quote = result[2]; // quote token 地址
    
    // lastPrice 是代币相对于 quote token 的价格
    const lastPriceInQuote = toNumberSafe(ethers.formatEther(lastPrice), 0);
    
    if (lastPriceInQuote <= 0) return 0;
    
    // 如果 quote 是 BNB (address(0))，需要乘以 BNB 的 USDT 价格
    if (quote === ethers.ZeroAddress) {
      const bnbPrice = await getBnbPrice();
      if (bnbPrice <= 0) return 0;
      return lastPriceInQuote * bnbPrice;
    } else {
      // 如果 quote 是其他代币（如 USDT），直接返回
      // 这里假设 quote 就是 USDT，如果不是需要额外转换
      return lastPriceInQuote;
    }
  } catch (error) {
    console.error(`V3 Helper 获取价格失败 (${token.slice(0, 8)}...):`, error.message);
    return 0;
  }
}

async function getPrice(token) {
  try {
    if (token.toLowerCase() === WBNB_ADDRESS.toLowerCase()) {
      return await getBnbPrice();
    }
    
    // 检查代币的 mode
    const mode = await getTokenMode(token);
    
    // 如果是 mode=1 的代币，使用 V3 Helper 获取价格
    if (mode === 1) {
      const price = await getPriceFromV3Helper(token);
      if (price > 0) {
        return price;
      }
      // 如果 V3 Helper 失败，尝试使用 PancakeSwap
    }
    
    // 普通代币或 V3 Helper 失败时，使用 PancakeSwap 路由
    let decimals = decimalsCache.get(token.toLowerCase());
    if (decimals == null) {
      const erc20DecimalsAbi = ["function decimals() view returns (uint8)"];
      const erc20 = new ethers.Contract(token, erc20DecimalsAbi, provider);
      decimals = await erc20.decimals().catch(() => 18);
      decimalsCache.set(token.toLowerCase(), decimals);
    }
    const amountIn = ethers.parseUnits('1', decimals);
    const path = [token, WBNB_ADDRESS, USDT_ADDRESS];
    const out = await router.getAmountsOut(amountIn, path);
    return toNumberSafe(ethers.formatUnits(out[out.length - 1], 18), 0);
  } catch {
    return 0;
  }
}

function addToken(token) {
  const t = token.toLowerCase();
  if (!tokenSet.has(t)) tokenSet.add(t);
  if (!listenersByToken.has(t)) listenersByToken.set(t, []);
}

function addListener(token, listener) {
  const t = token.toLowerCase();
  addToken(t);
  const arr = listenersByToken.get(t);
  const l = { active: listener.active !== false, groupId: listener.groupId || null, ...listener };
  arr.push(l);
  scheduleSave();
}

function removeListener(token, predicate) {
  const t = token.toLowerCase();
  if (!listenersByToken.has(t)) return;
  const arr = listenersByToken.get(t).filter(l => !predicate(l));
  listenersByToken.set(t, arr);
  scheduleSave();
  pruneTokenIfIdle(t);
}

async function pollOnce() {
  const tokens = Array.from(tokenSet);
  if (tokens.length === 0) return;
  const max = Math.max(1, Number(process.env.PRICE_WORKER_MAX_PER_TICK || DEFAULT_MAX_PER_TICK));
  const start = rrIndex % tokens.length;
  let batch = tokens.slice(start, Math.min(tokens.length, start + max));
  if (batch.length < max && batch.length < tokens.length) {
    batch = batch.concat(tokens.slice(0, Math.min(max - batch.length, tokens.length)));
  }
  rrIndex = (start + batch.length) % tokens.length;
  for (const t of batch) {
    try {
      const p = await getPrice(t);
      if (!p || p <= 0) continue;
      priceDict.set(t, { price: p, updatedAt: Date.now() });
      evaluate(t, p);
    } catch {}
  }
}

function evaluate(token, price) {
  const arr = listenersByToken.get(token) || [];
  for (const l of arr) {
    if (l.active === false) continue;
    if (l.kind === 'limit' && !l.triggered) {
      let init = toNumberSafe(l.initial, 0);
      if ((init <= 0) && price > 0) {
        l.initial = price;
        init = price;
      }
      const dropPct = toNumberSafe(l.dropPct, 0);
      if (init > 0) {
        const chg = ((init - price) / init) * 100;
        if (chg >= dropPct) {
          l.triggered = true;
          safeSend({ type: 'limit_hit', token, price, listener: l });
          scheduleSave();
          pruneTokenIfIdle(token);
        }
      }
    } else if (l.kind === 'tp' && !l.triggered) {
      const base = toNumberSafe(l.baseline, 0);
      const thr = toNumberSafe(l.percent, 0);
      if (base > 0 && thr > 0) {
        const chg = ((price - base) / base) * 100;
        // 当价格上涨超过阈值时触发（chg 和 thr 都为正数）
        if (chg >= thr) {
          console.log(`🎯 止盈触发! 代币=${token.slice(0,8)}... 基准价=$${base.toFixed(8)} 当前价=$${price.toFixed(8)} 涨幅=${chg.toFixed(2)}% 阈值=${thr}% 卖出=${l.sellPercent}%`);
          l.triggered = true;
          safeSend({ type: 'tp_hit', token, price, listener: l, changePercent: chg });
          scheduleSave();
          pruneTokenIfIdle(token);
        } else if (chg > 0 && chg >= thr * 0.8) {
          // 距离触发还有 20% 时记录日志
          console.log(`👀 止盈接近: 代币=${token.slice(0,8)}... 涨幅=${chg.toFixed(2)}% 阈值=${thr}% (进度${(chg/thr*100).toFixed(1)}%)`);
        }
      } else {
        if (base <= 0) console.warn(`⚠️ 止盈监听器基准价无效: token=${token.slice(0,8)}... baseline=${base}`);
        if (thr <= 0) console.warn(`⚠️ 止盈监听器阈值无效: token=${token.slice(0,8)}... threshold=${thr}`);
      }
    } else if (l.kind === 'sl' && !l.triggered) {
      const base = toNumberSafe(l.baseline, 0);
      const thr = toNumberSafe(l.percent, 0); // percent 已经是正数（在 bot.js 中通过 Math.abs 转换）
      if (base > 0 && thr > 0) {
        const chg = ((price - base) / base) * 100;
        // 当价格下跌超过阈值时触发（chg 为负数，thr 为正数）
        if (chg <= -thr) {
          console.log(`🛑 止损触发! 代币=${token.slice(0,8)}... 基准价=$${base.toFixed(8)} 当前价=$${price.toFixed(8)} 跌幅=${chg.toFixed(2)}% 阈值=-${thr}% 卖出=${l.sellPercent}%`);
          l.triggered = true;
          safeSend({ type: 'sl_hit', token, price, listener: l, changePercent: chg });
          scheduleSave();
          pruneTokenIfIdle(token);
        } else if (chg < 0 && chg <= -thr * 0.8) {
          // 距离触发还有 20% 时记录日志
          console.log(`👀 止损接近: 代币=${token.slice(0,8)}... 跌幅=${chg.toFixed(2)}% 阈值=-${thr}% (进度${(Math.abs(chg)/thr*100).toFixed(1)}%)`);
        }
      } else {
        if (base <= 0) console.warn(`⚠️ 止损监听器基准价无效: token=${token.slice(0,8)}... baseline=${base}`);
        if (thr <= 0) console.warn(`⚠️ 止损监听器阈值无效: token=${token.slice(0,8)}... threshold=${thr}`);
      }
    }
  }
}

let pollTimer = null;
function start(intervalMs = 500) {
  if (pollTimer) return;
  pollTimer = setInterval(pollOnce, intervalMs);
}

process.on('message', async (msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'start') {
    start(msg.intervalMs || 500);
  } else if (msg.type === 'add_listener') {
    const { token, listener } = msg;
    if (!token || !listener) return;
    addListener(token, listener);
  } else if (msg.type === 'remove_listener') {
    const { token, predicate } = msg;
    if (!token) return;
    removeListener(token, predicate || (() => false));
  } else if (msg.type === 'add_tokens') {
    const { tokens } = msg;
    if (Array.isArray(tokens)) {
      tokens.forEach(addToken);
    }
  } else if (msg.type === 'get_price') {
    const { token, id } = msg;
    const t = token.toLowerCase();
    addToken(t);
    let p = priceDict.get(t);
    if (!p || !p.price || p.price <= 0) {
      const val = await getPrice(t);
      if (val && val > 0) {
        p = { price: val, updatedAt: Date.now() };
        priceDict.set(t, p);
      } else {
        p = { price: 0, updatedAt: 0 };
      }
    }
    safeSend({ type: 'price', id, token: t, price: p.price, updatedAt: p.updatedAt });
  } else if (msg.type === 'update_group') {
    const { token, groupId, patch } = msg;
    const t = (token || '').toLowerCase();
    if (!listenersByToken.has(t)) return;
    const arr = listenersByToken.get(t);
    for (const l of arr) {
      if (groupId && l.groupId === groupId) {
        Object.assign(l, patch || {});
      }
    }
    scheduleSave();
  }
});

safeSend({ type: 'ready' });
start(500);

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { saveState(); } catch {}
  }, 500);
}

function saveState() {
  const state = {
    priceDict: Array.from(priceDict.entries()),
    tokens: Array.from(listenersByToken.entries()).map(([token, arr]) => ({
      token,
      listeners: arr.map((l) => {
        const c = { ...l };
        if (c.walletData) { delete c.walletData; }
        return c;
      })
    }))
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch {}
}

function pruneTokenIfIdle(token) {
  const t = (token || '').toLowerCase();
  if (!listenersByToken.has(t)) {
    tokenSet.delete(t);
    priceDict.delete(t);
    decimalsCache.delete(t);
    return;
  }
  const arr = listenersByToken.get(t) || [];
  const active = arr.filter(l => l && l.active !== false && !l.triggered);
  if (active.length !== arr.length) {
    if (active.length > 0) {
      listenersByToken.set(t, active);
    } else {
      listenersByToken.delete(t);
      tokenSet.delete(t);
      priceDict.delete(t);
      decimalsCache.delete(t);
    }
  }
}

function cleanStaleTokens(maxIdleMs = 300000) {
  const now = Date.now();
  for (const t of Array.from(tokenSet)) {
    const arr = listenersByToken.get(t) || [];
    const active = arr.filter(l => l && l.active !== false && !l.triggered);
    if (active.length === 0) {
      listenersByToken.delete(t);
      tokenSet.delete(t);
      priceDict.delete(t);
      decimalsCache.delete(t);
      continue;
    }
    const p = priceDict.get(t);
    if (!p || !p.updatedAt || (now - p.updatedAt) > maxIdleMs) {
      priceDict.delete(t);
    }
  }
  scheduleSave();
}

setInterval(() => cleanStaleTokens(), 60000);

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    // restore priceDict
    if (Array.isArray(state.priceDict)) {
      for (const [k, v] of state.priceDict) {
        if (v && typeof v.price === 'number') {
          priceDict.set(k.toLowerCase(), v);
        }
      }
    }
    // restore listeners
    if (Array.isArray(state.tokens)) {
      for (const item of state.tokens) {
        const token = (item.token || '').toLowerCase();
        addToken(token);
        const arr = Array.isArray(item.listeners) ? item.listeners : [];
        listenersByToken.set(token, arr.map(l => ({ ...l })));
      }
    }
  } catch {}
}

// load persisted state before polling starts
loadState();

process.on('SIGINT', () => { try { saveState(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { saveState(); } catch {} process.exit(0); });
