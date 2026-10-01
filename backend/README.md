# 后端

`server.mjs` 提供 HTTP API 与前端静态文件；`db.mjs` 管理 SQLite 事务和流水；`bom.mjs` 处理表格映射与按库存分配。运行数据库由 `DATA_DIR` 指定，默认工程内 `data/`。库存只通过事务入出库，BOM 比较不改变库存。
