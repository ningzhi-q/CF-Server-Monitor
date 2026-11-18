# 自定义 Ping 节点与分组（2.9.0）

认证后台设置新增动态探测目录，支持增删实际 IP / 域名地址、启用状态、稳定 ID 与命名分组。IPv4 / IPv6 分组由 Agent 可达性旗标自动选择，双栈选择两组；auto 通用组适用于任一种网络。每台服务器可切到 manual 并选择目标，空数组表示不探测。

配置默认关闭，旧配置和 schema 3–7 Agent 保持原八路探测。schema 8 配置通过 POST/WSS 下发 probe_catalog 和 probe_selection；新版 Agent 动态启用后将旧八路指标标为关闭。安装与更新来源为 ningzhi-q/cfsm-agent，最低动态版本 v1.2.0。

公开 probe_catalog 仅包含组和目标 ID/名称，地址仅出现在认证后台与 Agent 配置。动态样本 probes 以目标 ID 为键，ts 为毫秒，latency/loss 保留数字、null、false。完整快照替换目标，空对象清空，缺字段不清除。历史在 probe_results JSON 列保存样本，不改写探测时间。

迁移采用幂等增列：servers.probe_selection、metrics_history.probe_results 和 metrics_history_old.probe_results。备份包含目录与选择；旧备份维持空字段，非法目录忽略并报告。

配置传输有大小预算，节点数量没有固定上限。Agent 独立四 worker，周期不重叠，DNS 按地址族缓存，120 秒过期样本不重复上报。大量超时地址会延长整轮探测，但不阻塞资源监控采样。

验证覆盖超过八路、IPv4/IPv6/双栈、手动空选择、非法地址、三态、清除快照、旧协议、真实 D1 增列和历史读取。

## 单台服务器保存修复（2026-11-18）

编辑窗口此前使用独立的请求拼装逻辑，遗漏 `probe_selection`。后台返回成功时只保存了请求里其他字段，原有自动选择没有变化，所以重新打开恢复默认值。单台编辑现在与批量编辑共用 `buildEditPayloadFromForm`，包含手动选择与显式空列表。

回归测试直接执行编辑窗口的 `saveEdit`，经过认证管理接口和真实 Miniflare D1 SQL，检查重新打开表单及 schema 8 Agent 配置。修复前复现“手动 IPv6 保存后仍为 auto”；修复后覆盖手动 IPv6、全部取消、切回自动及失败保留草稿。新增编辑字段时须验证实际提交入口，不能只验证请求构造辅助函数。

本轮 `npm run test:all` 通过：主套件 227 项、历史查询 6 项以及 Agent 配置校验；`npm run build:frontend` 通过。没有数据库迁移，不改动现有节点选择。
