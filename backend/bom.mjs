import XLSX from 'xlsx';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const clean = value => String(value ?? '').trim();
export const norm = value => clean(value).normalize('NFKC').replace(/\s+/g, '').toUpperCase();
export function integer(value, label, min = 0) {
  const n = Number(value);
  if (value === '' || value == null || !Number.isSafeInteger(n) || n < min || n > 1e9) throw new AppError(`${label}必须为${min ? '正' : '非负'}整数（不超过十亿）`);
  return n;
}
export const fields = {
  code: ['内部编号', '库存编号', '元件编号', 'code', 'sku'],
  mpn: ['制造商料号', '制造商型号', 'Manufacturer Part', 'Manufacturer Part Number', 'MPN', '型号', 'Name', '名称', 'Comment'],
  lcsc: ['Supplier Part', 'Supplier Part Number', 'LCSC Part #', 'LCSC Part Number', 'LCSC', '立创编号', '供应商编号', '供应商料号', '商品编号', '器件编号', '嘉立创编号'],
  footprint: ['Footprint', 'Package', '封装'],
  quantity: ['Quantity', 'Qty', '数量', '用量', '库存数量', '采购数量'],
  designators: ['Designator', 'Designators', 'Reference', '位号'],
  value: ['Value', '参数', '规格', '值', 'Name', '名称', 'Comment'],
  manufacturer: ['Manufacturer', '制造商', '厂家'],
  category: ['Category', '分类', '类别'],
  location: ['Location', '位置', '库位', '存放位置'],
  minStock: ['Min Stock', '最低库存', '预警数量'],
  price: ['Price', '单价', '采购单价'],
  notes: ['Notes', '备注', '描述'],
  condition: ['Condition', '状态', '来源类型'],
  dnp: ['DNP', '不装', '是否不装', 'BOM Include', '加入BOM']
};
export function guessMapping(columns) {
  return Object.fromEntries(Object.entries(fields).map(([key, aliases]) => [key, aliases.map(a => columns.find(c => norm(a) === norm(c))).find(Boolean) || '']));
}
export function parseTable(input) {
  let data;
  if (input.text != null) data = Buffer.from(input.text, 'utf8');
  else if (typeof input.data === 'string') data = Buffer.from(input.data, 'base64');
  else throw new AppError('请上传表格或粘贴 BOM 文本');
  if (data.length > 10 * 1024 * 1024) throw new AppError('表格超过 10 MiB');
  if (!data.length) throw new AppError('表格为空');
  // 嘉立创标准版的 CSV 可能实际采用 UTF-16 与制表符。
  const isWorkbook = data[0] === 0x50 && data[1] === 0x4b || data[0] === 0xd0 && data[1] === 0xcf;
  let workbook;
  try {
    if (isWorkbook) workbook = XLSX.read(data, {type: 'buffer', cellDates: false});
    else {
      let encoding = 'utf-8';
      if (data[0] === 0xff && data[1] === 0xfe) encoding = 'utf-16le';
      else if (data[0] === 0xfe && data[1] === 0xff) encoding = 'utf-16be';
      else if (data.subarray(0, 100).some((v, i) => i % 2 === 1 && v === 0)) encoding = 'utf-16le';
      let str = new TextDecoder(encoding).decode(data).replace(/^\uFEFF/, '');
      if (encoding === 'utf-8' && str.includes('\uFFFD')) str = new TextDecoder('gb18030').decode(data);
      workbook = XLSX.read(str, {type: 'string', raw: true});
    }
  } catch { throw new AppError('无法解析表格，请使用 CSV、TSV 或 Excel 文件'); }
  const sheets = workbook.SheetNames;
  const sheetName = input.sheet || sheets[0];
  if (!sheets.includes(sheetName)) throw new AppError('工作表不存在');
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {header: 1, defval: '', raw: false, blankrows: false});
  let header = Number.isInteger(input.headerRow) ? input.headerRow : 0;
  if (input.headerRow == null) {
    let best = -1;
    matrix.slice(0, 20).forEach((row, i) => {
      const score = Object.values(guessMapping(row.map(clean))).filter(Boolean).length;
      if (score > best) { best = score; header = i; }
    });
  }
  const columns = (matrix[header] || []).map((v, i) => clean(v) || `列${i + 1}`);
  if (!columns.length || matrix.length <= header + 1) throw new AppError('未找到表头或数据行');
  if (new Set(columns).size !== columns.length) throw new AppError('表头有重复列名，请在原文件中重命名后导入');
  const rows = matrix.slice(header + 1).filter(r => r.some(v => clean(v))).map(row => Object.fromEntries(columns.map((c, i) => [c, clean(row[i])])));
  if (rows.length > 5000) throw new AppError('单次最多导入 5000 行');
  return {columns, rows, mapping: guessMapping(columns), sheets, sheet: sheetName, headerRow: header};
}
export function mapRows(rows, mapping, kind = 'bom') {
  if (!Array.isArray(rows) || !rows.length || rows.length > 5000) throw new AppError('需要 1～5000 行数据');
  if (!mapping || !mapping.quantity) throw new AppError('请映射数量列');
  return rows.map((row, index) => {
    const out = Object.fromEntries(Object.keys(fields).map(key => [key, clean(row[mapping[key]])]));
    const rawDnp = norm(out.dnp);
    out.excluded = ['YES', 'TRUE', '1', 'DNP', '不装', '不安装'].includes(rawDnp);
    if (['BOMINCLUDE', '加入BOM'].includes(norm(mapping.dnp))) out.excluded = ['NO', 'FALSE', '0', '否'].includes(rawDnp);
    out.quantity = out.excluded && kind === 'bom' ? 0 : integer(out.quantity, `第 ${index + 1} 行数量`);
    if (!out.mpn && !out.lcsc && !out.code) throw new AppError(`第 ${index + 1} 行缺少型号或编号`);
    out.lcsc = norm(out.lcsc);
    out.index = index;
    return out;
  });
}
export function matchPart(line, parts) {
  const active = parts.filter(p => !p.archived);
  const compatible = p => p.condition !== '待检测' && (!line.footprint || norm(p.footprint) === norm(line.footprint)) && (!line.mpn || norm(p.mpn) === norm(line.mpn));
  let candidates = [];
  let reason = '';
  if (line.code) { candidates = active.filter(p => norm(p.code) === norm(line.code)); reason = '内部编号'; }
  if (!candidates.length && line.lcsc) { candidates = active.filter(p => norm(p.lcsc) === norm(line.lcsc)); reason = '立创编号'; }
  if (!candidates.length && line.mpn) { candidates = active.filter(p => norm(p.mpn) === norm(line.mpn)); reason = '型号'; }
  const fitting = candidates.filter(compatible);
  // 多候选与封装冲突留给使用者，参数近似不会成为自动替代料。
  if (fitting.length === 1) return {partId: fitting[0].id, reason: `${reason}${line.footprint ? ' + 封装' : ''}`, candidates: candidates.map(p => p.id)};
  return {partId: null, reason: candidates.length ? fitting.length > 1 ? '多个候选，需确认' : '型号或封装冲突，需确认' : '未匹配', candidates: candidates.map(p => p.id)};
}
export function demand(quantity, boards, sparePercent) {
  const result = Math.ceil(quantity * boards * (100 + sparePercent) / 100 - 1e-9);
  if (!Number.isSafeInteger(result) || result > 1e9) throw new AppError('总需求过大，请减少板数或用量');
  return result;
}
export function compareBom(bom, parts) {
  const pool = new Map(parts.filter(p => !p.archived && p.condition !== '待检测').map(p => [p.id, p.quantity]));
  const byId = new Map(parts.map(p => [p.id, p]));
  const lines = bom.lines.map(line => {
    const rawPart = byId.get(line.partId);
    const part = rawPart && rawPart.condition !== '待检测' ? rawPart : null;
    const required = line.excluded ? 0 : demand(line.quantity, bom.boards, bom.sparePercent);
    const available = part && !part.archived ? pool.get(part.id) || 0 : 0;
    const allocated = Math.min(required, available);
    if (part && !part.archived) pool.set(part.id, available - allocated);
    return {...line, part: part && !part.archived ? part : null, required, available, allocated, shortage: required - allocated,
      status: line.excluded || !required ? 'excluded' : !part || part.archived ? 'unmatched' : required > allocated ? 'shortage' : 'enough'};
  });
  const included = lines.filter(l => l.status !== 'excluded');
  let maxBoards = 0;
  if (included.length && included.every(l => l.part)) {
    const fits = count => {
      const totals = new Map();
      for (const line of included) totals.set(line.partId, (totals.get(line.partId) || 0) + demand(line.quantity, count, bom.sparePercent));
      return [...totals].every(([id, q]) => q <= byId.get(id).quantity);
    };
    let lo = 0, hi = Math.min(...included.map(l => Math.floor(l.part.quantity / Math.max(1, l.quantity)))) + 1;
    while (lo + 1 < hi) { const mid = Math.floor((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid; }
    maxBoards = lo;
  }
  return {...bom, lines, summary: {lines: included.length, enough: included.filter(l => l.status === 'enough').length,
    shortage: included.filter(l => l.status === 'shortage').length, unmatched: included.filter(l => l.status === 'unmatched').length,
    required: included.reduce((n, l) => n + l.required, 0), missing: included.reduce((n, l) => n + l.shortage, 0), maxBoards}};
}
export function csv(rows, columns) {
  // 防止文本编号或备注在 Excel 中变成公式。
  const cell = value => { let s = String(value ?? ''); if (/^[=+@\-]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  return '\uFEFF' + [columns.map(c => cell(c[0])).join(','), ...rows.map(r => columns.map(c => cell(typeof c[1] === 'function' ? c[1](r) : r[c[1]])).join(','))].join('\r\n');
}
