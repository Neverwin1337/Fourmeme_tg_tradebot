const { ethers } = require('ethers');
const config = require('../config');

const PANCAKE_ROUTER_V2 = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';

const provider = new ethers.JsonRpcProvider(config.rpc.public);

const PANCAKE_ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)'
];

async function getTokenUsdPriceByRouter(tokenAddress) {
  try {
    const router = new ethers.Contract(PANCAKE_ROUTER_V2, PANCAKE_ROUTER_ABI, provider);

    if (tokenAddress.toLowerCase() === WBNB_ADDRESS.toLowerCase()) {
      const out = await router.getAmountsOut(ethers.parseEther('1'), [WBNB_ADDRESS, USDT_ADDRESS]);
      return Number(ethers.formatUnits(out[1], 18));
    }

    const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const decimals = await erc20.decimals().catch(() => 18);
    const amountIn = ethers.parseUnits('1', decimals);

    const path = [tokenAddress, WBNB_ADDRESS, USDT_ADDRESS];
    const out = await router.getAmountsOut(amountIn, path);
    return Number(ethers.formatUnits(out[out.length - 1], 18));
  } catch (e) {
    return 0;
  }
}

module.exports = {
  getTokenUsdPriceByRouter
};
