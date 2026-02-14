class EventQueue {
  constructor(maxConcurrent = 10, maxQueueSize = 10000) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
    this.processed = 0;
    this.failed = 0;
    this.maxQueueSize = maxQueueSize;
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.maxQueueSize) {
        return reject(new Error('Event queue is full'));
      }
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.running++;

    try {
      const result = await item.fn();
      this.processed++;
      item.resolve(result);
    } catch (error) {
      this.failed++;
      item.reject(error);
    } finally {
      this.running--;
      this.process();
    }
  }

  getStats() {
    return {
      running: this.running,
      queued: this.queue.length,
      processed: this.processed,
      failed: this.failed
    };
  }
}

module.exports = { EventQueue };
