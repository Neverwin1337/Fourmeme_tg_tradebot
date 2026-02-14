require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// 加载合约 ABI
function loadContractABI() {
  const artifactPath = path.join(__dirname, '..', 'artifacts', 'FeeCollector.json');
  
  if (fs.existsSync(artifactPath)) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    return artifact.abi;
  }
  
  // 如果没有编译文件，使用简化的 ABI
  return [
    "function swapBNBForTokens(address tokenOut, uint256 amountOutMin, uint256 deadline, bool supportFeeOnTransfer) external payable",
    "function swapTokensForBNB(address tokenIn, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bool supportFeeOnTransfer) external",
    "function swapTokensForTokens(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bool supportFeeOnTransfer) external",
    "function getAmountsOut(uint256 amountIn, address[] memory path) external view returns (uint256[] memory amounts)",
    "function calculateFee(uint256 amount) external view returns (uint256 feeAmount, uint256 netAmount)",
    "function setFeePercentage(uint256 newFeePercentage) external",
    "function setFeeRecipient(address newFeeRecipient) external",
    "function owner() external view returns (address)",
    "function feeRecipient() external view returns (address)",
    "function feePercentage() external view returns (uint256)",
    "function pancakeRouter() external view returns (address)",
    "event FeeCollected(address indexed user, uint256 feeAmount, address token)",
    "event SwapExecuted(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)"
  ];
}

// 加载部署信息
function loadDeploymentInfo() {
  const deploymentPath = path.join(__dirname, '..', 'deployment.json');
  
  if (!fs.existsSync(deploymentPath)) {
    throw new Error('未找到部署信息，请先部署合约');
  }
  
  return JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
}

/**
 * FeeCollector 合约交互类
 */
class FeeCollectorManager {
  constructor(contractAddress, provider, signer = null) {
    this.contractAddress = contractAddress;
    this.provider = provider;
    this.abi = loadContractABI();
    
    if (signer) {
      this.contract = new ethers.Contract(contractAddress, this.abi, signer);
      this.readOnlyContract = new ethers.Contract(contractAddress, this.abi, provider);
    } else {
      this.contract = new ethers.Contract(contractAddress, this.abi, provider);
      this.readOnlyContract = this.contract;
    }
  }

  /**
   * 创建实例（从部署信息）
   */
  static fromDeployment(provider, signer = null) {
    const deployment = loadDeploymentInfo();
    return new FeeCollectorManager(deployment.contractAddress, provider, signer);
  }

  /**
   * 用 BNB 购买代币
   */
  async swapBNBForTokens(tokenOut, bnbAmount, slippage = 1, supportFeeOnTransfer = true) {
    try {
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20分钟
      const amountOutMin = 0; // 可以根据预估价格和滑点计算
      
      const tx = await this.contract.swapBNBForTokens(
        tokenOut,
        amountOutMin,
        deadline,
        supportFeeOnTransfer,
        { value: ethers.parseEther(bnbAmount.toString()) }
      );
      
      console.log('交易已发送:', tx.hash);
      const receipt = await tx.wait();
      console.log('交易确认:', receipt.hash);
      
      return receipt;
    } catch (error) {
      console.error('购买代币失败:', error.message);
      throw error;
    }
  }

  /**
   * 卖出代币换 BNB
   */
  async swapTokensForBNB(tokenIn, amount, slippage = 1, supportFeeOnTransfer = true) {
    try {
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      const amountOutMin = 0; // 可以根据预估价格和滑点计算
      
      // 注意：调用此函数前需要先授权代币给合约
      const tx = await this.contract.swapTokensForBNB(
        tokenIn,
        amount,
        amountOutMin,
        deadline,
        supportFeeOnTransfer
      );
      
      console.log('交易已发送:', tx.hash);
      const receipt = await tx.wait();
      console.log('交易确认:', receipt.hash);
      
      return receipt;
    } catch (error) {
      console.error('卖出代币失败:', error.message);
      throw error;
    }
  }

  /**
   * 代币换代币
   */
  async swapTokensForTokens(tokenIn, tokenOut, amountIn, slippage = 1, supportFeeOnTransfer = true) {
    try {
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      const amountOutMin = 0;
      
      const tx = await this.contract.swapTokensForTokens(
        tokenIn,
        tokenOut,
        amountIn,
        amountOutMin,
        deadline,
        supportFeeOnTransfer
      );
      
      console.log('交易已发送:', tx.hash);
      const receipt = await tx.wait();
      console.log('交易确认:', receipt.hash);
      
      return receipt;
    } catch (error) {
      console.error('代币交换失败:', error.message);
      throw error;
    }
  }

  /**
   * 计算手续费
   */
  async calculateFee(amount) {
    try {
      const [feeAmount, netAmount] = await this.readOnlyContract.calculateFee(amount);
      return {
        feeAmount: feeAmount.toString(),
        netAmount: netAmount.toString(),
        feeAmountFormatted: ethers.formatEther(feeAmount),
        netAmountFormatted: ethers.formatEther(netAmount)
      };
    } catch (error) {
      console.error('计算手续费失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取合约信息
   */
  async getContractInfo() {
    try {
      const [owner, feeRecipient, feePercentage, pancakeRouter] = await Promise.all([
        this.readOnlyContract.owner(),
        this.readOnlyContract.feeRecipient(),
        this.readOnlyContract.feePercentage(),
        this.readOnlyContract.pancakeRouter()
      ]);

      return {
        contractAddress: this.contractAddress,
        owner,
        feeRecipient,
        feePercentage: feePercentage.toString(),
        feePercentageReadable: (Number(feePercentage) / 100).toFixed(2) + '%',
        pancakeRouter
      };
    } catch (error) {
      console.error('获取合约信息失败:', error.message);
      throw error;
    }
  }

  /**
   * 设置手续费比例（仅所有者）
   */
  async setFeePercentage(newPercentage) {
    try {
      const tx = await this.contract.setFeePercentage(newPercentage);
      console.log('交易已发送:', tx.hash);
      await tx.wait();
      console.log('手续费比例已更新为:', (newPercentage / 100).toFixed(2) + '%');
      return tx;
    } catch (error) {
      console.error('设置手续费失败:', error.message);
      throw error;
    }
  }

  /**
   * 设置手续费接收地址（仅所有者）
   */
  async setFeeRecipient(newRecipient) {
    try {
      const tx = await this.contract.setFeeRecipient(newRecipient);
      console.log('交易已发送:', tx.hash);
      await tx.wait();
      console.log('手续费接收地址已更新为:', newRecipient);
      return tx;
    } catch (error) {
      console.error('设置手续费接收地址失败:', error.message);
      throw error;
    }
  }

  /**
   * 监听事件
   */
  async listenToEvents(eventName, callback) {
    this.contract.on(eventName, callback);
    console.log(`正在监听事件: ${eventName}`);
  }

  /**
   * 停止监听事件
   */
  removeAllListeners(eventName = null) {
    if (eventName) {
      this.contract.removeAllListeners(eventName);
    } else {
      this.contract.removeAllListeners();
    }
  }
}

module.exports = {
  FeeCollectorManager,
  loadContractABI,
  loadDeploymentInfo
};
