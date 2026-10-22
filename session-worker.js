// The worker side of worker-pool.js: one session file in, one picker row out.

const { parentPort } = require('worker_threads');

const tasks = {
  claude: entry => require('./claude-backend.js')
    .sessionRow(entry, require('./index.js').summaryDeps),
  codex: file => require('./codex-backend.js').summaryOrNull(file),
  dsh: file => require('./dsh-backend.js').summaryOrNull(file)
};

parentPort.on('message', ({ name, args }) => {
  try {
    parentPort.postMessage({ result: tasks[name](...args) });
  } catch (error) {
    parentPort.postMessage({ error: error.stack });
  }
});
