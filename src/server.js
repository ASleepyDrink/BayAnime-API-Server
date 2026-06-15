require('dotenv').config();

const fastify = require('fastify')({ logger: true });
const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DRIVES_ARRAY = JSON.parse(
  process.env.DRIVES || '["C:\\Media"]'
);

const DRIVES = DRIVES_ARRAY.reduce((acc, drivePath, index) => {
  acc[`drive_${index}`] = path.resolve(drivePath);
  return acc;
}, {});

const DB_PATH = path.join(__dirname, 'cache.db');

for (const [driveId, resolvedPath] of Object.entries(DRIVES)) {
  fastify.register(require('@fastify/static'), {
    root: resolvedPath,
    prefix: `/stream/${driveId}/`,
    acceptRanges: true,
    decorateReply: false,
    index: false,
    list: true
  });
}

const db = new sqlite3.Database(DB_PATH);

const dbQuery = {
  run: (sql, params = []) => new Promise((res, rej) => {
    db.run(sql, params, function(err) { err ? rej(err) : res(this); });
  }),
  get: (sql, params = []) => new Promise((res, rej) => {
    db.get(sql, params, (err, row) => { err ? rej(err) : res(row); });
  }),
  all: (sql, params = []) => new Promise((res, rej) => {
    db.all(sql, params, (err, rows) => { err ? rej(err) : res(rows); });
  })
};

async function initDB() {
  db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');
    db.run(`
      CREATE TABLE IF NOT EXISTS system_cache (
        drive_id TEXT PRIMARY KEY,
        root_path TEXT,
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
  fastify.log.info('Running background multi-drive disk sync...');

  for (const [driveId, resolvedPath] of Object.entries(DRIVES)) {
    try {
      const freshTree = await getDirectoryTree(resolvedPath);
      const count = countDirectories(freshTree);

      await dbQuery.run(`
        INSERT INTO system_cache (drive_id, root_path, tree_data, folders_count, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(drive_id) DO UPDATE SET
          root_path = excluded.root_path,
          tree_data = excluded.tree_data,
          folders_count = excluded.folders_count,
          updated_at = excluded.updated_at
      `, [driveId, resolvedPath, JSON.stringify(freshTree), count, Date.now()]);

      fastify.log.info(`SQLite Cache updated for [${driveId}] -> ${resolvedPath}. Folders: ${count}`);
    } catch (err) {
      fastify.log.error(`Background sync failed for [${driveId}] (${resolvedPath}): ${err.message}`);
    }
  }
}

function injectStreamUrls(nodes, driveId, rootPath) {
  return nodes.map(node => {
    if (node.type === 'file') {
      const relativePath = path.relative(rootPath, node.path);
      const cleanUrlPath = relativePath.replace(/\\/g, '/');

      return {
        ...node,
        stream_url: `http://127.0.0.1:3000/stream/${driveId}/${encodeURI(cleanUrlPath)}`
      };
    } else if (node.type === 'directory' && node.children) {
      return {
        ...node,
        children: injectStreamUrls(node.children, driveId, rootPath)
      };
    }
    return node;
  });
}

fastify.get('/api/library', async (request, reply) => {
  try {
    const cachedRows = await dbQuery.all("SELECT * FROM system_cache");
    const responseLibrary = [];

    for (const [driveId, resolvedPath] of Object.entries(DRIVES)) {
      const cacheMatch = cachedRows.find(row => row.drive_id === driveId);

      if (!cacheMatch) {
        fastify.log.warn(`Cache empty for ${resolvedPath}! Cold filesystem read executed...`);
        const freshTree = await getDirectoryTree(resolvedPath);
        const count = countDirectories(freshTree);

        responseLibrary.push({
          id: driveId,
          root: resolvedPath,
          cached: false,
          folders_count: count,
          tree: injectStreamUrls(freshTree, driveId, resolvedPath)
        });
      } else {
        const parsedTree = JSON.parse(cacheMatch.tree_data);
        responseLibrary.push({
          id: driveId,
          root: cacheMatch.root_path,
          cached: true,
          last_sync: new Date(cacheMatch.updated_at).toISOString(),
          folders_count: cacheMatch.folders_count,
          tree: injectStreamUrls(parsedTree, driveId, cacheMatch.root_path)
        });
      }
    }

    return { drives: responseLibrary };
  } catch (err) {
    reply.status(500).send({ error: `Failed to read cache layer: ${err.message}` });
  }
});

fastify.post('/api/sync', async (request, reply) => {
  scanAndSyncCache();
  return { status: 'Multi-drive sync triggered' };
});

const start = async () => {
  try {
    await initDB();
    await fastify.listen({ port: 3000, host: '127.0.0.1' });
    await scanAndSyncCache();
    setInterval(scanAndSyncCache, 60 * 1000);
    fastify.log.info(`Media API Server running with array configurations on http://127.0.0.1:3000`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
