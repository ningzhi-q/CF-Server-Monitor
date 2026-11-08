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
