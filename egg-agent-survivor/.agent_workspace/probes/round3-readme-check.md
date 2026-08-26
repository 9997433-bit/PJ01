模型 slug：`gpt-5.6-sol-xhigh-fast`

# Round 3 文档完整性检查

检查对象：

- `README.md`
- `PLAY.md`
- `scripts/dev-server.sh`
- `scripts/run-benchmark.sh`
- `package.json`

## 结论

**PASS** — Round 3 要求的游戏介绍、操作、武器表、竞品定位、快速上手、启动体验、开发命令和部署说明均已覆盖。文档中的玩法与默认游戏入口保持一致。

## 需求覆盖

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| 完整游戏介绍 | PASS | README 包含背景、核心循环、特色、波次、Boss、升级、连击与结算 |
| 操作说明 | PASS | README 提供桌面 / 触屏对照表，PLAY 提供最少操作表 |
| 武器表 | PASS | README 区分 6 把基础武器与 10 把融合武器，并列出元素、等级上限和机制 |
| 对比《弹壳特攻队》 | PASS | README 提供 8 个维度的定位对比，并声明无隶属或授权关系 |
| 快速上手 | PASS | PLAY 覆盖启动、第一局路线、升级、Fever、Boss 处决、HUD 与 FAQ |
| 自动打开浏览器 | PASS | `dev-server.sh` 依次支持 `$BROWSER`、`xdg-open`、`open`、`wslview`、PowerShell |
| 无桌面环境降级 | PASS | 打开失败不会终止服务器；支持 `OPEN_BROWSER=0` |
| test 脚本 | PASS | `npm test` 映射到 `node --test tests/*.test.js` |
| benchmark 脚本 | PASS | `npm run benchmark` 映射到 `scripts/run-benchmark.sh` |
| 部署说明 | PASS | README 覆盖 GitHub Pages、Netlify / Vercel / 静态平台和 Nginx |

## 玩法事实核对

| 文档事实 | 代码来源 | 状态 |
| --- | --- | --- |
| 六把基础武器与等级上限 | `js/systems/WeaponSystem.js` | 一致 |
| 18 种被动卡 | `js/systems/UpgradeSystem.js` | 一致 |
| 初始 1 次重随 / 消除，每 5 次选择返还重随 | `js/systems/UpgradeSystem.js` | 一致 |
| 每波 30 秒、每 5 波 Boss | `js/systems/EnemySpawner.js` | 一致 |
| 30 连击触发 8 秒 Fever | `js/systems/ComboSystem.js` | 一致 |
| Boss 低于 22% 血量开启一次 2.8 秒处决窗口 | `js/entities/Enemy.js` | 一致 |
| 键盘与触控按键 | `js/utils/InputManager.js`、`index.html` | 一致 |
| 自适应三档画质 | `js/engine/GameEngine.js` | 一致 |
| 五种元素、10 个元素对与 10 把融合武器 | `js/data/fusion-weapons.json` | 一致 |
| 双源武器 5 级解锁、最多 2 把融合武器 | `js/systems/ElementFusion.js` | 一致 |

## 链接与命令检查

- README → `PLAY.md`：目标文件存在。
- PLAY → `README.md`：目标文件存在。
- README 中的 `scripts/dev-server.sh` 与 `scripts/run-benchmark.sh`：文件存在且为可执行脚本。
- 默认游戏地址：开发脚本监听 `0.0.0.0:3000`，浏览器使用可访问的 `127.0.0.1:3000`。
- 默认基准地址：`127.0.0.1:4173/tests/benchmark.html`。
- 静态部署目录：`index.html` 引用的运行资源位于 `css/`、`js/`，无需构建产物。

## 准确性说明

README 将开局卡池中的 6 把基础武器与中后期解锁的 10 把融合武器分表描述，没有把二者混成“开局可抽取的 16 把武器”。回旋蛋镖明确标为纯物理武器，不参与五元素反应或融合。

## 验收命令

```bash
bash -n scripts/dev-server.sh scripts/run-benchmark.sh
npm test
npm run probe
```

验收标准：Shell 语法检查退出码为 0；测试与项目探针无失败；`package.json` 可被 Node 正常解析。
