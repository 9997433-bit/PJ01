# EGG AGENT SURVIVOR · 架构文档

> 本文档随轮次演进。Round 1 落地核心玩法管线；Round 2 增补「元素融合武器系统」章节。
> 各系统的详细设计规范放在同目录的 ROUND*_*.md 中，本文只维护全局视图与各章的架构决策。

## 1. 总体分层

零依赖、零构建的浏览器游戏：全部代码是挂在 `window` 上的 IIFE，按 `index.html`
的 `<script>` 顺序加载，顺序即依赖方向（下层不知道上层）。

| 层 | 目录 | 内容 |
|---|---|---|
| 工具 | `js/utils/` | Vector2/MathUtils、粒子与飘字、输入、相机 |
| 引擎 | `js/engine/` | EventBus、SpatialGrid、GameEngine（主循环/状态机/实体调度） |
| 实体 | `js/entities/` | Entity 基类、Player、Enemy、Projectile、XpGem |
| 系统 | `js/systems/` | Background、CollisionSystem、WeaponSystem、EnemySpawner、UpgradeSystem、ElementFusion… |
| 界面/入口 | `js/ui/`、`js/main.js` | HUD、DOM 界面装配、总装 |
| 数据 | `js/data/` | 数据驱动配置（JSON，http 下 fetch 热加载） |

系统注册顺序即每帧执行顺序（`main.js`）：

```
CollisionSystem → WeaponSystem → EnemySpawner → UpgradeSystem → ElementFusion(自装配)
```

CollisionSystem 每帧先重建仅含敌人的空间网格并挂到 `engine.combat`，
后续系统的所有范围查询（圆/扇形/最近/最强/随机）都复用它。

## 2. 关键契约（跨系统协作依赖的接口）

- **武器定义**：`WEAPONS[id] = { base, perLevel, maxLevel, fire?, tick?, render?, init? }`。
  数值 `stats = base + perLevel × (level-1)` 由 `WeaponSystem.recalc` 统一计算。
- **伤害出口**：直接结算走 `WeaponSystem.dealDamage(weapon, enemy, amount, options)`；
  弹道走 `WeaponSystem.spawn(engine, config)` + `Projectile.onHit` 回调 +
  CollisionSystem 命中结算。**全项目只有这两个玩家侧伤害出口**，
  任何「命中后追加效果」的系统（元素印记、连击、吸血…）都应挂在这两个接缝上。
- **敌人状态**：`Enemy.takeDamage(amount, { knockback, angle, critical, stun, silent, ignoreArmor })`、
  `applyBurn(dps, duration)`、`applySlow(mult, duration)`。
- **升级卡契约**：`{ kind, id, name, icon, rarity, weight, tag, desc(ctx), apply(ctx) }`，
  由 `UpgradeSystem.buildPool()` 组装、`roll()` 按权重抽取。
- **事件**：`engine.events`（EventBus）。已有 `player:levelup / player:died / upgrade:applied /
  boss:qte:* / fusion:reaction / fusion:performed` 等，供音效、连击、HUD 弱耦合订阅。

## 3. 元素融合武器系统（Round 2）

> 完整规范：`.agent_workspace/ROUND2_FUSION_SPEC.md`
> 代码：`js/systems/ElementFusion.js` · 数据：`js/data/fusion-weapons.json`
> 测试：`tests/element-fusion.test.js`

### 3.1 三层模型

```
基础武器(带元素) ──命中──▶ 元素印记(可叠层/限时) ──跨元素命中──▶ 元素反应(10 种)
        │                                                            ▲
        └── 双源达到解锁等级 ──▶ 融合武器(10 把) ── 自带双元素，持续自触发反应 ┘
```

1. **元素印记**：五元素 `fire/frost/volt/venom/light`（火/冰/雷/毒/光）。
   六把基础武器映射：火焰喷射=火、霜爆=冰、闪电链=雷、飞刀环绕=毒（淬毒刃）、
   魔法弹=光（秘光弹）、回旋蛋镖=无元素（纯物理，不参与融合）。
   印记存放在 `ElementFusion.marks: Map<Enemy, state>`，**不改 Enemy 类**；
   只有毒印记自带按层数结算的 DoT，其余元素的价值全部在反应里。
2. **元素反应**：C(5,2)=10 个元素对各对应一条反应（蒸发/超载/爆燃/圣焰/超导/
   脆化/折射/感电扩散/闪耀/净化）。按「敌人 × 元素对」独立冷却；
   反应造成的伤害与扩散印记均标记 `noReact`，从机制上杜绝反应递归连锁。
3. **融合武器**：某元素对的两把源武器都达到 `unlockLevel`(5) 后，
   三选一出现传说融合卡；选择后吞掉两把源武器（净腾出 1 槽），
   换取该元素对专属的融合武器（共 10 把，`maxLevel` 6，
   源武器超出解锁线的等级按 `carryover` 折算成起始等级）。

