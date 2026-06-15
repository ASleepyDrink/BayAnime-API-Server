require('dotenv').config();

const fastify = require('fastify')({ logger: true });
const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || 'C:\\Media');
const DB_PATH = path.join(__dirname, 'cache.db');

fastify.register(require('@fastify/static'), {
  root: MEDIA_DIR,
  prefix: '/stream/',
  acceptRanges: true,
  decorateReply: false,
  index: false,
  list: true
});

const db = new sqlite3.Database(DB_PATH);

const dbQuery = {
  run: (sql, params = []) => new Promise((res, rej) => {
    db.run(sql, params, function(err) { err ? rej(err) : res(this); });
  }),
  get: (sql, params = []) => new Promise((res, rej) => {
    db.get(sql, params, (err, row) => { err ? rej(err) : res(row); });
  })
};

async function initDB() {
  db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');
    db.run(`
      CREATE TABLE IF NOT EXISTS system_cache (
        id TEXT PRIMARY KEY,
        tree_data TEXT,
        folders_count INTEGER,
        updated_at INTEGER
      )
    `);
  });
}

async function getDirectoryTree(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const filesAndFolders = [];

  for (const entry of entries) {
    const resPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      filesAndFolders.push({
        name: entry.name,
        type: 'directory',
        path: resPath,
        children: await getDirectoryTree(resPath)
      });
    } else {
      filesAndFolders.push({
        name: entry.name,
        type: 'file',
        path: resPath
      });
    }
  }
  return filesAndFolders;
}

function countDirectories(nodes) {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'directory') {
      count++;
      if (node.children && node.children.length > 0) {
        count += countDirectories(node.children);
      }
    }
  }
  return count;
}

async function scanAndSyncCache() {
  fastify.log.info('Running differential background disk sync...');
  try {
    const freshTree = await getDirectoryTree(MEDIA_DIR);
    const count = countDirectories(freshTree);

    await dbQuery.run(`
      INSERT INTO system_cache (id, tree_data, folders_count, updated_at)
      VALUES ('media_root', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tree_data = excluded.tree_data,
        folders_count = excluded.folders_count,
        updated_at = excluded.updated_at
    `, [JSON.stringify(freshTree), count, Date.now()]);

    fastify.log.info(`SQLite Cache successfully updated. Total folders: ${count}`);
  } catch (err) {
    fastify.log.error(`Background sync failed: ${err.message}`);
  }
}

function injectStreamUrls(nodes) {
  return nodes.map(node => {
    if (node.type === 'file') {
      const relativePath = path.relative(MEDIA_DIR, node.path);
      const cleanUrlPath = relativePath.replace(/\\/g, '/');

      return {
        ...node,
        stream_url: `http://127.0.0.1:3000/stream/${encodeURI(cleanUrlPath)}`
      };
    } else if (node.type === 'directory' && node.children) {
      return {
        ...node,
        children: injectStreamUrls(node.children)
      };
    }
    return node;
  });
}

fastify.get('/api/library', async (request, reply) => {
  try {
    const cachedData = await dbQuery.get("SELECT * FROM system_cache WHERE id = 'media_root'");

    if (!cachedData) {
      fastify.log.warn('Cache empty! Performing emergency cold filesystem read...');
      const freshTree = await getDirectoryTree(MEDIA_DIR);
      const count = countDirectories(freshTree);
      return {
        root: MEDIA_DIR,
        cached: false,
        folders_count: count,
        tree: injectStreamUrls(freshTree)
      };
    }

    const parsedTree = JSON.parse(cachedData.tree_data);

    return {
      root: MEDIA_DIR,
      cached: true,
      last_sync: new Date(cachedData.updated_at).toISOString(),
      folders_count: cachedData.folders_count,
      tree: injectStreamUrls(parsedTree)
    };
  } catch (err) {
    reply.status(500).send({ error: `Failed to read cache layer: ${err.message}` });
  }
});

fastify.post('/api/sync', async (request, reply) => {
  scanAndSyncCache();
  return { status: 'Sync triggered' };
});

const start = async () => {
  try {
    await initDB();
    await fastify.listen({ port: 3000, host: '127.0.0.1' });
    await scanAndSyncCache();
    setInterval(scanAndSyncCache, 60 * 1000);
    fastify.log.info(`Media API Server with Streaming Engine listening on http://127.0.0.1:3000`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
