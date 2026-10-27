// Tiny repository layer: MongoDB when MONGO_URI is set, otherwise a JSON file store.
// Both expose the same async API per collection:
//   insert(doc) find(filter, {sort, limit}) findOne(filter) update(id, patch) remove(id) count(filter)
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.resolve(process.env.DATA_DIR || path.resolve(here, '../../data'), 'db.json');

const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([k, v]) => doc[k] === v);

const sortDocs = (docs, sort) => {
  if (!sort) return docs;
  const [[key, dir]] = Object.entries(sort);
  return [...docs].sort((a, b) => (a[key] > b[key] ? dir : a[key] < b[key] ? -dir : 0));
};

class FileStore {
  constructor() {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    this.data = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : {};
    this.timer = null;
  }
  persist() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
  // Write to a temp file then rename, so a crash mid-write never leaves a truncated db.json.
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, DATA_FILE);
  }
  async close() {
    this.flush();
  }
  collection(name) {
    const store = this;
    const rows = () => (store.data[name] ||= []);
    return {
      async insert(doc) {
        const row = { _id: crypto.randomUUID(), createdAt: Date.now(), ...doc };
        rows().push(row);
        store.persist();
        return row;
      },
      async find(filter = {}, { sort, limit } = {}) {
        let out = sortDocs(rows().filter((d) => matches(d, filter)), sort);
        if (limit) out = out.slice(0, limit);
        return out;
      },
      async findOne(filter = {}) {
        return rows().find((d) => matches(d, filter)) || null;
      },
      async update(id, patch) {
        const row = rows().find((d) => d._id === id);
        if (!row) return null;
        Object.assign(row, patch, { updatedAt: Date.now() });
        store.persist();
        return row;
      },
      async remove(id) {
        const list = rows();
        const i = list.findIndex((d) => d._id === id);
        if (i >= 0) list.splice(i, 1);
        store.persist();
        return i >= 0;
      },
      async count(filter = {}) {
        return rows().filter((d) => matches(d, filter)).length;
      },
    };
  }
}

// Indexes for the lookups the app makes on every request; collections not listed get a userId index.
const INDEXES = {
  users: [[{ email: 1 }, { unique: true }]],
  apiKeys: [[{ hash: 1 }, { unique: true }], [{ userId: 1 }]],
  payments: [[{ providerRef: 1 }], [{ userId: 1, time: -1 }]],
  usage: [[{ userId: 1, day: 1 }]],
  notifications: [[{ userId: 1, read: 1 }], [{ userId: 1, time: -1 }]],
  audit: [[{ userId: 1, time: -1 }]],
  trades: [[{ userId: 1 }], [{ botId: 1 }]],
  logs: [[{ userId: 1 }], [{ botId: 1 }], [{ level: 1 }]],
  signals: [[{ userId: 1 }], [{ outcome: 1 }]],
  settings: [[{ kind: 1, userId: 1 }]],
  copyLinks: [[{ followerId: 1 }], [{ leaderBotId: 1 }]],
  copyPositions: [[{ followerId: 1 }]],
  listings: [[{ authorId: 1 }]],
  optionPositions: [[{ userId: 1, status: 1 }], [{ botId: 1 }]],
};

class MongoStore {
  constructor() {
    this.models = {};
  }
  async close() {
    await mongoose.disconnect();
  }
  model(name) {
    if (!this.models[name]) {
      const schema = new mongoose.Schema(
        { _id: { type: String, default: () => crypto.randomUUID() }, createdAt: { type: Number, default: Date.now } },
        { strict: false, versionKey: false },
      );
      for (const [fields, opts] of INDEXES[name] || [[{ userId: 1 }]]) schema.index(fields, opts);
      this.models[name] = mongoose.model(name, schema, name);
    }
    return this.models[name];
  }
  collection(name) {
    const M = () => this.model(name);
    return {
      async insert(doc) {
        return (await M().create(doc)).toObject();
      },
      async find(filter = {}, { sort, limit } = {}) {
        let q = M().find(filter).lean();
        if (sort) q = q.sort(sort);
        if (limit) q = q.limit(limit);
        return q;
      },
      async findOne(filter = {}) {
        return M().findOne(filter).lean();
      },
      async update(id, patch) {
        return M().findByIdAndUpdate(id, { ...patch, updatedAt: Date.now() }, { new: true }).lean();
      },
      async remove(id) {
        return Boolean(await M().findByIdAndDelete(id));
      },
      async count(filter = {}) {
        return M().countDocuments(filter);
      },
    };
  }
}

let store;
export let dbKind = 'file';

export async function initDb() {
  if (config.mongoUri) {
    try {
      await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
      store = new MongoStore();
      dbKind = 'mongodb';
      console.log('[db] connected to MongoDB');
      return;
    } catch (err) {
      // In production a silent fallback would split data between two stores, so fail and let the supervisor retry.
      if (config.isProd) throw new Error(`[db] MongoDB unavailable: ${err.message}`);
      console.warn(`[db] MongoDB unavailable (${err.message}); falling back to JSON file store`);
    }
  }
  store = new FileStore();
  console.log(`[db] using JSON file store at ${DATA_FILE}`);
}

export const closeDb = () => store?.close();
export const dbReady = () => (dbKind === 'mongodb' ? mongoose.connection.readyState === 1 : Boolean(store));

export const db = {
  get bots() { return store.collection('bots'); },
  get trades() { return store.collection('trades'); },
  get signals() { return store.collection('signals'); },
  get logs() { return store.collection('logs'); },
  get wallet() { return store.collection('wallet'); },
  get backtests() { return store.collection('backtests'); },
  get settings() { return store.collection('settings'); },
  get journal() { return store.collection('journal'); },
  get models() { return store.collection('models'); },
  get strategyStats() { return store.collection('strategyStats'); },
  get equity() { return store.collection('equity'); },
  get users() { return store.collection('users'); },
  get apiConnections() { return store.collection('apiConnections'); },
  get apiKeys() { return store.collection('apiKeys'); },
  get audit() { return store.collection('audit'); },
  get notifications() { return store.collection('notifications'); },
  get usage() { return store.collection('usage'); },
  get payments() { return store.collection('payments'); },
  get customStrategies() { return store.collection('customStrategies'); },
  get listings() { return store.collection('listings'); },
  get copyLinks() { return store.collection('copyLinks'); },
  get copyPositions() { return store.collection('copyPositions'); },
  get optionPositions() { return store.collection('optionPositions'); },
  get optionBots() { return store.collection('optionBots'); },
};
