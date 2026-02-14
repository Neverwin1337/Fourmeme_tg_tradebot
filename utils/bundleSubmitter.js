const { ethers } = require('ethers');
const https = require('https');

/**
 * Bundle 提交器
 * 支持 BlockRazor、48Club 和 NodeReal 三个服务
 * 用于提交包含原交易和贿赂交易的 bundle
 */
class BundleSubmitter {
  constructor() {
    // 多个 Bundle 服务配置
    this.services = [
      {
        name: 'BlockRazor',
        rpcUrl: 'https://virginia.builder.blockrazor.io',
        bribeRecipient: '0x1266C6bE60392A8Ff346E8d5ECCd3E69dD9c5F20'
      },
      {
        name: '48Club',
        rpcUrl: 'https://puissant-builder.48.club/',
        bribeRecipient: '0x4848489f0b2BEdd788c696e2D79b6b69D7484848'
      },
      {
        name: 'NodeReal',
        rpcUrl: 'https://bsc-mainnet-builder.nodereal.io',
        bribeRecipient: '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE'
      }
    ];
  }

  /**
   * 创建贿赂交易
   * @param {ethers.Wallet} wallet - 钱包实例
   * @param {string} bribeAmount - 贿赂金额 (BNB)
   * @param {number} mainTxNonce - 主交易的 nonce
   * @param {Object} gasPrice - Gas 价格
   * @param {string} bribeRecipient - 贿赂接收地址
   * @returns {Object} 签名后的贿赂交易
   */
  async createBribeTransaction(wallet, bribeAmount, mainTxNonce, gasPrice, bribeRecipient) {
    try {
      // 贿赂交易的 nonce 应该是主交易 nonce + 1
      const bribeNonce = mainTxNonce + 1;
      
      const bribeTx = {
        to: bribeRecipient,
        value: ethers.parseEther(bribeAmount.toString()),
        nonce: bribeNonce,
        gasLimit: 22000,
        gasPrice: gasPrice,
        chainId: 56
      };

      // 签名贿赂交易
      const signedBribeTx = await wallet.signTransaction(bribeTx);
      
      console.log(`💰 贿赂交易已签名:`);
      console.log(`  - 接收地址: ${bribeRecipient}`);
      console.log(`  - 贿赂金额: ${bribeAmount} BNB`);
      console.log(`  - Nonce: ${bribeNonce} (主交易Nonce + 1)`);
      
      return signedBribeTx;
    } catch (error) {
      console.error('创建贿赂交易失败:', error);
      throw error;
    }
  }

