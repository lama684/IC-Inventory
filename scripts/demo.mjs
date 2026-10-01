import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../backend/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=createApp({dataDir:path.join(root,'test-results','demo-data')});
if(!app.store.parts(true).length)app.store.transaction(()=>{
  for(const p of [
    {mpn:'TPS55288RPMR',lcsc:'C2687986',footprint:'VQFN-26',category:'IC',manufacturer:'Texas Instruments',location:'A柜 / 01盒 / 03格',quantity:8,minStock:3,price:15.8,value:'升降压转换器'},
    {mpn:'SW3518S',lcsc:'C5149201',footprint:'QFN-32',category:'IC',manufacturer:'智融',location:'A柜 / 01盒 / 05格',quantity:3,minStock:5,price:6.5,value:'USB PD 控制器'},
    {mpn:'GRM31CR71H106KA12L',lcsc:'C13585',footprint:'1206',category:'电容',manufacturer:'Murata',location:'B柜 / 03盒 / 01格',quantity:120,minStock:20,price:0.42,value:'10µF / 50V / X7R'},
    {mpn:'RC0603FR-0710KL',lcsc:'C25804',footprint:'0603',category:'电阻',manufacturer:'Yageo',location:'B柜 / 01盒 / 04格',quantity:500,minStock:50,price:0.01,value:'10kΩ / 1%'},
    {mpn:'AO3400A',lcsc:'C20917',footprint:'SOT-23',category:'MOS管',location:'A柜 / 04盒 / 02格',quantity:26,minStock:10,value:'30V / N-MOS',condition:'拆机可用'},
    {mpn:'ESP32-S3-WROOM-1-N16R8',lcsc:'C2913204',footprint:'MODULE',category:'模块',location:'C柜 / 01盒',quantity:4,minStock:2,price:24.5,value:'16MB Flash / 8MB PSRAM'},
    {mpn:'SS34',lcsc:'C8678',footprint:'SMA',category:'二极管',location:'A柜 / 04盒 / 06格',quantity:0,minStock:10,value:'40V / 3A'},
    {mpn:'旧板回收电容',footprint:'0805',category:'电容',location:'待检盒',quantity:15,condition:'待检测',value:'容量 / 耐压未确认'}
  ])app.store.create({...p,notes:'合成演示数据，非实购物料；料号和价格仅用于功能测试。'});
});
const port=Number(process.env.DEMO_PORT||3211);
app.server.listen(port,'127.0.0.1',()=>console.log(`合成演示环境：http://localhost:${port}；与正式库存分离`));
process.on('SIGINT',()=>app.server.close(()=>{app.store.close();process.exit(0);}));
