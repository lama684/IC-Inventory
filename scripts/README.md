# Windows 运行工具

`start.ps1` 检查 Node.js 并运行服务，`install-startup.ps1` 可在家庭服务器注册开机任务，`uninstall-startup.ps1` 删除同名任务。仅在需要长期部署的服务器手动执行注册，不在开发机自动注册。

`demo.mjs` 启动独立合成演示库；`package.mjs` 将交付源码复制到发布暂存目录（不复制数据库、生成的任务脚本或开发依赖），依赖需以 `npm ci` 单独安装后压缩。