  /**
   * 提交 Bundle 到指定服务
   * @param {string} mainTxSigned - 主交易的签名数据
   * @param {string} bribeTxSigned - 贿赂交易的签名数据
   * @param {string} rpcUrl - RPC URL
   * @param {string} serviceName - 服务名称
   * @returns {Object} Bundle 提交结果
   */
  async submitBundleToService(mainTxSigned, bribeTxSigned, rpcUrl, serviceName, currentBlockNumber) {
    return new Promise((resolve, reject) => {
      const now = Math.floor(Date.now() / 1000);
      
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendBundle',
        params: [{
          txs: [mainTxSigned, bribeTxSigned],
          minTimestamp: now,
          maxTimestamp: now + 1, // 只在最近2秒内有效
          maxBlockNumber: currentBlockNumber + 2 // 最多等2个区块
        }]
      });

      const urlObj = new URL(rpcUrl);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };


      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            
            if (response.error) {
              console.error(`❌ ${serviceName} 提交失败:`, response.error);
              reject(new Error(`${serviceName} 提交失败: ${response.error.message}`));
            } else {
              console.log(`✅ ${serviceName} 提交成功!`);
              console.log('  - Bundle Hash:', response.result);
              resolve({
                success: true,
                serviceName: serviceName,
                bundleHash: response.result,
                response: response
              });
            }
          } catch (parseError) {
            console.error('解析响应失败:', parseError);
            reject(parseError);
          }
        });
      });

      req.on('error', (error) => {
        console.error(`❌ ${serviceName} HTTP 请求失败:`, error);
        reject(error);
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * 同时向多个服务提交 Bundle
   * @param {ethers.Wallet} wallet - 钱包实例
   * @param {string} mainTxSigned - 主交易签名
   * @param {Object} mainTx - 主交易对象（包含nonce和gasPrice）
   * @param {string} bribeAmount - 贿赂金额
   * @param {ethers.Provider} provider - Provider 实例
   * @returns {Object} 提交结果
   */
  async submitBundleToAll(wallet, mainTxSigned, mainTx, bribeAmount, provider) {
    
    
    // 获取当前区块号
    const currentBlockNumber = await provider.getBlockNumber();
    
    // 为每个服务创建对应的贿赂交易并提交
    const promises = this.services.map(async (service) => {
      try {
        // 为每个服务创建专属的贿赂交易
        const signedBribeTx = await this.createBribeTransaction(
          wallet,
          bribeAmount,
          mainTx.nonce,
          mainTx.gasPrice,
          service.bribeRecipient
        );
        
        // 提交到该服务
        return await this.submitBundleToService(
          mainTxSigned,
          signedBribeTx,
          service.rpcUrl,
          service.name,
          currentBlockNumber
        );
      } catch (error) {
        return {
          success: false,
          serviceName: service.name,
          error: error.message
        };
      }
    });
    
    const results = await Promise.all(promises);
    
    // 统计成功和失败
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    console.log(`\n📊 提交结果统计:`);
    console.log(`  ✅ 成功: ${successful.length}/${this.services.length}`);
    console.log(`  ❌ 失败: ${failed.length}/${this.services.length}`);
    
    if (successful.length > 0) {
      console.log(`\n✅ 成功的服务:`);
      successful.forEach(r => {
        console.log(`  - ${r.serviceName}: ${r.bundleHash}`);
      });
    }
    
    if (failed.length > 0) {
      console.log(`\n❌ 失败的服务:`);
      failed.forEach(r => {
        console.log(`  - ${r.serviceName}: ${r.error}`);
      });
    }
    
    // 只要有一个成功就返回成功
    if (successful.length > 0) {
      return {
        success: true,
        results: results,
        successCount: successful.length,
        bundleHash: successful[0].bundleHash // 返回第一个成功的 bundle hash
      };
    } else {
      throw new Error(`所有 Bundle 服务都提交失败`);
    }
  }

  /**
   * 完整的 Bundle 提交流程
   * @param {ethers.Wallet} wallet - 钱包实例
   * @param {Object} mainTx - 主交易对象
   * @param {string} bribeAmount - 贿赂金额
   * @param {ethers.Provider} provider - Provider 实例
   * @returns {Object} 提交结果
   */
  async submitWithBribe(wallet, mainTx, bribeAmount, provider) {
    try {

      const signedMainTx = await wallet.signTransaction(mainTx);

      const [bundleResult, normalTxResult] = await Promise.allSettled([
        this.submitBundleToAll(wallet, signedMainTx, mainTx, bribeAmount, provider),
        (async () => {
          try {
            
            const normalTx = await provider.broadcastTransaction(signedMainTx);

            return {
              success: true,
              hash: normalTx.hash,
              tx: normalTx
            };
          } catch (error) {

            return {
              success: false,
              error: error.message
            };
          }
        })()
      ]);

      // 处理结果
      const bundleSuccess = bundleResult.status === 'fulfilled' && bundleResult.value;
      const normalTxSuccess = normalTxResult.status === 'fulfilled' && normalTxResult.value?.success;
      
      console.log('\n📊 提交结果:');
      console.log(`  Bundle: ${bundleSuccess ? '✅ 成功' : '❌ 失败'}`);
      console.log(`  普通交易: ${normalTxSuccess ? '✅ 成功' : '❌ 失败'}`);

      // 只要有一个成功就算成功
      if (bundleSuccess || normalTxSuccess) {
        return {
          success: true,
          bundleHash: bundleSuccess ? bundleResult.value.bundleHash : null,
          successCount: bundleSuccess ? bundleResult.value.successCount : 0,
          bundleResults: bundleSuccess ? bundleResult.value.results : [],
          normalTxHash: normalTxSuccess ? normalTxResult.value.hash : null,
          mainTx: signedMainTx
        };
      } else {
        throw new Error('Bundle 和普通交易都失败了');
      }

    } catch (error) {
      console.error('Bundle 提交流程失败:', error);
      throw error;
    }
  }


}

module.exports = BundleSubmitter;
