# 自动上报 IP 属地

探针无需升级或发送真实 IP。Cloudflare Worker 从成功上报请求的 `request.cf` 取得国家、城市和经纬度；这是上报出口 IP 属地参考，不保证物理机房位置。NAT、VPN 或中转上报对应出口位置；元数据缺失时不猜城市或坐标。

HTTP 上报在 secret、服务器和指标校验成功后保存；WebSocket 升级时 Worker 覆盖专用内部 header，DO 将可信信息放入连接附件，仅在鉴权成功且指标有效后保存。客户端 JSON 或同名 header 无法伪造公开定位字段，所有旧批次样本也会清除客户端定位。新 HTTP 来源或 WS 重连会重新识别。

公共 `/api/servers`、`/api/server` 与 `/api/ws` 最新样本可包含 `location`：

```json
{"latitude":35.68,"longitude":139.69,"country":"JP","city":"Tokyo","source":"cloudflare-ip","observed_at":1794140000000}
```

上例是测试数据。时间为毫秒；city 可为 null。没有有效坐标则不返回 location。实际 IP 从不包含在 DTO 中，`ip_v4` / `ip_v6` 继续是可达性标志。

持久化字段为 `servers.auto_location`（JSON TEXT）。第一次有效上报惰性、幂等增加该可空列；只修改这一列，不修改 tags、region 或用户设置，不调用 `/updateDatabase`。新建库及显式列升级同样包含此列。内存状态按数据库隔离、有界，重复位置 24 小时内不写 D1；变化立即写，失败退避一分钟且指标继续处理。REST 列表和详情缓存会同步当前进程内的写入，其他进程最多遵循原 120 秒 TTL。

`node --test test/auto-location.test.js` 验证真实 D1 SQL、惰性增列、去重、位置变化、数据库隔离、失败退避、HTTP 鉴权、WS 可信附件与伪造载荷清除。所有测试数据只在本机临时数据库。部署须保留已有 D1 / DO / ASSETS / secret / 路由，不为定位新建其他资源。

本轮验证：188 项后端测试全部通过，Agent 配置独立检查通过，Wrangler Worker 干运行打包通过。前端 WS 单元测试使用 `configFile:false`，避免加载开发 HTTPS 证书安装器；无需向系统信任库安装证书。

## 2026-11-09：粗定位自动细分

当城市为空，或香港只返回 Hong Kong/香港时，从 Cloudflare 可信 `cf-connecting-ip` 自动查询 [DB-IP 免费 API](https://db-ip.com/api/free)。具体城市附 `city_source:"db-ip"`；香港仅返回行政地区时保留原 city，并附 `subdivision`、`subdivision_source:"db-ip"`。名称仅提供更细属地参考，不代表独立城市或物理机房。免费 API 没有经纬度，因此坐标与 `source:"cloudflare-ip"` 原样保留。使用本扩展的主题须标注 DB-IP 数据来源。

可信出口 IP 只用于请求与有界内存查找键 / WS 附件，不写数据库或公共 DTO。Worker 删除伪造内部 header 后覆盖，客户端 JSON 不参与定位。鉴权和有效指标校验完成后才查询，1.5 秒超时；IP、国家和名称均校验，失败保留原 Cloudflare 信息。同节点同 IP / 位置进程内缓存 24 小时，变化会重查。缓存并非全局持久限额，重启或多实例可能再次查询；免费额度为调用方 IP 500 次/天，额度失败正常降级。

旧 WS 附件没有出口 IP，需重新连接才能自动细分；不手工写生产节点属地。HTTP 上报立即使用新来源。测试覆盖 HTTP/WS 自动查询、鉴权之前不查询、地区与城市分离、原坐标保留、伪造数据清除、并发查找去重、每日刷新、IP 变化、提供者失败及 IP 不进入公共响应。部署继续复用原 Worker、D1、DO、静态资源与 secret。

本轮最终验证：207 项主测试、Agent 配置检查及 6 项历史查询测试全部通过；管理端构建和 Wrangler 干运行打包通过。生产安装复用现有 Worker 的绑定、兼容设置和静态资源，不修改 GitHub 部署配置或新建 Cloudflare 资源。

## 2026-11-10：新加坡地区与失败重试

粗定位条件增加 Singapore/新加坡。DB-IP 返回 `Singapore (Tampines)` 等明确括号区域时保留原 city，区域写入现有 subdivision 字段，坐标保持 Cloudflare 原值。已有具体 Cloudflare 城市仍不补查。提供者国家、IP、名称和长度校验继续适用。

查询超时为 3 秒。有效响应（包括没有更细地区的响应）缓存 24 小时；超时、HTTP 错误或无效响应一分钟后随有效上报重试，同键并发去重。刷新失败保留同一 IP / 原始位置键的上次成功结果，IP 或原始位置变化不沿用旧地区。查询失败不阻断正常指标。

旧休眠 WS 附件没有 locationIp 时，且位置需要补查，在处理、持久化并确认当前有效上报后关闭为 1012，探针自动重连获取可信出口元数据。新附件始终包含 locationIp（可为空），因此不会重复迁移；有具体城市的旧连接不受影响。无需手工配置生产节点地区。

本轮验证：217 项后端测试（包含历史查询）全部通过，Agent 配置独立检查通过，管理端构建和 Wrangler Worker 干运行打包通过。
