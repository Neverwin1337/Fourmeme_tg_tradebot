const { ethers } = require('ethers');
const config = require('../config');

const localProvider = new ethers.JsonRpcProvider(config.rpc.local);
const publicProvider = new ethers.JsonRpcProvider(config.rpc.public);

module.exports = {
  localProvider,
  publicProvider
};
