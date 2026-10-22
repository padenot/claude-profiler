// A pool of worker threads that summarize session files in parallel. Reading
// and parsing every transcript on disk is seconds of work on one thread, and
// the files are independent of each other.

const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { statSafe } = require('./session-util.js');

// Past this, starting more workers costs more than the parallelism buys back:
// the largest session is the critical path, and it is one task whatever the
// pool size.
const MAX_WORKERS = 8;

function createPool(size = Math.min(os.availableParallelism(), MAX_WORKERS)) {
  const idle = [];
  const queue = [];
  let started = 0;

  function spawn() {
    started++;
    const worker = new Worker(path.join(__dirname, 'session-worker.js'));
    worker.on('message', ({ result, error }) => {
      const { resolve, reject } = worker.task;
      worker.task = null;
      if (error) reject(new Error(error));
      else resolve(result);
      next(worker);
    });
    // A worker that dies takes its task with it; the next task gets a new one.
    worker.on('error', (error) => {
      if (idle.includes(worker)) idle.splice(idle.indexOf(worker), 1);
      worker.task?.reject(error);
      worker.task = null;
      started--;
      if (queue.length) spawn();
    });
    next(worker);
  }

  // A busy worker keeps the process alive, an idle one must not: an idle pool
  // is no reason for `--json` to keep running once it has answered.
  function next(worker) {
    const task = queue.shift();
    if (!task) {
      worker.unref();
      idle.push(worker);
      return;
    }
    worker.ref();
    worker.task = task;
    worker.postMessage({ name: task.name, args: task.args });
  }

  function run(name, args) {
    return new Promise((resolve, reject) => {
      queue.push({ name, args, resolve, reject });
      if (idle.length) next(idle.pop());
      else if (started < size) spawn();
    });
  }

  // One task per item, the biggest files first: the largest session alone can
  // take as long as hundreds of small ones, so it has to start early to not be
  // the one everything else waits for.
  function map(name, items, fileOf) {
    const sizes = new Map(items.map(item => [item, statSafe(fileOf(item))?.size || 0]));
    const results = new Map();
    const bySize = [...items].sort((a, b) => sizes.get(b) - sizes.get(a));
    return Promise.all(bySize.map(item =>
      run(name, [item]).then(result => results.set(item, result))
    )).then(() => items.map(item => results.get(item)));
  }

  return { run, map };
}

module.exports = { createPool };
