// Addresses
const PANCAKE_ROUTER_V2 = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';

// ABIs
const PANCAKE_ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function WETH() external pure returns (address)'
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

const FEE_COLLECTOR_ABI = [
  'function swapBNBForTokens(address tokenOut, uint256 amountOutMin, uint256 deadline, bool supportFeeOnTransfer) external payable',
  'function swapTokensForBNB(address tokenIn, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bool supportFeeOnTransfer) external',
  'function swapTokensForTokens(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bool supportFeeOnTransfer) external',
  'function calculateFee(uint256 amount) external view returns (uint256 feeAmount, uint256 netAmount)',
  'function feePercentage() external view returns (uint256)'
];

module.exports = {
  PANCAKE_ROUTER_V2,
  WBNB_ADDRESS,
  USDT_ADDRESS,
  PANCAKE_ROUTER_ABI,
  ERC20_ABI,
  FEE_COLLECTOR_ABI
};
