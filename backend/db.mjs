import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AppError, clean, norm, integer, matchPart, compareBom } from './bom.mjs';

const columns = ['code', 'mpn', 'lcsc', 'value', 'footprint', 'manufacturer', 'category', 'location', 'condition', 'minStock', 'price', 'notes'];
const now = () => new Date().toISOString();
export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path, {timeout: 5000});
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS parts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        mpn TEXT NOT NULL, lcsc TEXT NOT NULL DEFAULT '', value TEXT NOT NULL DEFAULT '', footprint TEXT NOT NULL DEFAULT '',
        manufacturer TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '其他', location TEXT NOT NULL DEFAULT '',
        condition TEXT NOT NULL DEFAULT '全新', minStock INTEGER NOT NULL DEFAULT 0 CHECK(minStock>=0),
        price REAL NOT NULL DEFAULT 0 CHECK(price>=0), notes TEXT NOT NULL DEFAULT '', quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity>=0),
        archived INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT, partId INTEGER NOT NULL REFERENCES parts(id), delta INTEGER NOT NULL,
        previous INTEGER NOT NULL, balance INTEGER NOT NULL, type TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS boms (id TEXT PRIMARY KEY, name TEXT NOT NULL, boards INTEGER NOT NULL, sparePercent REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', lines TEXT NOT NULL, createdAt TEXT NOT NULL, issuedAt TEXT, issueResult TEXT);
      CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, scope TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('sequence','0');
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  once(key, scope, input, fn) {
    if (!key || typeof key !== 'string' || key.length > 100) throw new AppError('缺少有效操作编号，请刷新后重试');
    const fingerprint = JSON.stringify(input);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM operations WHERE key=?').get(key);
      if (old) {
        if (old.scope !== scope || old.fingerprint !== fingerprint) throw new AppError('操作编号重复但内容不同', 409);
        return JSON.parse(old.result);
      }
      const result = fn();
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(key, scope, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  parts(includeArchived = false) { return this.db.prepare(`SELECT * FROM parts ${includeArchived ? '' : 'WHERE archived=0'} ORDER BY id DESC`).all(); }
  part(id) { const p = this.db.prepare('SELECT * FROM parts WHERE id=?').get(Number(id)); if (!p) throw new AppError('元件不存在', 404); return p; }
  nextCode() {
    let n = Number(this.db.prepare("SELECT value FROM meta WHERE key='sequence'").get().value);
    let code;
    do { code = `IC-${String(++n).padStart(6, '0')}`; } while (this.db.prepare('SELECT id FROM parts WHERE code=?').get(code));
    this.db.prepare("UPDATE meta SET value=? WHERE key='sequence'").run(String(n));
    return code;
  }
  validatePart(input, old = {}) {
    const p = {...old};
    for (const key of columns) if (key in input) p[key] = clean(input[key]);
    p.mpn = p.mpn || p.lcsc || '';
    if (!p.mpn) throw new AppError('请填写型号或立创编号');
    p.code = norm(p.code) || this.nextCode();
    if (p.code.length > 80 || Object.values(p).some(v => typeof v === 'string' && v.length > 4000)) throw new AppError('编号或文本过长');
    p.lcsc = norm(p.lcsc); p.minStock = integer(p.minStock || 0, '最低库存');
    p.price = Number(p.price || 0);
    if (!Number.isFinite(p.price) || p.price < 0 || p.price > 1e9) throw new AppError('单价必须为非负数字');
    p.category ||= '其他'; p.condition ||= '全新';
    if (!['全新', '拆机可用', '待检测'].includes(p.condition)) throw new AppError('来源类型无效');
    return Object.fromEntries(columns.map(k => [k, p[k] ?? '']));
  }
  create(input) {
    const p = this.validatePart(input); const time = now();
    const values = columns.map(c => p[c]);
    const result = this.db.prepare(`INSERT INTO parts (${columns.join(',')},createdAt,updatedAt) VALUES (${columns.map(() => '?').join(',')},?,?)`).run(...values, time, time);
    const id = Number(result.lastInsertRowid);
    const qty = integer(input.quantity ?? 0, '初始数量');
    if (qty) this.move(id, qty, '入库', input.reference || '初始入库', input.notes || '');
    return this.part(id);
  }
  update(id, input) {
    return this.transaction(() => {
      const old = this.part(id);
      if (old.archived) throw new AppError('已归档元件不能编辑');
      if ('quantity' in input && Number(input.quantity) !== old.quantity) throw new AppError('请通过出入库或盘点调整数量');
      const p = this.validatePart(input, old);
      this.db.prepare(`UPDATE parts SET ${columns.map(c => `${c}=?`).join(',')},updatedAt=? WHERE id=?`).run(...columns.map(c => p[c]), now(), Number(id));
      return this.part(id);
    });
  }
  archive(id) { return this.transaction(() => { const p = this.part(id); if (p.quantity) throw new AppError('请先将库存清零再归档'); this.db.prepare('UPDATE parts SET archived=1,updatedAt=? WHERE id=?').run(now(), p.id); return {ok: true}; }); }
  move(id, delta, type, reference = '', notes = '') {
    const p = this.part(id);
    if (p.archived) throw new AppError('元件已归档');
    if (!Number.isSafeInteger(delta) || p.quantity + delta < 0 || p.quantity + delta > 1e9) throw new AppError(`「${p.code}」库存不足或数量越界`, 409);
    this.db.prepare('UPDATE parts SET quantity=?,updatedAt=? WHERE id=?').run(p.quantity + delta, now(), p.id);
    this.db.prepare('INSERT INTO movements (partId,delta,previous,balance,type,reference,notes,createdAt) VALUES (?,?,?,?,?,?,?,?)').run(p.id, delta, p.quantity, p.quantity + delta, type, clean(reference), clean(notes), now());
    return this.part(id);
  }
  movement(id, input) {
    return this.once(input.key, `move:${id}`, input, () => {
      const p = this.part(id);
      const qty = integer(input.quantity, '数量', input.type === '盘点' ? 0 : 1);
      if (!['入库', '出库', '盘点'].includes(input.type)) throw new AppError('出入库类型无效');
      const delta = input.type === '盘点' ? qty - p.quantity : input.type === '出库' ? -qty : qty;
      if (delta === 0) throw new AppError('盘点数量与现有库存相同');
      return this.move(id, delta, input.type, input.reference, input.notes);
    });
  }
  movements() { return this.db.prepare('SELECT m.*,p.code,p.mpn,p.footprint FROM movements m JOIN parts p ON p.id=m.partId ORDER BY m.id DESC').all(); }
  importStock(rows, key) {
    return this.once(key, 'import-stock', rows, () => {
      let created = 0, updated = 0;
      for (const row of rows) {
        const parts = this.parts();
        let matches = row.code ? parts.filter(p => norm(p.code) === norm(row.code)) : row.lcsc ? parts.filter(p => norm(p.lcsc) === norm(row.lcsc) && norm(p.footprint) === norm(row.footprint) && p.condition === (row.condition || '全新')) : parts.filter(p => norm(p.mpn) === norm(row.mpn) && norm(p.footprint) === norm(row.footprint) && p.condition === (row.condition || '全新'));
        if (matches.length > 1) throw new AppError(`第 ${row.index + 1} 行有多个库存候选，请补内部编号`);
        if (matches.length) {
          const p = matches[0];
          if (row.mpn && norm(p.mpn) !== norm(row.mpn) || row.footprint && norm(p.footprint) !== norm(row.footprint) || row.lcsc && p.lcsc && norm(p.lcsc) !== norm(row.lcsc)) throw new AppError(`第 ${row.index + 1} 行与已有编号的型号/封装/立创号冲突`);
          if (row.quantity) this.move(p.id, row.quantity, '入库', '表格批量入库', row.notes);
          updated++;
        } else { this.create({...row, quantity: row.quantity, reference: '表格批量入库'}); created++; }
      }
      return {created, updated};
    });
  }
  bom(id) {
    const b = this.db.prepare('SELECT * FROM boms WHERE id=?').get(id);
    if (!b) throw new AppError('BOM 不存在', 404);
    return {...b, lines: JSON.parse(b.lines), issueResult: b.issueResult ? JSON.parse(b.issueResult) : null};
  }
  boms() { return this.db.prepare('SELECT id,name,boards,sparePercent,status,createdAt,issuedAt FROM boms ORDER BY createdAt DESC').all(); }
  createBom(input, rows) {
    return this.transaction(() => {
      const id = randomUUID(), boards = integer(input.boards ?? 1, '板数', 1), sparePercent = this.spare(input.sparePercent ?? 0);
      const parts = this.parts().filter(p => p.condition !== '待检测');
      const lines = rows.map(row => ({...row, ...matchPart(row, parts)}));
      const b = {id, name: clean(input.name) || '未命名 BOM', boards, sparePercent, lines};
      compareBom(b, this.parts());
      this.db.prepare('INSERT INTO boms (id,name,boards,sparePercent,lines,createdAt) VALUES (?,?,?,?,?,?)').run(id, b.name, boards, sparePercent, JSON.stringify(lines), now());
      return this.compare(id);
    });
  }
  spare(value) { const n = Number(value); if (!Number.isFinite(n) || n < 0 || n > 100) throw new AppError('备料比例应为 0～100%'); return n; }
  compare(id) { return compareBom(this.bom(id), this.parts()); }
  updateBom(id, input) {
    return this.transaction(() => {
      const b = this.bom(id);
      if (b.status !== 'draft') throw new AppError('已领料 BOM 不可修改，请新建 BOM', 409);
      if (input.boards != null) b.boards = integer(input.boards, '板数', 1);
      if (input.sparePercent != null) b.sparePercent = this.spare(input.sparePercent);
      if (input.lineIndex != null) {
        const i = integer(input.lineIndex, '行号');
        if (!b.lines[i]) throw new AppError('BOM 行不存在');
        if ('partId' in input) {
          if (input.partId != null) { const p = this.part(input.partId); if (p.archived || p.condition === '待检测') throw new AppError('归档或待检测元件不可领料'); }
          b.lines[i].partId = input.partId == null ? null : Number(input.partId); b.lines[i].reason = '手动确认';
        }
        if ('excluded' in input) b.lines[i].excluded = Boolean(input.excluded);
      }
      compareBom(b, this.parts());
      this.db.prepare('UPDATE boms SET boards=?,sparePercent=?,lines=? WHERE id=?').run(b.boards, b.sparePercent, JSON.stringify(b.lines), id);
      return this.compare(id);
    });
  }
  issueBom(id, input) {
    return this.once(input.key, `issue:${id}`, input, () => {
      const b = this.bom(id);
      if (b.status !== 'draft') throw new AppError('此 BOM 已领料，禁止重复扣减', 409);
      const comparison = this.compare(id);
      if (!input.partial && comparison.lines.some(l => ['shortage','unmatched'].includes(l.status))) throw new AppError('库存不足或有未匹配行，先补齐或选择「仅领现有数量」', 409);
      const totals = new Map();
      for (const line of comparison.lines) if (line.part && line.allocated > 0) {
        if (line.part.condition === '待检测') throw new AppError('待检测元件不能领料');
        totals.set(line.partId, (totals.get(line.partId) || 0) + line.allocated);
      }
      if (!totals.size) throw new AppError('没有可以领用的库存');
      for (const [partId, quantity] of totals) this.move(partId, -quantity, 'BOM领料', b.name, `${b.boards} 块板；${input.partial ? '仅领现有' : '整单领料'}`);
      const result = {lines: comparison.lines, summary: comparison.summary, issuedAt: now(), partial: Boolean(input.partial)};
      this.db.prepare("UPDATE boms SET status='issued',issuedAt=?,issueResult=? WHERE id=?").run(result.issuedAt, JSON.stringify(result), id);
      return result;
    });
  }
  snapshot() { return {format: 'IC-Inventory', version: 1, exportedAt: now(), parts: this.parts(true), movements: this.db.prepare('SELECT * FROM movements ORDER BY id').all(), boms: this.db.prepare('SELECT * FROM boms').all(), meta: this.db.prepare('SELECT * FROM meta').all(), operations: this.db.prepare('SELECT * FROM operations').all()}; }
  restore(snapshot) {
    if (snapshot?.format !== 'IC-Inventory' || snapshot.version !== 1 || !Array.isArray(snapshot.parts) || !Array.isArray(snapshot.movements) || !Array.isArray(snapshot.boms) || !Array.isArray(snapshot.meta) || !Array.isArray(snapshot.operations)) throw new AppError('不是有效的 IC 元件管理备份');
    const write = store => {
      store.db.exec('DELETE FROM operations; DELETE FROM movements; DELETE FROM boms; DELETE FROM parts; DELETE FROM meta;');
      for (const table of ['parts', 'movements', 'boms', 'meta', 'operations']) for (const row of snapshot[table]) {
        const allowed = store.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        const keys = Object.keys(row);
        if (keys.some(k => !allowed.includes(k))) throw new AppError('备份存在未知字段');
        if (table === 'parts') { if (!clean(row.code) || !clean(row.mpn) || ![0,1].includes(row.archived)) throw new AppError('元件备份无效'); integer(row.id,'元件 ID',1); store.validatePart(row); integer(row.quantity, '备份库存'); }
        if (table === 'movements') { integer(row.previous,'原库存'); integer(row.balance,'结余'); if (!Number.isSafeInteger(row.delta) || row.previous + row.delta !== row.balance) throw new AppError('流水库存关系无效'); }
        if (table === 'meta' && row.key === 'sequence') integer(row.value,'编号序列');
        if (table === 'boms') {
          const lines = JSON.parse(row.lines);
          if (!Array.isArray(lines) || !lines.length || !['draft','issued'].includes(row.status)) throw new AppError('BOM 备份无效');
          integer(row.boards, '板数', 1); store.spare(row.sparePercent);
          for (const line of lines) { integer(line.quantity,'BOM 用量'); if (line.partId != null && !store.db.prepare('SELECT id FROM parts WHERE id=?').get(integer(line.partId,'BOM 元件 ID',1))) throw new AppError('BOM 关联元件缺失'); }
          if (row.status==='issued') { const result=JSON.parse(row.issueResult); if (!Array.isArray(result?.lines) || !result?.summary) throw new AppError('已领料 BOM 缺少领料快照'); }
        }
        store.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]));
      }
      if (!store.db.prepare("SELECT value FROM meta WHERE key='sequence'").get()) throw new AppError('备份缺少编号序列');
      if (store.db.prepare('PRAGMA foreign_key_check').all().length) throw new AppError('备份关联关系不完整');
    };
    const staging = new Store(':memory:');
    try { staging.transaction(() => write(staging)); } finally { staging.close(); }
    return this.transaction(() => { write(this); return {ok: true, parts: snapshot.parts.length}; });
  }
}
