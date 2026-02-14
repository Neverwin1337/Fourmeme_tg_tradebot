const { toNumberSafe } = require('../utils/helpers');

// 简单内存缓存（默认 30 秒，可通过环境变量 TOKEN_CACHE_TTL_MS 调整）
const TOKEN_CACHE_TTL_MS = Number(process.env.TOKEN_CACHE_TTL_MS || 30000);
const dynamicCache = new Map(); // key: address -> { data, ts }
const metaCache = new Map();    // key: address -> { data, ts }

async function getTokenInfo(contractAddress) {
  try {
    const key = (contractAddress || '').toLowerCase();
    const now = Date.now();
    const cached = dynamicCache.get(key);
    
    // 如果缓存存在且未过期，返回完整版本
    if (cached && (now - cached.ts) < TOKEN_CACHE_TTL_MS) {
      // 从缓存中扩展完整数据
      return {
        price: cached.data.price,
        volume24h: cached.data.volume24h || 0,
        volume24hBuy: cached.data.volume24hBuy || 0,
        volume24hSell: cached.data.volume24hSell || 0,
        percentChange24h: cached.data.percentChange24h || 0,
        marketCap: cached.data.marketCap || 0,
        holders: cached.data.holders,
        liquidity: cached.data.liquidity || 0,
        top10HoldersPercentage: cached.data.top10HoldersPercentage,
        priceHigh24h: cached.data.priceHigh24h || 0,
        priceLow24h: cached.data.priceLow24h || 0,
        count24h: cached.data.count24h || 0,
        count24hBuy: cached.data.count24hBuy || 0,
        count24hSell: cached.data.count24hSell || 0,
        progress: cached.data.progress
      };
    }
    
    const url = `https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info?contractAddress=${contractAddress}&chainId=56`;
    const response = await fetch(url);
    const data = await response.json();
    if ((data && data.data) && (data.success === true || data.code === '000000')) {
      const result = {
        price: toNumberSafe(data.data.price, 0),
        volume24h: toNumberSafe(data.data.volume24h, 0),
        volume24hBuy: toNumberSafe(data.data.volume24hBuy, 0),
        volume24hSell: toNumberSafe(data.data.volume24hSell, 0),
        percentChange24h: toNumberSafe(data.data.percentChange24h, 0),
        marketCap: toNumberSafe(data.data.marketCap, 0),
        holders: toNumberSafe(data.data.holders, 0),
        liquidity: toNumberSafe(data.data.liquidity, 0),
        top10HoldersPercentage: toNumberSafe(data.data.top10HoldersPercentage, 0),
        priceHigh24h: toNumberSafe(data.data.priceHigh24h, 0),
        priceLow24h: toNumberSafe(data.data.priceLow24h, 0),
        count24h: toNumberSafe(data.data.count24h, 0),
        count24hBuy: toNumberSafe(data.data.count24hBuy, 0),
        count24hSell: toNumberSafe(data.data.count24hSell, 0),
        progress: toNumberSafe(data.data.progress, 0)
      };
      // 缓存数据
      dynamicCache.set(key, { data: result, ts: now });
      return result;
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function getTokenDynamicInfoV4(contractAddress) {
  try {
    const key = (contractAddress || '').toLowerCase();
    const now = Date.now();
    const cached = dynamicCache.get(key);
    if (cached && (now - cached.ts) < TOKEN_CACHE_TTL_MS) {
      return cached.data;
    }
    const url = `https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info?contractAddress=${contractAddress}&chainId=56`;
    const response = await fetch(url);
    const data = await response.json();
    if ((data && data.data) && (data.code === '000000' || data.success === true)) {
      const result = {
        holders: toNumberSafe(data.data.holders, 0),
        top10HoldersPercentage: toNumberSafe(data.data.top10HoldersPercentage, 0),
        progress: toNumberSafe(data.data.progress, 0),
        price: toNumberSafe(data.data.price, 0)
      };
      dynamicCache.set(key, { data: result, ts: now });
      return result;
    }
  } catch (e) {
  }
  return null;
}

async function getTokenMetaInfo(contractAddress) {
  try {
    const key = (contractAddress || '').toLowerCase();
    const now = Date.now();
    const cached = metaCache.get(key);
    if (cached && (now - cached.ts) < TOKEN_CACHE_TTL_MS) {
      return cached.data;
    }
    const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/dex/market/token/meta/info?contractAddress=${contractAddress}&chainId=56`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.success && data.data) {
      const links = data.data.links || [];
      const previewLink = data.data.previewLink || {};
      const hasSocialMedia = {
        hasX: links.some(link => link.label === 'x') || (previewLink.x && previewLink.x.length > 0),
        hasTelegram: links.some(link => link.label === 'tg') || (previewLink.tg && previewLink.tg.length > 0),
        hasWebsite: links.some(link => link.label === 'website') || (previewLink.website && previewLink.website.length > 0)
      };
      const result = {
        name: data.data.name,
        symbol: data.data.symbol,
        tokenId: data.data.tokenId,
        icon: data.data.icon,
        createTime: data.data.createTime,
        creatorAddress: data.data.creatorAddress,
        links,
        previewLink,
        hasSocialMedia,
        socialLinks: {
          x: previewLink.x || [],
          tg: previewLink.tg || [],
          website: previewLink.website || []
        }
      };
      metaCache.set(key, { data: result, ts: now });
      return result;
    }
    return null;
  } catch (error) {
    return null;
  }
}

module.exports = {
  getTokenInfo,
  getTokenDynamicInfoV4,
  getTokenMetaInfo
};
