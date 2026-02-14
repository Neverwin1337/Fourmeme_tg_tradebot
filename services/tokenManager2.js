const { ethers } = require('ethers');
const config = require('../config');

const TM2_ADDRESS = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';

const TM2_ABI = [
  'function buyTokenAMAP(address token, uint256 funds, uint256 minAmount) payable',
  'function sellToken(address token, uint256 amount)'
];

const TOKEN_MODE_ABI = [
  'function _mode() view returns (uint256)'
];

const publicProvider = new ethers.JsonRpcProvider(config.rpc.public);

function getTM2Contract(signer) {
  return new ethers.Contract(TM2_ADDRESS, TM2_ABI, signer);
}

async function getTokenMode(tokenAddress) {
  const c = new ethers.Contract(tokenAddress, TOKEN_MODE_ABI, publicProvider);
  const m = await c._mode();
  return Number(m || 0);
}

async function buyViaTokenManager2({ signer, tokenAddress, fundsWei, minAmount = 0n, gasGwei, gasLimit = 200000n, nonce }) {
  const tm2 = getTM2Contract(signer);
  const tx = await tm2.buyTokenAMAP(tokenAddress, fundsWei, minAmount, {
    value: fundsWei,
    gasPrice: ethers.parseUnits(Number(gasGwei).toFixed(1), 'gwei'),
    gasLimit,
    nonce
  });
  return tx;
}

async function sellViaTokenManager2({ signer, tokenAddress, amount, gasGwei, gasLimit = 200000n, nonce }) {
  const tm2 = getTM2Contract(signer);


// 将最后9位设置为0
  const divisor = 1000000000n; // 10^9
  amount = (amount / divisor) * divisor;
  const tx = await tm2.sellToken(tokenAddress, amount, {
    gasPrice: ethers.parseUnits(Number(gasGwei).toFixed(1), 'gwei'),
    gasLimit,
    nonce
  });
  return tx;
}

module.exports = {
  TM2_ADDRESS,
  getTM2Contract,
  getTokenMode,
  buyViaTokenManager2,
  sellViaTokenManager2
};
