import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dest=path.join(root,'release','stage','IC-Inventory');
fs.mkdirSync(dest,{recursive:true});
for(const name of ['backend','frontend','docs','contracts','tests','scripts','examples']){
  fs.cpSync(path.join(root,name),path.join(dest,name),{recursive:true,filter:source=>!source.endsWith('run-scheduled.ps1')});
}
for(const name of ['package.json','package-lock.json','pnpm-lock.yaml','README.md','AGENTS.md','.gitignore','启动.cmd'])fs.copyFileSync(path.join(root,name),path.join(dest,name));
// 使用 UTF-8 BOM 保证 Windows PowerShell 5.1 能识别中文说明。
for(const dir of [path.join(root,'scripts'),path.join(dest,'scripts')])for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.ps1'))){const p=path.join(dir,name),text=fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'');fs.writeFileSync(p,'\uFEFF'+text);}
console.log(`发布暂存：${dest}；安装依赖后压缩此目录。`);
