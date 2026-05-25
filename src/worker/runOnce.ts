import { runOnce } from '../engine/executor.js';
import { closeDb } from '../db/client.js';

runOnce()
  .then(async (r) => {
    console.log(JSON.stringify(r, null, 2));
    await closeDb();
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
