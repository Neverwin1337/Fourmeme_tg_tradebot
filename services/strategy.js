const knex = require('../db/knex');
const db = require('../database');
const { toNumberSafe } = require('../utils/helpers');
const sweepLogger = require('../utils/sweepLogger');

async function checkTokenAgainstStrategy(userId, tokenInfo, metaInfo) {
  try {
    const wallets = await db.getUserWallets(knex, userId);
    if (wallets.length === 0) {
      return { match: false, reason: '用户没有钱包' };
    }
    const activeWallets = wallets.filter(w => w.is_active);
    const results = [];
    for (const wallet of activeWallets) {
      const result = await checkSingleWalletStrategy(wallet, tokenInfo, metaInfo);
      results.push({ walletId: wallet.id, ...result });
    }
    const anyMatch = results.some(r => r.match);
    const allReasons = results.map(r => r.reason).join('; ');
    return { match: anyMatch, reason: anyMatch ? '符合策略条件' : allReasons, results };
  } catch (error) {
    console.error('检查策略条件失败:', error);
    return { match: false, reason: '检查失败' };
  }
}

async function checkSingleWalletStrategy(wallet, tokenInfo, metaInfo) {
  try {
    const conditions = [];
    const reasons = [];
    if (wallet.filter_social) {
      const hasSocial = metaInfo && metaInfo.hasSocialMedia && (metaInfo.hasSocialMedia.hasX || metaInfo.hasSocialMedia.hasTelegram || metaInfo.hasSocialMedia.hasWebsite);
      if (!hasSocial) { conditions.push(false); reasons.push('缺少社交媒体链接'); } else { conditions.push(true); }
    }
    if (wallet.filter_min_holders > 0) {
      const holders = toNumberSafe(tokenInfo?.holders, -1);
      // 如果 holders 数据无效（-1），则不通过过滤
      if (holders < 0) {
        conditions.push(false);
        reasons.push('持币人数数据无效');
      } else if (holders < wallet.filter_min_holders) {
        conditions.push(false);
        reasons.push(`持币人数不足 (${holders} < ${wallet.filter_min_holders})`);
      } else {
        conditions.push(true);
      }
    }
    if (wallet.filter_top10_max < 100) {
      const top10Percent = parseFloat(tokenInfo?.top10HoldersPercentage || 0);
      if (top10Percent > wallet.filter_top10_max) { conditions.push(false); reasons.push(`Top10占比过高 (${top10Percent.toFixed(2)}% > ${wallet.filter_top10_max}%)`); } else { conditions.push(true); }
    }
    if (wallet.filter_binance_only) {
      const tokenAddress = tokenInfo?.tokenAddress || tokenInfo?.address || tokenInfo?.contractAddress || '';
      if (!tokenAddress) {
        console.warn('⚠️ 无法获取代币地址，跳过币安专属检查');
        conditions.push(true);
      } else {
        const isBinanceToken = tokenAddress.toLowerCase().startsWith('0x4444');
        if (isBinanceToken) {
          conditions.push(true);
        } else {
          conditions.push(false);
        }
      }
    }
    if (toNumberSafe(wallet.filter_max_launch_minutes, 0) > 0) {
      const createTime = toNumberSafe(metaInfo?.createTime, 0);
      if (createTime > 0) {
        const now = Date.now();
        const elapsedMinutes = (now - createTime) / (1000 * 60);
        if (elapsedMinutes > toNumberSafe(wallet.filter_max_launch_minutes, 0)) {
          conditions.push(false);
          reasons.push(`发射时间超过限制 (${elapsedMinutes.toFixed(1)}分钟 > ${wallet.filter_max_launch_minutes}分钟)`);
        } else {
          conditions.push(true);
        }
      } else {
        conditions.push(true);
      }
    }
    const allPassed = conditions.length === 0 || conditions.every(c => c === true);
    return { match: allPassed, reason: allPassed ? '符合所有策略条件' : reasons.join(', '), conditions, reasons };
  } catch (error) {
    console.error('检查单个钱包策略失败:', error);
    return { match: false, reason: '检查失败' };
  }
}

