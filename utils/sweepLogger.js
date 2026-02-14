const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'sweep.log');

// 确保日志文件存在
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, '');
}

// 写入日志到文件
function writeToFile(level, ...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
  
  const logEntry = `[${timestamp}] [${level}] ${message}\n`;
  
  try {
    fs.appendFileSync(LOG_FILE, logEntry, 'utf-8');
  } catch (error) {
    console.error('写入扫链日志文件失败:', error.message);
  }
}

// 创建扫链日志记录器
function createSweepLogger() {
  return {
    log: (...args) => {
      console.log(...args);
      writeToFile('INFO', ...args);
    },
    error: (...args) => {
      console.error(...args);
      writeToFile('ERROR', ...args);
    },
    warn: (...args) => {
      console.warn(...args);
      writeToFile('WARN', ...args);
    },
    info: (...args) => {
      console.log(...args);
      writeToFile('INFO', ...args);
    },
    debug: (...args) => {
      if (process.env.DEBUG) {
        console.debug(...args);
        writeToFile('DEBUG', ...args);
      }
    }
  };
}

module.exports = createSweepLogger();

