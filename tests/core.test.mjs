import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { Store } from '../backend/db.mjs';
import { parseTable, mapRows, matchPart, compareBom, csv } from '../backend/bom.mjs';
import { createApp } from '../backend/server.mjs';

const part = (s, input={}) => s.transaction(()=>s.create({mpn:'TEST-IC',lcsc:'C100',footprint:'QFN-16',quantity:10,...input}));
const line = (input={}) => ({mpn:'TEST-IC',lcsc:'C100',footprint:'QFN-16',quantity:2,designators:'U1,U2',index:0,excluded:false,...input});
const memory = fn => {const s=new Store(':memory:');try{return fn(s);}finally{s.close();}};

test('手动编号、自动序列与重复编号事务回滚',()=>memory(s=>{
  part(s,{code:'IC-000001'});const p=part(s,{lcsc:'C200'});assert.equal(p.code,'IC-000002');
  assert.throws(()=>part(s,{code:'ic-000001'}),/UNIQUE/);assert.equal(s.parts().length,2);
}));
test('出库拒绝负库存；相同操作重试只扣一次',()=>memory(s=>{
  const p=part(s);const input={key:'movement-a',type:'出库',quantity:4};s.movement(p.id,input);s.movement(p.id,input);
  assert.equal(s.part(p.id).quantity,6);assert.equal(s.movements().length,2);
  assert.throws(()=>s.movement(p.id,{key:'too-many',type:'出库',quantity:7}),/库存不足/);assert.equal(s.part(p.id).quantity,6);
  assert.throws(()=>s.movement(p.id,{...input,quantity:3}),/内容不同/);
}));
test('盘点保存差额，元件编辑不能绕过库存流水',()=>memory(s=>{
  const p=part(s);s.movement(p.id,{key:'count',type:'盘点',quantity:3});assert.equal(s.movements()[0].delta,-7);
  assert.throws(()=>s.update(p.id,{quantity:50}),/出入库/);s.update(p.id,{location:'A-1'});assert.equal(s.part(p.id).quantity,3);
}));
test('UTF-16 制表符 BOM、中文表头及逗号位号正确解析',()=>{
  const text='\uFEFF名称\t封装\t数量\t供应商料号\t位号\r\nTEST-IC\tQFN-16\t2\tC100\tU1,U2';
  const table=parseTable({data:Buffer.from(text,'utf16le').toString('base64')});const rows=mapRows(table.rows,table.mapping);
  assert.equal(rows[0].quantity,2);assert.equal(rows[0].lcsc,'C100');assert.equal(rows[0].designators,'U1,U2');
});
test('UTF-8 CSV 引号与专业版中英文表头',()=>{
  const table=parseTable({text:'Manufacturer Part,Footprint,Quantity,Supplier Part,Designator\nTEST-IC,QFN-16,2,C100,"U1,U2"'});
  const rows=mapRows(table.rows,table.mapping);assert.equal(rows[0].designators,'U1,U2');assert.equal(rows[0].mpn,'TEST-IC');
});
test('标准版 Name 在制造商料号之前仍优先取真正型号',()=>{
  const table=parseTable({text:'ID,Name,Designator,Footprint,Quantity,Manufacturer Part,Manufacturer,Supplier Part\n1,10k,"R1,R2",0603,2,RC0603FR-0710KL,Yageo,C25804'});
  const rows=mapRows(table.rows,table.mapping);assert.equal(rows[0].mpn,'RC0603FR-0710KL');assert.equal(rows[0].value,'10k');
});
test('旧 XLS 与 GB18030 中文 CSV 可解析',()=>{
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['型号','数量'],['OLD-XLS',2]]),'BOM');
  const table=parseTable({data:XLSX.write(wb,{type:'buffer',bookType:'biff8'}).toString('base64')});assert.equal(mapRows(table.rows,table.mapping)[0].quantity,2);
  const text=parseTable({data:Buffer.from('d0cdbac52ccafdc1bf0a412c32','hex').toString('base64')});assert.equal(mapRows(text.rows,text.mapping)[0].quantity,2);
});
test('Excel 工作表选择、标题前缀与行数解析',()=>{
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['工程 BOM'],['型号','封装','数量'],['TEST-IC','QFN-16',2]]),'BOM');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['型号','数量'],['OTHER',3]]),'备用');
  const data=XLSX.write(wb,{type:'buffer',bookType:'xlsx'}).toString('base64');
  const p=parseTable({data});assert.equal(p.headerRow,1);assert.equal(mapRows(p.rows,p.mapping)[0].quantity,2);
  assert.equal(parseTable({data,sheet:'备用'}).rows[0]['型号'],'OTHER');
});
test('数量缺失、负数、小数、过大与重复表头被拒绝',()=>{
  for(const quantity of ['','-1','1.5','1000000001'])assert.throws(()=>mapRows([{型号:'A',数量:quantity}],{mpn:'型号',quantity:'数量'}));
  assert.throws(()=>parseTable({text:'型号,数量,数量\nA,1,2'}),/重复列名/);
});
test('DNP 与加入 BOM 否均可不装，空数量不会误当正常用量',()=>{
  const rows=[{型号:'A',数量:'',DNP:'Yes'}];assert.equal(mapRows(rows,{mpn:'型号',quantity:'数量',dnp:'DNP'})[0].excluded,true);
  assert.equal(mapRows([{型号:'A',数量:'2',加入BOM:'否'}],{mpn:'型号',quantity:'数量',dnp:'加入BOM'})[0].excluded,true);
});
test('同名异封装、料号冲突、多候选与待检测不自动领料',()=>memory(s=>{
  const p=part(s);assert.equal(matchPart(line({footprint:'SOIC-16'}),s.parts()).partId,null);
  assert.equal(matchPart(line({mpn:'OTHER'}),s.parts()).partId,null);
  part(s,{condition:'拆机可用'});assert.equal(matchPart(line(),s.parts()).partId,null);
  assert.equal(matchPart(line({code:p.code}),s.parts()).partId,p.id);
  s.update(p.id,{condition:'待检测'});assert.equal(matchPart(line({code:p.code}),s.parts()).partId,null);
}));
test('BOM 多行共享库存、板数与备料按行向上取整',()=>memory(s=>{
  part(s,{quantity:10});const b=s.createBom({name:'Shared',boards:2,sparePercent:10},[line({quantity:2}),line({quantity:3,index:1})]);
  assert.deepEqual(b.lines.map(l=>[l.required,l.allocated,l.shortage]),[[5,5,0],[7,5,2]]);assert.equal(b.summary.maxBoards,1);assert.equal(s.parts()[0].quantity,10);
}));
test('重复行最大板数按合并需求，零用量不阻塞有效行',()=>memory(s=>{
  part(s,{quantity:10});const b=s.createBom({boards:1},[line(),line({quantity:3}),line({quantity:0,mpn:'ZERO',lcsc:''})]);
  assert.equal(b.summary.maxBoards,2);assert.equal(b.summary.lines,2);
}));
test('整单缺料不扣库存；明确部分领料保存缺口且不可重复',()=>memory(s=>{
  const p=part(s,{quantity:3});const b=s.createBom({boards:2},[line()]);
  assert.throws(()=>s.issueBom(b.id,{key:'full'}),/库存不足/);assert.equal(s.part(p.id).quantity,3);
  const input={key:'partial',partial:true};const result=s.issueBom(b.id,input);assert.equal(result.lines[0].shortage,1);
  assert.equal(s.part(p.id).quantity,0);assert.deepEqual(s.issueBom(b.id,input),JSON.parse(JSON.stringify(result)));
  assert.throws(()=>s.issueBom(b.id,{key:'second',partial:true}),/已领料/);assert.throws(()=>s.updateBom(b.id,{boards:1}),/不可修改/);
}));
test('领料重算实时库存，后续变成待检测也不能使用',()=>memory(s=>{
  const p=part(s);const b=s.createBom({boards:3},[line()]);s.movement(p.id,{key:'manual-out',type:'出库',quantity:8});
  assert.throws(()=>s.issueBom(b.id,{key:'issue'}),/库存不足/);s.update(p.id,{condition:'待检测'});assert.equal(s.compare(b.id).lines[0].status,'unmatched');
}));
test('批量入库累加、操作重试去重、后行冲突整批回滚',()=>memory(s=>{
  const p=part(s);const rows=[line({code:p.code,quantity:2})];s.importStock(rows,'batch');s.importStock(rows,'batch');assert.equal(s.part(p.id).quantity,12);
  assert.throws(()=>s.importStock([line({code:p.code,quantity:5}),line({code:p.code,mpn:'CONFLICT'})],'bad'),/冲突/);assert.equal(s.part(p.id).quantity,12);
}));
test('零库存归档保留流水，存在库存时不能归档',()=>memory(s=>{
  const p=part(s);assert.throws(()=>s.archive(p.id),/清零/);s.movement(p.id,{key:'zero',type:'盘点',quantity:0});s.archive(p.id);
  assert.equal(s.parts().length,0);assert.equal(s.movements().length,2);assert.throws(()=>s.movement(p.id,{key:'archived',type:'入库',quantity:1}),/归档/);
}));
test('完整备份恢复与非法备份原数据保护',()=>memory(s=>{
  const p=part(s);s.createBom({boards:1},[line()]);const backup=s.snapshot();s.movement(p.id,{key:'change',type:'出库',quantity:5});s.restore(backup);
  assert.equal(s.part(p.id).quantity,10);assert.equal(s.boms().length,1);const broken=structuredClone(backup);broken.movements[0].partId=999;
  assert.throws(()=>s.restore(broken));assert.equal(s.part(p.id).quantity,10);
}));
test('服务重启后 SQLite 保留库存、BOM 和编号序列',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ic-inventory-test-')),db=path.join(dir,'inventory.sqlite');
  let s=new Store(db);part(s);s.createBom({boards:1},[line()]);s.close();s=new Store(db);assert.equal(s.parts()[0].quantity,10);assert.equal(s.boms().length,1);assert.equal(part(s,{mpn:'SECOND',lcsc:'C200'}).code,'IC-000002');s.close();
  fs.rmSync(dir,{recursive:true,force:true});
});
test('CSV 导出转义逗号、换行与公式内容',()=>{
  const text=csv([{code:'=1+1',mpn:'A,"B\nC'}],[['编号','code'],['型号','mpn']]);assert.ok(text.startsWith('\uFEFF'));assert.ok(text.includes("'=1+1"));assert.ok(text.includes('""B'));
});
test('HTTP 库存→导入→查缺→领料→二维码→备份闭环',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ic-http-test-')),app=createApp({dataDir:dir});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const call=async(url,method='GET',body)=>{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
  try {
    const created=await call('/api/parts','POST',{key:'create',mpn:'TEST-IC',lcsc:'C100',footprint:'QFN-16',quantity:8});assert.equal(created.status,201);
    const parsed=await call('/api/import/parse','POST',{text:'型号,封装,立创编号,数量\nTEST-IC,QFN-16,C100,2'});
    const b=await call('/api/boms','POST',{...parsed.data,boards:3});assert.equal(b.data.summary.missing,0);
    const issued=await call(`/api/boms/${b.data.id}/issue`,'POST',{key:'http-issue'});assert.equal(issued.status,200);
    const retry=await call(`/api/boms/${b.data.id}/issue`,'POST',{key:'new-http-issue'});assert.equal(retry.status,409);
    assert.equal((await call('/api/parts')).data[0].quantity,2);
    const labels=await fetch(base+`/api/labels?ids=${created.data.id}&base=http%3A%2F%2F192.168.1.20%3A3210`);assert.ok((await labels.text()).includes('<svg'));
    const backup=await call('/api/backup');assert.equal(backup.data.format,'IC-Inventory');
    assert.equal((await call('/api/restore','POST',{snapshot:backup.data,confirm:'恢复备份'})).status,200);
    const html=await fetch(base+'/');assert.equal(html.status,200);assert.ok((await html.text()).includes('IC 元件管理'));
  } finally {await new Promise(resolve=>app.server.close(resolve));app.store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