async function checkSingleWalletSweepStrategy(wallet, dynamicInfo, metaInfo) {
  try {
    const conditions = [];
    const reasons = [];
    if (wallet.sweep_filter_social) {
      const hasSocial = metaInfo && metaInfo.hasSocialMedia && (metaInfo.hasSocialMedia.hasX || metaInfo.hasSocialMedia.hasTelegram || metaInfo.hasSocialMedia.hasWebsite);
      if (!hasSocial) { conditions.push(false); reasons.push('缺少社交媒体链接'); } else { conditions.push(true); }
    }
    if (toNumberSafe(wallet.sweep_filter_min_holders, 0) > 0) {
      const holders = toNumberSafe(dynamicInfo?.holders, 0);
      if (holders < toNumberSafe(wallet.sweep_filter_min_holders, 0)) { conditions.push(false); reasons.push(`持币人数不足 (${holders} < ${wallet.sweep_filter_min_holders})`); } else { conditions.push(true); }
    }
    if (toNumberSafe(wallet.sweep_filter_top10_max, 100) < 100) {
      const top10Percent = toNumberSafe(dynamicInfo?.top10HoldersPercentage, 0);
      if (top10Percent > toNumberSafe(wallet.sweep_filter_top10_max, 100)) { conditions.push(false); reasons.push(`Top10占比过高 (${top10Percent.toFixed(2)}% > ${wallet.sweep_filter_top10_max}%)`); } else { conditions.push(true); }
    }
    if (toNumberSafe(wallet.sweep_filter_progress_min, 0) > 0) {
      const p = toNumberSafe(dynamicInfo?.progress, 0);
      if (p < toNumberSafe(wallet.sweep_filter_progress_min, 0)) { conditions.push(false); reasons.push(`进度不足 (${p.toFixed(2)}% < ${wallet.sweep_filter_progress_min}%)`); } else { conditions.push(true); }
    }
    if (toNumberSafe(wallet.sweep_filter_max_launch_minutes, 0) > 0) {
      let createTime = toNumberSafe(metaInfo?.createTime, 0);
      sweepLogger.log(`      [策略] 发射时间检查: 原始createTime=${createTime}, metaInfo.createTime=${metaInfo?.createTime}`);
      
      if (createTime > 0) {
        // 自动检测时间戳格式：如果是秒时间戳（10位数），转换为毫秒
        if (createTime < 10000000000) {
          sweepLogger.log(`      [策略] 检测到秒时间戳，转换为毫秒: ${createTime} -> ${createTime * 1000}`);
          createTime = createTime * 1000;
        }
        
        const now = Date.now();
        const elapsedMinutes = (now - createTime) / (1000 * 60);
        const createTimeStr = new Date(createTime).toLocaleString('zh-CN');
        sweepLogger.log(`      [策略] 计算时间差: now=${now}, createTime=${createTime} (${createTimeStr}), elapsed=${elapsedMinutes.toFixed(1)}分钟, limit=${wallet.sweep_filter_max_launch_minutes}分钟`);
        
        if (elapsedMinutes > toNumberSafe(wallet.sweep_filter_max_launch_minutes, 0)) {
          conditions.push(false);
          reasons.push(`发射时间超过限制 (${elapsedMinutes.toFixed(1)}分钟 > ${wallet.sweep_filter_max_launch_minutes}分钟)`);
        } else {
          conditions.push(true);
          reasons.push(`发射时间符合 (${elapsedMinutes.toFixed(1)}分钟 ≤ ${wallet.sweep_filter_max_launch_minutes}分钟)`);
        }
      } else {
        // 如果无法获取创建时间，为了安全起见，不通过
        sweepLogger.log(`      [策略] ⚠️ 无法获取createTime，拒绝购买`);
        conditions.push(false);
        reasons.push('无法获取代币创建时间');
      }
    }
    const allPassed = conditions.length === 0 || conditions.every(c => c === true);
    return { match: allPassed, reason: allPassed ? '符合扫链策略' : reasons.join(', '), conditions, reasons };
  } catch (e) {
    sweepLogger.error('检查扫链策略失败:', e.message || e);
    return { match: false, reason: '检查失败' };
  }
}

module.exports = {
  checkTokenAgainstStrategy,
  checkSingleWalletStrategy,
  checkSingleWalletSweepStrategy
};
