模型 slug: `gpt-5.6-sol-xhigh-fast`

# Round 3 最终验收测试报告

## 验收结论

**PASS。** 全量 Node 测试无失败，环境探针 9/9 通过，最终 500 敌人 +
3000 粒子浏览器压测稳定在 60 FPS，且报告导出链路已加入自动回归。

- 验收时间：2026-08-26（UTC）
- 分支：`cursor/round3-final-validation-5e2c`
- 系统：Linux 6.12.94+
- Node.js：v22.14.0
- 浏览器：Headless Chrome 148.0.7778.96

## 1. 端到端回归

新增 `tests/full-regression.test.js`，直接按 `index.html` 的生产顺序加载全部
游戏脚本，并在最小浏览器环境中贯穿以下流程：

1. 主菜单确认开始；
2. 创建默认 `Player`（当前产品只有一名默认特工，没有独立选角页）；
3. 初始武器真实索敌、发射并击杀敌人；
4. 获取经验、进入升级状态、渲染升级卡并完成选择；
5. 推进到第五波、生成 Boss、开启处决 QTE；
6. 在判定带内按 E，触发 `boss:qte:success` 并击杀 Boss；
7. 继续触发玩家死亡，验证 `DEAD` 状态、结算页、等级和击杀统计。

当前产品没有独立 `VICTORY` 状态，因此测试以 Boss 成功处决事件与 Boss 死亡
作为“胜利”的可观测定义；不会把并不存在的胜利界面误报为已覆盖。

同文件还验证 `tests/benchmark.html` 的内联脚本可解析，并锁定最终报告构建、
JSON MIME、下载入口与浏览器 API 导出契约。

## 2. 全量测试

执行命令：

```bash
node --test tests/*.test.js
```

最终结果：

```text
tests      111
pass       109
fail       0
cancelled  0
skipped    0
todo       2
duration   2777.191012 ms
```

新增的两条 Round 3 用例均通过。2 条 TODO 是既有的超大数值 `Vector2` 边界
用例，不属于本轮失败，也未被跳过状态掩盖为通过。

## 3. 环境探针

执行命令：

```bash
node scripts/probe.js
```

结果：

```text
Summary: 9 passed, 0 failed
PROBE_RESULT=PASS
```

覆盖必需文件、开发服务器命令、HTML 入口、移动端测试发现、移动 CSS 契约、
24 个本地 HTML 引用、23 个入口脚本引用，以及 35 个 JavaScript 文件的
`node --check`。探针同时兼容直接 `http.server` 与 `scripts/dev-server.sh`
开发服务器入口。

## 4. 最终性能压测

测试页面：

```text
/tests/benchmark.html?stress=1&warmup=1500&duration=5000
```

测试口径：

- 画布：1265×633，DPR 1；
- 场景：500 个敌人 + 3000 个批量粒子；
- 预热：1.5 秒；
- 采样：5 秒；
- 有效采样：301 帧；
- 浏览器模式：Headless Chrome，软件渲染；
- 浏览器脚本异常：0。

| 指标 | 最终结果 |
| --- | ---: |
| 平均 FPS | 60.002 |
| 1% Low FPS | 59.524 |
| P95 帧耗时 | 16.8 ms |
| >50ms 长帧 | 0 / 301 |
| 采样末 JS Heap | 1,386,347 bytes |

结果达到 60 FPS 目标线。该数值仅代表当前无头软件渲染环境，不能替代目标
移动设备和独立 GPU 上的真机复测。

## 5. 最终压测报告导出

`tests/benchmark.html` 新增“导出最终报告”按钮，并在采样结束后启用。导出的
JSON 包含：

- schema、模型 slug、生成时间和完成状态；
- user agent、视口、Canvas 像素、DPR、JS Heap；
- 预热/采样时长、目标 FPS、长帧阈值和压测规模；
- 场景汇总、完整原始结果、最差平均 FPS、最大 P95 与长帧总数。

页面同时公开：

```js
window.__benchmark.exportReport()
window.__benchmark.downloadReport()
```

本轮通过 Chrome DevTools Protocol 调用真实 `exportReport()` 取得报告，
确认 `complete: true`、1 个压测场景和 0 个浏览器异常。

## 最终判定

Round 3 验收项全部完成：

- [x] 端到端主流程回归；
- [x] 全量测试 0 失败；
- [x] 环境探针 9/9；
- [x] 最终压测报告导出；
- [x] 500 + 3000 最终压力采样达到 60 FPS。
