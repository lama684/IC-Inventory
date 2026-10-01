import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import QRCode from 'qrcode';
import { Store } from './db.mjs';
import { AppError, parseTable, mapRows, csv, clean, norm } from './bom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryColumns = [['内部编号','code'],['型号','mpn'],['立创编号','lcsc'],['参数','value'],['封装','footprint'],['分类','category'],['制造商','manufacturer'],['位置','location'],['库存数量','quantity'],['最低库存','minStock'],['单价','price'],['状态','condition'],['备注','notes']];
const bomColumns = [['位号','designators'],['型号','mpn'],['立创编号','lcsc'],['封装','footprint'],['单板用量','quantity'],['总需求','required'],['可领数量','allocated'],['缺少数量','shortage'],['库存编号',l=>l.part?.code],['库位',l=>l.part?.location],['匹配依据','reason']];
const escape = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function send(res, data, type='application/json; charset=utf-8', status=200, filename) {
  const headers = {'Content-Type': type, 'Cache-Control': 'no-store'};
  if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  res.writeHead(status, headers); res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 24 * 1024 * 1024) throw new AppError('上传内容过大',413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new AppError('请求格式无效'); }
}
export function createApp(options={}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(root,'data'));
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(path.join(dataDir,'inventory.sqlite'));
  const handler = async (req,res) => {
    try {
      const url = new URL(req.url,'http://localhost');
      const route = decodeURIComponent(url.pathname), method = req.method;
      if (route === '/api/health') return send(res,{ok:true,version:'1.0.0',parts:store.parts().length});
      if (route === '/api/info') return send(res,{version:'1.0.0',dataDir,addresses: Object.values(networkInterfaces()).flat().filter(a=>a?.family==='IPv4'&&!a.internal).map(a=>a.address)});
      if (route === '/api/parts' && method==='GET') {
        const q = norm(url.searchParams.get('q') || '');
        return send(res,store.parts(url.searchParams.get('archived')==='1').filter(p=>!q||norm(Object.values(p).join(' ')).includes(q)||q===`ICINV:${p.id}`));
      }
      if (route === '/api/parts' && method==='POST') { const input=await body(req); return send(res,store.once(input.key,'create-part',input,()=>store.create(input)),undefined,201); }
      if (route === '/api/parts/export') return send(res,csv(store.parts(),inventoryColumns),'text/csv; charset=utf-8',200,'inventory.csv');
      const partRoute = route.match(/^\/api\/parts\/(\d+)(?:\/(movements))?$/);
      if (partRoute) {
        if (partRoute[2] && method==='POST') return send(res,store.movement(partRoute[1],await body(req)));
        if (method==='GET') return send(res,store.part(partRoute[1]));
        if (method==='PATCH') return send(res,store.update(partRoute[1],await body(req)));
        if (method==='DELETE') return send(res,store.archive(partRoute[1]));
      }
      if (route === '/api/movements') return send(res,store.movements());
      if (route === '/api/movements/export') return send(res,csv(store.movements(),[['时间','createdAt'],['编号','code'],['型号','mpn'],['操作','type'],['变动','delta'],['变动前','previous'],['结余','balance'],['关联','reference'],['备注','notes']]),'text/csv; charset=utf-8',200,'movements.csv');
      if (route === '/api/import/parse' && method==='POST') return send(res,parseTable(await body(req)));
      if (route === '/api/import/stock' && method==='POST') {
        const input=await body(req); return send(res,store.importStock(mapRows(input.rows,input.mapping,'stock'),input.key));
      }
      if (route === '/api/boms' && method==='GET') return send(res,store.boms());
      if (route === '/api/boms' && method==='POST') {
        const input=await body(req); return send(res,store.createBom(input,mapRows(input.rows,input.mapping)),undefined,201);
      }
      const bomRoute=route.match(/^\/api\/boms\/([a-f0-9-]+)(?:\/(issue|export))?$/);
      if (bomRoute) {
        const id=bomRoute[1];
        if (bomRoute[2]==='issue' && method==='POST') return send(res,store.issueBom(id,await body(req)));
        if (bomRoute[2]==='export') { const b=store.compare(id); const lines = b.status==='issued' ? b.issueResult.lines : b.lines; return send(res,csv(url.searchParams.get('shortage')==='1'?lines.filter(l=>l.shortage>0):lines,bomColumns),'text/csv; charset=utf-8',200,'bom.csv'); }
        if (method==='GET') return send(res,store.compare(id));
        if (method==='PATCH') return send(res,store.updateBom(id,await body(req)));
      }
      if (route === '/api/backup' && method==='GET') return send(res,store.snapshot(),undefined,200,`ic-inventory-${new Date().toISOString().slice(0,10)}.json`);
      if (route === '/api/restore' && method==='POST') {
        const input=await body(req);
        if (input.confirm !== '恢复备份') throw new AppError('请先确认恢复备份');
        const backupDir=path.join(dataDir,'backups'); fs.mkdirSync(backupDir,{recursive:true});
        const saved=path.join(backupDir,`before-restore-${Date.now()}.json`);
        fs.writeFileSync(saved,JSON.stringify(store.snapshot(),null,2));
        return send(res,{...store.restore(input.snapshot),saved});
      }
      if (route === '/api/labels' && method==='GET') {
        const ids=clean(url.searchParams.get('ids')).split(',').filter(Boolean).map(Number);
        if (!ids.length || ids.length>200 || ids.some(id=>!Number.isInteger(id))) throw new AppError('请选择 1～200 个元件打印');
        const base=clean(url.searchParams.get('base'));
        if (base && !/^https?:\/\/[^\s]+$/i.test(base)) throw new AppError('标签访问地址无效');
        const parts=ids.map(id=>store.part(id));
        const labels=await Promise.all(parts.map(async p=> {
          const target=base ? `${base.replace(/\/$/,'')}/?part=${p.id}` : `ICINV:${p.id}`;
          const qr=await QRCode.toString(target,{type:'svg',margin:1,errorCorrectionLevel:'M',width:100});
          return `<article>${qr}<div><strong>${escape(p.code)}</strong><b>${escape(p.mpn)}</b><span>${escape(p.footprint)} · ${escape(p.value)}</span><span>库位 ${escape(p.location || '未分配')}</span><span>${escape(p.lcsc)} · ${escape(p.condition)}</span></div></article>`;
        }));
        return send(res,`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>元件标签</title><style>body{font:14px 'Microsoft YaHei',sans-serif;margin:20px}.labels{display:flex;flex-wrap:wrap;gap:4mm}article{box-sizing:border-box;width:80mm;min-height:32mm;border:1px dashed #aaa;padding:2mm;display:flex;align-items:center;break-inside:avoid}svg{width:25mm;flex:none}article div{display:flex;flex-direction:column;gap:3px;min-width:0;overflow-wrap:anywhere}strong{font-size:16px}span{font-size:12px}button{padding:10px 20px;margin:0 0 20px}@media print{body{margin:0}button,.hint{display:none}article{border:1px solid #ddd}@page{margin:8mm}}</style></head><body><button onclick="window.print()">打印标签</button><p class="hint">每张 80 × 32 mm；使用普通 A4 打印裁切。二维码${base?'打开元件详情':'内容为稳定元件 ID，可用扫码枪录入搜索框'}。</p><section class="labels">${labels.join('')}</section></body></html>`,'text/html; charset=utf-8');
      }
      if (route.startsWith('/api/')) throw new AppError('接口不存在',404);
      if (method!=='GET'&&method!=='HEAD') throw new AppError('方法不支持',405);
      const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
      if (!files[route]) throw new AppError('页面不存在',404);
      const file=path.join(root,'frontend',files[route]);
      const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
      send(res,fs.readFileSync(file),types[path.extname(file)]);
    } catch(error) {
      let message=error.message,status=error.status||500;
      if (/UNIQUE constraint failed: parts.code/.test(message)) {message='元件编号已存在，请换一个编号或给已有元件入库';status=409;}
      if (!error.status && status===500) { console.error(error); if (!/编号已存在/.test(message)) message='操作失败，请检查数据后重试'; }
      send(res,{error:message},undefined,status);
    }
  };
  const server=http.createServer(handler);
  server.requestTimeout=30000;
  return {server,store,dataDir};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=createApp(); const port=Number(process.env.PORT||3210),host=process.env.HOST||'0.0.0.0';
  app.server.listen(port,host,()=>console.log(`IC 元件管理已启动：http://localhost:${port}\n数据目录：${app.dataDir}`));
  app.server.on('error',error=>{console.error(`服务启动失败：${error.message}`);app.store.close();process.exitCode=1;});
  const stop=()=>app.server.close(()=>{app.store.close();process.exit(0);});
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
