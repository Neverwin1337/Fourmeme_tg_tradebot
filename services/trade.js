const { ethers } = require('ethers');
const config = require('../config');
const { localProvider, publicProvider } = require('../lib/providers');
const { waitForTransaction } = require('../lib/tx');
const tm2 = require('./tokenManager2');
const BundleSubmitter = require('../utils/bundleSubmitter');
const { PANCAKE_ROUTER_V2, PANCAKE_ROUTER_ABI, ERC20_ABI, FEE_COLLECTOR_ABI, WBNB_ADDRESS, USDT_ADDRESS } = require('../lib/constants');
const knex = require('../db/knex');
const db = require('../database');

// Caches
const signerCache = new Map();
const feeCollectorCache = new Map();
const sellLocks = new Map();
const { toNumberSafe } = require('../utils/helpers');

function createTradeService({ bot, sendInviteCommission, getTokenInfo, getTokenMetaInfo }) {
  const FEE_COLLECTOR_ADDRESS = config.feeCollectorAddress || '0x16867Ce6E979A4694d93E5ae81EDC0831A43D714';
  // buy
  async function autoBuyToken(userId, tokenAddress, buyAmount, slippage, gasPrice, walletId = null, walletOverride = null, mode = 'sniper') {
    try {
      const buyAmt = toNumberSafe(buyAmount, 0);
      const baseGas = toNumberSafe(gasPrice, 5);
      if (buyAmt <= 0) {
        throw new Error('买入金额无效');
      }

      // 获取目标钱包
      let wallet = null;
      if (walletOverride && walletOverride.address && walletOverride.private_key) {
        wallet = walletOverride;
      }
      if (!wallet && walletId) {
        wallet = await knex('wallets').where({ id: walletId, user_id: userId, sniper_enabled: 1 }).first();
      }
      if (!wallet) {
        wallet = await db.getActiveWallet(knex, userId);
      }
      if (!wallet) {
        throw new Error('用户没有激活的钱包');
      }

      const deadline = Math.floor(Date.now() / 1000) + 180;
      const amountIn = ethers.parseEther(buyAmt.toString());

      const cacheKey = wallet.address.toLowerCase();
      let walletSigner = signerCache.get(cacheKey);
      if (!walletSigner) {
        walletSigner = new ethers.Wallet(wallet.private_key, localProvider);
        signerCache.set(cacheKey, walletSigner);
      }
      let feeCollector = feeCollectorCache.get(cacheKey);
      if (!feeCollector) {
        feeCollector = new ethers.Contract(FEE_COLLECTOR_ADDRESS, FEE_COLLECTOR_ABI, walletSigner);
        feeCollectorCache.set(cacheKey, feeCollector);
      }

      // 余额与 nonce
      const [balance, pendingNonce] = await Promise.all([
        localProvider.getBalance(wallet.address),
        localProvider.getTransactionCount(wallet.address, 'pending')
      ]);
      const totalNeeded = amountIn;
      const fastGasPrice = baseGas;

      if (balance < totalNeeded) {
        const balanceInBnb = ethers.formatEther(balance);
        const neededInBnb = ethers.formatEther(totalNeeded);
        try {
          await knex('wallets').where({ id: wallet.id, user_id: userId }).update({ sniper_enabled: 0 });
          const message = `⚠️ *余额不足 - 狙击已停用*\n\n` +
            `钱包 #${wallet.wallet_number} 余额不足，已自动停用狙击功能。\n\n` +
            `📊 *余额情况*\n` +
            `当前余额: \`${balanceInBnb}\` BNB\n` +
            `需要: \`${neededInBnb}\` BNB (含 Gas 费)\n\n` +
            `💰 *充值地址*\n` +
            `\`${wallet.address}\``;
          await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
        } catch {}
        throw new Error(`钱包余额不足！已自动停用狙击功能。`);
      }

      // Gas 估算（使用默认回退）
      const gasLimit = 200000n;

      let tx, txHash;
      const mode = await tm2.getTokenMode(tokenAddress);
      if (mode === 1) {
        tx = await tm2.buyViaTokenManager2({ signer: walletSigner, tokenAddress, fundsWei: amountIn, minAmount: 0n, gasGwei: fastGasPrice, gasLimit, nonce: pendingNonce });
        txHash = tx.hash;
      } else {
        if (wallet.bribe_amount && wallet.bribe_amount > 0) {
          const mainTxData = feeCollector.interface.encodeFunctionData('swapBNBForTokens', [tokenAddress, 0, deadline, true]);
          const mainTx = { to: FEE_COLLECTOR_ADDRESS, data: mainTxData, value: amountIn, gasPrice: ethers.parseUnits(fastGasPrice.toFixed(1), 'gwei'), gasLimit, nonce: pendingNonce, chainId: 56 };
          const bundleSubmitter = new BundleSubmitter();
          try {
            const bundleResult = await bundleSubmitter.submitWithBribe(walletSigner, mainTx, wallet.bribe_amount, localProvider);
            if (bundleResult.normalTxHash) {
              txHash = bundleResult.normalTxHash;
              tx = await localProvider.getTransaction(txHash);
            } else {
              txHash = ethers.keccak256(bundleResult.mainTx);
              tx = { hash: txHash, wait: async () => { let receipt = null; let attempts = 0; const maxAttempts = 60; while (!receipt && attempts < maxAttempts) { try { receipt = await localProvider.getTransactionReceipt(txHash); if (receipt) break; } catch {} await new Promise(r => setTimeout(r, 5000)); attempts++; } if (!receipt) throw new Error('交易超时未确认'); return receipt; } };
            }
          } catch (bundleError) {
            tx = await feeCollector.swapBNBForTokens(tokenAddress, 0, deadline, true, { value: amountIn, gasPrice: ethers.parseUnits(fastGasPrice.toFixed(1), 'gwei'), gasLimit, nonce: pendingNonce });
            txHash = tx.hash;
          }
        } else {
          tx = await feeCollector.swapBNBForTokens(tokenAddress, 0, deadline, true, { value: amountIn, gasPrice: ethers.parseUnits(fastGasPrice.toFixed(1), 'gwei'), gasLimit, nonce: pendingNonce });
          txHash = tx.hash;
        }
      }

      const receipt = await waitForTransaction(tx);
      if (receipt.status === 1) {
        try {
          await sendInviteCommission(userId, wallet, buyAmount, 'buy').catch(() => {});
        } catch {}

        const tokenInfo = await getTokenInfo(tokenAddress);
        const metaInfo = await getTokenMetaInfo(tokenAddress);

        let tokenBalance = 0; let usdValue = 0; let baselineUsdPrice = 0; let actualBuyPriceBnbPerToken = 0;
        try {
          const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, publicProvider);
          const [rawBalance, tokenDecimals] = await Promise.all([tokenContract.balanceOf(wallet.address), tokenContract.decimals().catch(() => 18)]);
          const decimals = Number(tokenDecimals || 18);
          tokenBalance = Number(ethers.formatUnits(rawBalance, decimals));
          actualBuyPriceBnbPerToken = tokenBalance > 0 ? buyAmount / tokenBalance : 0;

          const routerForPrice = new ethers.Contract(PANCAKE_ROUTER_V2, PANCAKE_ROUTER_ABI, publicProvider);
          const out = await routerForPrice.getAmountsOut(ethers.parseEther('1'), [WBNB_ADDRESS, USDT_ADDRESS]);
          const bnbPrice = Number(ethers.formatUnits(out[1], 18));
          usdValue = buyAmount * bnbPrice;
          baselineUsdPrice = tokenBalance > 0 ? (buyAmount * bnbPrice) / tokenBalance : 0;
        } catch {}

        try {
          await db.addSniperRecord(knex, userId, wallet.id, tokenAddress, metaInfo?.name || 'Unknown', metaInfo?.symbol || 'Unknown', buyAmount, tokenInfo?.price || 0, baselineUsdPrice, tokenBalance, usdValue, tx.hash, receipt.gasUsed.toString(), 'success');
        } catch {}

        // 获取止盈止损配置（使用正确的模式）
        let tpslInfo = '';
        try {
          const [takeProfits, stopLosses] = await Promise.all([
            db.getTPSL(knex, wallet.id, 'take_profit', mode),
            db.getTPSL(knex, wallet.id, 'stop_loss', mode)
          ]);
          console.log(`📊 获取止盈止损配置: 模式=${mode} 止盈=${takeProfits.length}个 止损=${stopLosses.length}个`);
          
          if (takeProfits.length > 0 || stopLosses.length > 0) {
            tpslInfo = `\n📊 *止盈止损设置:*\n`;
            
            if (takeProfits.length > 0) {
              tpslInfo += `🎯 *止盈:*\n`;
              for (const tp of takeProfits) {
                const targetPrice = baselineUsdPrice * (1 + tp.price_percent / 100);
                tpslInfo += `  +${tp.price_percent}% → $${targetPrice.toFixed(8)} (卖${tp.sell_percent}%)\n`;
              }
            }
            
            if (stopLosses.length > 0) {
              tpslInfo += `🛑 *止损:*\n`;
              for (const sl of stopLosses) {
                const targetPrice = baselineUsdPrice * (1 + sl.price_percent / 100);
                tpslInfo += `  ${sl.price_percent}% → $${targetPrice.toFixed(8)} (卖${sl.sell_percent}%)\n`;
              }
            }
          }
        } catch (e) {
          console.error('获取止盈止损配置失败:', e.message);
        }

        const successMessage = `🎉 *自动购买成功!*\n\n` +
          `━━━━━━━━━━━━━━━━━━━\n\n` +
          `💰 *购买金额:* ${buyAmount} BNB\n` +
          `${wallet.bribe_amount && wallet.bribe_amount > 0 ? `💸 *贿赂金额:* ${wallet.bribe_amount} BNB\n` : ''}` +
          `🪙 *代币地址:* \`${tokenAddress}\`\n` +
          `📊 *滑点:* ${slippage}%\n\n` +
          `🎯 *到手数量:* ${tokenBalance.toFixed(6)} Token\n` +
          `💵 *平均买入价:* ${actualBuyPriceBnbPerToken ? actualBuyPriceBnbPerToken.toExponential(6) : 0} BNB/Token\n` +
          `💲 *USD买入价:* $${baselineUsdPrice.toFixed(8)}/Token${tpslInfo}\n\n` +
          `━━━━━━━━━━━━━━━━━━━\n\n` +
          `🔗 *交易哈希:*\n\`${tx.hash}\`\n\n` +
          `🌐 *BscScan:*\nhttps://bscscan.com/tx/${tx.hash}\n\n` +
          `⛽ *Gas使用:* ${receipt.gasUsed.toString()}`;
        await bot.telegram.sendMessage(userId, successMessage, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});

        return { success: true, txHash: tx.hash, gasUsed: receipt.gasUsed.toString(), baselineUsdPrice };
      } else {
        throw new Error('交易失败');
      }
    } catch (error) {
      const errorMessage = `❌ *自动购买失败*\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `🪙 *代币地址:* \`${tokenAddress}\`\n` +
        `💰 *购买金额:* ${buyAmount} BNB\n\n` +
        `❌ *错误信息:*\n\`${error.message}\`\n\n` +
        `💡 *建议:* 请检查余额和网络状况`;
      try { await bot.telegram.sendMessage(userId, errorMessage, { parse_mode: 'Markdown', disable_web_page_preview: true }); } catch {}
      return { success: false, error: error.message };
    }
  }

  async function autoSellToken(userId, walletId, tokenAddress, sellPercent, slippage, gasPrice, walletOverride = null) {
    const lockKey = `${walletId}_${tokenAddress.toLowerCase()}`;
    if (sellLocks.has(lockKey)) {
      return sellLocks.get(lockKey);
    }
    const sellPromise = (async () => {
      try {
        return await executeSellToken(userId, walletId, tokenAddress, sellPercent, slippage, gasPrice, walletOverride);
      } finally {
        sellLocks.delete(lockKey);
      }
    })();
    sellLocks.set(lockKey, sellPromise);
    return sellPromise;
  }

  async function executeSellToken(userId, walletId, tokenAddress, sellPercent, slippage, gasPrice, walletOverride = null) {
    try {
      const fastGasPrice = gasPrice;
      let wallet = walletOverride;
      if (!wallet) {
        wallet = await knex('wallets').where({ id: walletId, user_id: userId }).first();
      }
      if (!wallet) throw new Error('钱包不存在');

      const tokenContractRead = new ethers.Contract(tokenAddress, ERC20_ABI, publicProvider);
      const [balance, decimals, symbol] = await Promise.all([
        tokenContractRead.balanceOf(wallet.address),
        tokenContractRead.decimals().catch(() => 18),
        tokenContractRead.symbol().catch(() => 'Token')
      ]);
      if (balance === 0n) throw new Error('代币余额为0，无法卖出');

      const sellAmount = balance * BigInt(Math.floor(sellPercent)) / 100n;
      if (sellAmount === 0n) throw new Error('卖出数量为0');

      const deadline = Math.floor(Date.now() / 1000) + 180;
      const mode = await tm2.getTokenMode(tokenAddress);
      let allowance = await tokenContractRead.allowance(wallet.address, mode === 1 ? tm2.TM2_ADDRESS : config.feeCollectorAddress);

      const cacheKey = wallet.address.toLowerCase();
      let walletSigner = signerCache.get(cacheKey);
      if (!walletSigner) { walletSigner = new ethers.Wallet(wallet.private_key, localProvider); signerCache.set(cacheKey, walletSigner); }
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, walletSigner);

      if (allowance < sellAmount) {
        try {
          const currentNonce = await localProvider.getTransactionCount(wallet.address, 'pending');
          const latestNonce = await localProvider.getTransactionCount(wallet.address, 'latest');
          if (currentNonce > latestNonce) {
            await new Promise(res => setTimeout(res, 3000));
            allowance = await tokenContractRead.allowance(wallet.address, mode === 1 ? tm2.TM2_ADDRESS : config.feeCollectorAddress);
          }
          if (allowance < sellAmount) {
            const approveGasLimit = await tokenContract.approve.estimateGas(mode === 1 ? tm2.TM2_ADDRESS : config.feeCollectorAddress, ethers.MaxUint256).catch(() => 100000n);
            const approveTx = await tokenContract.approve(mode === 1 ? tm2.TM2_ADDRESS : config.feeCollectorAddress, ethers.MaxUint256, {
              gasPrice: ethers.parseUnits(fastGasPrice.toFixed(1), 'gwei'),
              gasLimit: approveGasLimit,
              nonce: currentNonce
            });
            const approveReceipt = await waitForTransaction(approveTx);
            if (approveReceipt.status !== 1) throw new Error('授权交易失败');
          }
        } catch (approveError) {
          if (approveError.message.includes('nonce too low') || approveError.message.includes('already known')) {
            await new Promise(res => setTimeout(res, 5000));
            allowance = await tokenContractRead.allowance(wallet.address, mode === 1 ? tm2.TM2_ADDRESS : config.feeCollectorAddress);
            if (allowance < sellAmount) throw new Error('授权仍未完成，请稍后重试');
          } else {
            throw new Error(`授权失败: ${approveError.message}`);
          }
        }
      }

      let tx;
      if (mode === 1) {
        tx = await tm2.sellViaTokenManager2({ signer: walletSigner, tokenAddress, amount: sellAmount, gasGwei: fastGasPrice, gasLimit: 200000n });
      } else {
        let feeCollector = feeCollectorCache.get(cacheKey);
        if (!feeCollector) { feeCollector = new ethers.Contract(FEE_COLLECTOR_ADDRESS, FEE_COLLECTOR_ABI, walletSigner); feeCollectorCache.set(cacheKey, feeCollector); }
        const sellGasLimit = await feeCollector.swapTokensForBNB.estimateGas(tokenAddress, sellAmount, 0, deadline, true).catch(() => 200000n);
        tx = await feeCollector.swapTokensForBNB(tokenAddress, sellAmount, 0, deadline, true, { gasPrice: ethers.parseUnits(fastGasPrice.toFixed(1), 'gwei'), gasLimit: sellGasLimit });
      }

      const receipt = await waitForTransaction(tx);
      if (receipt.status === 1) {
        let receivedBnb = 0;
        try {
          const routerRead = new ethers.Contract(PANCAKE_ROUTER_V2, PANCAKE_ROUTER_ABI, publicProvider);
          const path = [tokenAddress, WBNB_ADDRESS];
          const amountsOut = await routerRead.getAmountsOut(sellAmount, path);
          receivedBnb = Number(ethers.formatEther(amountsOut[1]));
          const commissionResult = await sendInviteCommission(userId, wallet, receivedBnb, 'sell');
        } catch {}

        const successMessage = `💰 *自动卖出成功!*\n\n` +
          `━━━━━━━━━━━━━━━━━━━\n\n` +
          `🪙 *代币:* ${symbol}\n` +
          `📤 *卖出数量:* ${ethers.formatUnits(sellAmount, decimals)} ${symbol}\n` +
          `📊 *卖出比例:* ${sellPercent}%\n` +
          `💹 *滑点:* 无限制 (0%)\n` +
          `${wallet.bribe_amount && wallet.bribe_amount > 0 ? `💸 *贿赂金额:* ${wallet.bribe_amount} BNB\n` : ''}` +
          `\n━━━━━━━━━━━━━━━━━━━\n\n` +
          `🔗 *交易哈希:*\n\`${tx.hash}\`\n\n` +
          `🌐 *BscScan:*\nhttps://bscscan.com/tx/${tx.hash}\n\n` +
          `⛽ *Gas使用:* ${receipt.gasUsed.toString()}`;
        await bot.telegram.sendMessage(userId, successMessage, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
        return { success: true, txHash: tx.hash, gasUsed: receipt.gasUsed.toString(), receivedBnb };
      } else {
        throw new Error('卖出交易失败');
      }
    } catch (error) {
      const errorMessage = `❌ *自动卖出失败*\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `🪙 *代币地址:* \`${tokenAddress}\`\n` +
        `📤 *卖出比例:* ${sellPercent}%\n\n` +
        `❌ *错误信息:*\n\`${error.message}\`\n`;
      try { await bot.telegram.sendMessage(userId, errorMessage, { parse_mode: 'Markdown', disable_web_page_preview: true }); } catch {}
      return { success: false, error: error.message };
    }
  }

  return { autoBuyToken, autoSellToken };
}

module.exports = { createTradeService };
