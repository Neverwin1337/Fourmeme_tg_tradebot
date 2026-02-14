async function waitForTransaction(tx, maxRetries = 5, initialDelay = 2000) {
  let lastError = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('交易等待超时')), 30000))
      ]);
      return receipt;
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || error.toString();
      if (
        errorMsg.includes('indexing is in progress') ||
        errorMsg.includes('transaction not found') ||
        error.code === 'UNKNOWN_ERROR'
      ) {
        const delay = initialDelay * Math.pow(1.5, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('交易等待失败');
}

module.exports = { waitForTransaction };