### 3.2 无侵入接入（对 Round 1 代码零改动）

融合系统的全部接入点都是**运行时装饰**，幂等（`__fusionHooks` 标记）、只包一层：

| 接缝 | 装饰对象 | 用途 |
|---|---|---|
| 命中(直接) | `weapons.dealDamage` | 结算后按武器元素挂印记、查反应表 |
| 命中(弹道) | `weapons.spawn` | 给带元素武器的弹道链上 `onHit` → 挂印记 |
| 卡池 | `upgrades.buildPool` | 把可用融合卡按权重混入（尊重 banish） |
| 保底 | `upgrades.roll` | `guaranteeCard` 开启时，有可用融合必出一张融合卡 |

**注册表策略**：融合武器定义写入 `WeaponSystem.WEAPONS`，但 `WeaponSystem.IDS`
是加载期快照、不包含它们——因此升级卡/HUD/伤害统计走现有管线全部自动兼容，
而「新武器」卡池永远抽不到融合武器。这是本系统最重要的架构决策：
**复用而不修改**。

**装配**：`index.html` 引入 `js/systems/ElementFusion.js` 即可，脚本加载后自动轮询
`window.game` 并 `addSystem`（手动在 `main.js` 里 `addSystem(new ElementFusion())`
亦可，`engine.fusion` 幂等标记防止重复装配）。Round 2 阶段有并行任务在改
`index.html` / `main.js`，故本轮**不改这两个文件**，接线留给集成轮，
自装配机制保证接线只需一行 script 标签。

### 3.3 数据驱动与离线兜底

- `js/data/fusion-weapons.json` 是**权威调参文件**：元素表、武器→元素映射、
  印记规则、10 条反应参数、10 把融合武器（数值 + 行为原型 + 文案）。
- 项目是零构建纯静态站，`file://` 双击打开时 fetch 会被 CORS 拒绝，
  因此 `ElementFusion.js` 内嵌同版本快照 `DEFAULT_CONFIG` 作兜底；
  http 环境下启动后 fetch JSON 并深合并热更新。
- 双源漂移由 `tests/element-fusion.test.js` 的逐字段一致性断言强制拦截。

### 3.4 行为原型库

10 把融合武器由 8 个参数化**行为原型**生成（`ARCHETYPES`），
每个原型实现 `init/fire/tick/render` 的子集，数值全部读武器 `stats`：

| 原型 | 融合武器 | 行为 |
|---|---|---|
| `nova` | 日冕新星 | 以玩家为中心的爆发环 |
| `aura` | 超导力场 | 常驻力场：持续减速 + 周期电弧（无冷却纯 tick 武器） |
| `orbitals` | 凛冬荆棘 | 环绕体（飞刀环绕的融合版，独立命中冷却） |
| `beam` | 极光棱镜 | 旋转射线，线段投影命中 |
| `strike` | 等离子风暴 / 天雷裁决 | 预警圈 + 天降轰击，`targeting: cluster/strongest` |
| `zone` | 蒸汽奇点 / 硫磺瘟疫 | 地面区域，`zoneStyle: vortex(游走+牵引)/pool(定点毒沼)` |
| `chainStrike` | 腐电蛛网 | 连锁弹射 |
| `seekerSwarm` | 辉光瘟疫 | 追踪弹群（复用 Projectile，`kind:'orb'`） |

新增融合武器 = JSON 里加一条配置（复用原型）或在 `ARCHETYPES` 加一个新原型，
不需要动系统本体。

### 3.5 性能与安全护栏

- 印记表每 0.5s 清扫过期/死亡条目，`reset()` 全清，无跨局泄漏；
- 反应按敌人 × 元素对冷却 + 每次命中至多 1 次反应（`maxReactionsPerHit`）；
- 反应伤害不挂新印记（`noReact`），无递归；
- 印记指示点渲染做视锥裁剪，战场超过 400 个被标记敌人时整体跳过；
- 所有对 `engine.audio / hud / particles` 的调用都判空，与并行落地的
  AudioManager 等系统互不阻塞（音效名与配方表对齐：`nova/zap/shoot/crit/fuse`）。

### 3.6 已知取舍

- Round 1 的 `dealDamage` 存在「rollDamage 已乘增伤、dealDamage 再乘一次」的
  双重增伤惯例；融合原型全部显式传 `preMultiplied: true` 走单倍语义。
  建议 Round 3 统一基础武器的调用口径（见规范 §9）。
- 反应伤害经 `enemy.takeDamage` 直接结算，计入 `weapons.totalDamage`
  与 `fusion.stats.reactionDamage`，但不归属到单把武器的伤害统计。
