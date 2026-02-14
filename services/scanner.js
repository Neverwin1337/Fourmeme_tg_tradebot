const { ethers } = require('ethers');

function createScannerService({
  wsUrl,
  contractAddress,
  functionSelector,
  eventQueue,
  knex,
  db,
  getTokenInfo,
  getTokenMetaInfo,
  getTokenDynamicInfoV4,
  toNumberSafe,
  getTokenUsdPriceByRouter,
  addLimitListenerToWorker,
  addTPSLListenersToWorker,
  autoBuyToken,
  checkSingleWalletStrategy,
  logger = console
}) {
  const state = {
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

  async function start() {
    if (state.starting || state.running || state.shouldStop) return;
    state.starting = true;
    try {
      let provider;
      try {
        provider = new ethers.WebSocketProvider(wsUrl);
      } catch (ctorErr) {
        // 无法创建 Provider，稍后重试
        state.starting = false;
        state.running = false;
        state.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 30000);
        logger.log(`⏱️ WebSocketProvider 创建失败，${delay}ms 后重试...`);
        state.reconnectTimer = setTimeout(() => { if (!state.shouldStop) start(); }, delay);
        return;
      }
      logger.log('🔄 开始订阅 pending transactions...');
      logger.log(`📍 目标合约: ${contractAddress}`);
      logger.log(`📍 Function Selector: ${functionSelector}`);

      state.provider = provider;

      // 先绑定底层事件，避免早期错误未捕获
      const wsEarly = provider._websocket || provider.websocket;
      if (wsEarly && typeof wsEarly.on === 'function') {
        wsEarly.on('error', (error) => {
          logger.error('❌ WebSocket error (early):', error);
        });
        wsEarly.on('close', (code, reason) => {
          logger.log(`⚠️ WebSocket closed (early) (code: ${code}, reason: ${reason})`);
        });
      }
      const subscriptionId = await provider.send('eth_subscribe', ['newPendingTransactions', true]);
      state.subscriptionId = subscriptionId;
      logger.log('✅ 订阅成功，subscription ID:', subscriptionId);

      const websocket = provider._websocket || provider.websocket;
      state.websocket = websocket;

      websocket.on('message', async (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.method === 'eth_subscription' && msg.params && msg.params.subscription === subscriptionId) {
            const tx = msg.params.result;
            if (tx && tx.to && tx.to.toLowerCase() === contractAddress.toLowerCase()) {
              const selector = tx.input.slice(0, 10);
              if (selector === functionSelector) {
                const base = '0x' + tx.input.slice(-40);
                eventQueue.add(async () => {
                  try {
                    await handleNewToken(base);
                  } catch (error) {
                    logger.error('❌ 处理消息失败:', error.message);
                  }
                }).catch((queueError) => {
                  logger.error('❌ 队列处理失败:', queueError.message);
                });
              }
            }
          }
        } catch {}
      });

      const ws = provider._websocket || provider.websocket;
      if (ws && typeof ws.on === 'function') {
        ws.on('error', (error) => {
          logger.error('❌ WebSocket error:', error);
          // 常见 ECONNREFUSED 时不抛出，让重连逻辑接管
        });
        ws.on('close', (code, reason) => {
          logger.log(`⚠️ WebSocket closed (code: ${code}, reason: ${reason})`);
          if (!state.shouldStop) {
            state.reconnectAttempts++;
            logger.log(`🔄 重连尝试 ${state.reconnectAttempts}/${state.maxReconnectAttempts}`);
            if (state.reconnectAttempts <= state.maxReconnectAttempts) {
              state.running = false;
              state.starting = false;
              const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 30000);
              logger.log(`⏱️ ${delay}ms 后重连...`);
              state.reconnectTimer = setTimeout(() => {
                if (!state.shouldStop) start();
              }, delay);
            } else {
              logger.error('❌ 达到最大重连次数，停止重连');
              state.shouldStop = true;
            }
          }
        });
      }

      state.running = true;
      state.starting = false;
      state.reconnectAttempts = 0;
      logger.log('✅ WebSocket 连接已建立');
    } catch (error) {
      logger.error('❌ Failed to initialize event scanner:', error);
      state.running = false;
      state.starting = false;
      if (!state.shouldStop) {
        state.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 30000);
        logger.log(`⏱️ 初始化失败，${delay}ms 后重试...`);
        state.reconnectTimer = setTimeout(() => {
          if (!state.shouldStop) start();
        }, delay);
      }
    }
  }

  async function handleNewToken(base) {
    try {
      const [tokenInfo, metaInfo] = await Promise.race([
        Promise.all([
          getTokenInfo(base).catch(() => null),
          getTokenMetaInfo(base).catch(() => null)
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('获取代币信息超时')), 10000))
      ]).catch(() => [null, null]);

      // 如果获取代币信息失败，直接跳过该代币
      if (!tokenInfo) {
        logger.log(`⏭️ 跳过代币 ${base.slice(0, 8)}... (获取代币信息失败)`);
        return;
      }
      
      // 验证 holders 数据是否有效
      if (tokenInfo.holders === undefined || tokenInfo.holders === null) {
        logger.log(`⏭️ 跳过代币 ${base.slice(0, 8)}... (holders 数据无效)`);
        return;
      }

      const allUsers = await knex('wallets').where('sniper_enabled', 1).distinct('user_id').select('user_id');
      const userPromises = allUsers.map(async (user) => {
        try {
          const sniperWallets = await db.getUserSniperWallets(knex, user.user_id);
          if (sniperWallets.length === 0) return;
          for (const wallet of sniperWallets) {
            const tokenInfoWithAddress = { ...tokenInfo, tokenAddress: base };
            const strategyResult = await checkSingleWalletStrategy(wallet, tokenInfoWithAddress, metaInfo);
            if (strategyResult.match) {
              if (wallet.wait_for_drop && wallet.drop_percentage > 0) {
                const initPrice = toNumberSafe(await getTokenUsdPriceByRouter(base), 0) || toNumberSafe(tokenInfo?.price, 0);
                await addLimitListenerToWorker(user.user_id, wallet.id, base, initPrice, wallet.drop_percentage, wallet.buy_amount, wallet.slippage, wallet.gas_price, wallet);
              } else {
                const result = await autoBuyToken(user.user_id, base, wallet.buy_amount, wallet.slippage, wallet.gas_price, wallet.id, wallet, 'sniper');
                if (result && result.success) {
                  const baseline = toNumberSafe(result.baselineUsdPrice, 0) || toNumberSafe(await getTokenUsdPriceByRouter(base), 0);
                  await addTPSLListenersToWorker(user.user_id, wallet.id, base, baseline, wallet);
                }
              }
            }
          }
        } catch (e) {
          logger.error(`❌ 用户 ${user.user_id} 策略检查失败:`, e.message);
        }
      });
      await Promise.allSettled(userPromises);
    } catch (error) {
      logger.error('❌ 处理新代币失败:', error.message || error);
    }
  }

  async function stop() {
    state.shouldStop = true;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    try { if (state.subscriptionId && state.provider) { await state.provider.send('eth_unsubscribe', [state.subscriptionId]).catch(() => {}); } } catch {}
    try { if (state.websocket) state.websocket.removeAllListeners(); } catch {}
    try { if (state.provider) await state.provider.destroy(); } catch {}
    state.provider = null; state.websocket = null; state.subscriptionId = null; state.running = false; state.starting = false; state.reconnectAttempts = 0;
    logger.log('⏹️ 扫描器已停止');
  }

  return { start, stop };
}

module.exports = { createScannerService };
