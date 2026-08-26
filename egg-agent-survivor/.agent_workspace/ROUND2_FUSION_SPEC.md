# Round 2 · 元素融合武器系统规范

- 代码：`js/systems/ElementFusion.js`（系统本体 + 反应处理器 + 行为原型库）
- 数据：`js/data/fusion-weapons.json`（权威调参文件）
- 测试：`tests/element-fusion.test.js`（9 项，含数据/运行时双层契约）
- 全局视图：`.agent_workspace/ARCHITECTURE.md` §3

## 1. 目标与范围

在 Round 1 的六武器构筑之上增加中后期的**构筑纵深**与**高光时刻**：

1. 元素印记 + 元素反应：让武器搭配产生即时化学反应（组合优于堆叠）；
2. 融合武器：把「双武器投资」兑换成一次不可逆的强力升级，同时腾出一个武器槽，
   给 10 分钟后的构筑留出决策空间；
3. 全程数据驱动：数值、文案、解锁规则都在 JSON 中，调参不触碰代码；
4. 对 Round 1 代码**零改动**接入（并行轮次在改共享文件，避免合并冲突）。

不在本轮范围：音效资产（仅留调用点）、连击/Fever 联动（仅留事件）、
反应的敌方 AI 应对、存档/元进度。

## 2. 元素体系

### 2.1 五元素与基础武器映射

| 元素 | id | 主题色 | 基础武器 | 定位 |
|---|---|---|---|---|
| 火 | `fire` | `#ff8a3d` | 火焰喷射 | 灼烧 DoT |
| 冰 | `frost` | `#7fd8ff` | 霜爆冲击 | 减速与控制 |
| 雷 | `volt` | `#ffe86b` | 闪电链 | 弹射与眩晕 |
| 毒 | `venom` | `#9dff57` | 飞刀环绕（淬毒刃） | 可叠层毒蚀 |
| 光 | `light` | `#fff3c4` | 魔法弹（秘光弹） | 增幅与净化 |
| — | `null` | — | 回旋蛋镖 | 纯物理，不参与融合 |

映射存于 JSON `weaponElements`，通过 `def.element` 打标（不覆盖已有值，
未来新基础武器可在自身定义里直接声明元素）。

### 2.2 印记（Mark）

- 存储：`ElementFusion.marks: Map<Enemy, { elements, cooldowns, venomTick }>`，
  敌人对象作键，**不修改 Enemy 类**；死亡/过期由 0.5s 周期清扫与 `reset()` 回收。
- 规则（JSON `marks`）：默认持续 4s、上限 3 层，重复命中刷新时限；
  毒特化为 5s / 8 层，且每 0.5s 造成 `层数 × 3 × power` 的静默 DoT。
- 施加：武器命中 → 挂 1 层该武器元素。融合武器按 `applies` 策略：
  `alternate` 逐次命中交替挂两元素（默认）；`both` 每次命中同时挂两元素
  （自触发型武器：超导力场、天雷裁决）。
- 反应产物挂印记必须走 `applyMark(..., { noReact: true })`。

### 2.3 反应表（10 条，键 = 字典序元素对）

`power = 玩家增伤 × (1 + 局内分钟数 × growthPerMinute)`，所有反应伤害乘 power。

| 键 | 反应 | 效果概要 | 关键参数 | 消耗 |
|---|---|---|---|---|
| `fire+frost` | 蒸发 | 即时爆裂：`30 + min(5%最大生命, 120)`，60% 溅射(r90) | cd 1.0 | 火1 冰1 |
| `fire+volt` | 超载 | 0.45s 引信后爆炸：46，r110，强击退（位置跟随目标） | cd 1.2 | 火1 雷1 |
| `fire+venom` | 爆燃 | 引爆全部毒层：`16 × 层数`，40% 溅射(r70) | cd 1.4 | 火1 毒全部 |
| `fire+light` | 圣焰 | 即时 34（必暴显示），灼烧 dps ×1.6 续 3s | cd 1.2 | 火1 光1 |
| `frost+volt` | 超导 | 即时 36 + 减速至 30% 持续 3s + 眩晕 0.35s | cd 1.0 | 冰1 雷1 |
| `frost+venom` | 脆化 | 40（目标被减速则 ×1.5），50% 溅射(r80) | cd 1.2 | 冰1 毒2 |
| `frost+light` | 折射 | 光束跳向 ≤3 个 220 内敌人：各 30，并扩散 1 层冰 | cd 1.1 | 冰1 光1 |
| `venom+volt` | 感电扩散 | 把毒层复制给 ≤4 个 180 内敌人，各附 18 电伤 | cd 1.5 | 雷1 |
| `light+volt` | 闪耀 | r130 眩晕闪光：中心 24、周围半额，眩晕 0.7s | cd 1.6 | 光1 雷1 |
| `light+venom` | 净化 | 焚净毒层：`12 × 层数`，玩家回复 `min(8, 层数×1)` | cd 1.4 | 光1 毒全部 |

触发规则：
1. 元素 B 命中带有元素 A(≠B) 印记的敌人时查表；
2. 冷却粒度 = 敌人 × 元素对（`state.cooldowns[pairKey]`）；
3. 每次命中至多触发 `maxReactionsPerHit`(1) 条反应，先到先得；
4. 反应结算 → 按 `consume` 消耗印记 → 飘反应名 → `fusion:reaction` 事件。

## 3. 融合武器

### 3.1 解锁与执行

- **检测**（`availableFusions()`）：对每把未持有的融合武器，其两个元素各能找到
  一把等级 ≥ `unlockLevel`(5) 的非融合源武器（同元素多把时取最高级）即为候选；
  已持有 `maxFusionWeapons`(2) 把融合武器时不再出新候选。
- **入口**：升级三选一。融合卡为传说稀有度、权重 60；`guaranteeCard` 开启时
  只要有候选且本次未抽中，强制替换三选一的末位（融合是构筑高光，不容许被
  5% 传说权重埋没）。banish（右键消除）对融合卡同样生效。
- **执行**（`performFusion(id)`）：
  1. 吞掉两把源武器（武器数 -2 +1，净腾出 1 槽）；
  2. 融合武器起始等级 = `1 + floor(双源超出解锁线的等级和 × carryover(0.5))`
     （例：火 8 + 冰 6 → 1 + floor((3+1)×0.5) = 3 级）；
  3. 继承双源的伤害统计（结算面板不断档）；
  4. 演出：双色冲击波 + hitStop + 震屏 + `fuse` 音效 + HUD 横幅 +
     `fusion:performed` 事件。

### 3.2 十把融合武器（maxLevel 6）

| id | 名称 | 元素 | 原型 | 机制一句话 |
|---|---|---|---|---|
| `steamVortex` | 蒸汽奇点 | 火冰 | zone(vortex) | 游走涡旋，牵引 + 持续蒸灼，自触发蒸发 |
| `plasmaStorm` | 等离子风暴 | 火雷 | strike(cluster) | 怪群头顶连环轰击，自触发超载 |
| `brimstonePlague` | 硫磺瘟疫 | 火毒 | zone(pool) | 敌人脚下毒沼，叠毒 + 自触发爆燃 |
| `coronaNova` | 日冕新星 | 火光 | nova | 大半径爆发环，自触发圣焰 |
| `superconductorField` | 超导力场 | 冰雷 | aura | 常驻减速力场 + 周期电弧（applies:both） |
| `wintersting` | 凛冬荆棘 | 冰毒 | orbitals | 淬毒冰棘环绕，自触发脆化 |
| `auroraPrism` | 极光棱镜 | 冰光 | beam | 旋转射线，自触发折射 |
| `venomGrid` | 腐电蛛网 | 毒雷 | chainStrike | 毒电弧弹射，自触发感电扩散 |
| `judgement` | 天雷裁决 | 光雷 | strike(strongest) | 轰击最强之敌 + 大范围眩晕（applies:both） |
| `sanctifiedBlight` | 辉光瘟疫 | 光毒 | seekerSwarm | 追踪孢子群，自触发净化回血 |

数值基线（Lv1，完整表见 JSON）按「融合武器 ≈ 1.5~1.9 × 单把满级源武器的有效 DPS，
再加上反应收益」预算：它吃掉了两把武器的全部投资，且解锁点在 8~12 分钟档，
必须显著强于继续平铺升级才成立。融合等级成长复用 `base + perLevel × (level-1)`。

### 3.3 与元素对的对应关系约束

融合武器 ↔ 元素对是**双射**：10 把武器恰好覆盖 10 个元素对，一对一把。
该约束由测试强制（新元素对必须先补反应，再补融合武器）。

## 4. 数据规范（fusion-weapons.json）

```
meta            { version, doc, note }          版本与同步须知
elements        { id: { name, color, icon, desc } }
weaponElements  { 基础武器 id: 元素 id | null }
marks           { duration, maxStacks, perElement: { venom: { duration, maxStacks, dps, tick } } }
fusion          { unlockLevel, carryover, maxFusionWeapons, cardWeight, cardRarity,
                  guaranteeCard, reactionCooldown, growthPerMinute, maxReactionsPerHit }
reactions       { "a+b"(字典序): { id, name, icon, color, cooldown, consume, ...调参字段 } }
weapons         { id: { name, icon, elements[2], archetype, targeting?, zoneStyle?, applies?,
                  desc, maxLevel, base, perLevel, levelText[maxLevel+1] } }
```

加载策略（零构建约束下的双层配置）：

1. `ElementFusion.js` 内嵌 `DEFAULT_CONFIG` 快照 → `file://` 与 Node 测试环境直接可用；
2. http 环境下 `onAdd` 时 fetch JSON，`deepMerge` 热合并（对象递归、数组整体替换、
   null 保留原值），随后原地同步武器定义并 `recalcAll()`；
3. **同步纪律**：改 JSON 必须同步快照，`tests/element-fusion.test.js` 第 1 项做
   逐字段一致性断言，漂移即红。

## 5. 运行时架构

```
                    ┌────────────────────────────────────────────┐
                    │                ElementFusion                │
 WeaponSystem       │  marks: Map<Enemy, {elements,cooldowns}>   │
 ┌──────────────┐   │  effects: [超载引信…]   arcs: [反应视觉]     │
 │ dealDamage ──┼──▶│ _onWeaponHit → applyMark → _checkReactions │
 │ spawn(onHit)─┼──▶│      │                        │            │
 └──────────────┘   │      ▼                        ▼            │
 UpgradeSystem      │  REACTIONS[id] 处理器    _consumeMarks      │
 ┌──────────────┐   │      │                                     │
 │ buildPool  ◀─┼───┤ buildFusionCards / roll 保底                │
 │ roll       ◀─┼───┤ performFusion → WeaponSystem.add/levelUp   │
 └──────────────┘   └────────────────────────────────────────────┘
```

### 5.1 职责划分

- `ElementFusion`（系统）：印记存储与清扫、反应调度、延迟效果（超载）、
  融合检测/执行、卡池注入、反应级视觉（印记指示点/弧线/引信环）。
- `REACTIONS`（处理器表）：每条反应一个纯函数
  `(fusion, enemy, state, cfg, power)`，只允许通过 `fusion._hit/_splash/_fx/
  applyMark(noReact)` 产生副作用。
- `ARCHETYPES`（原型库）：融合武器的行为实现，与 Round 1 武器定义同构
  （`init/fire/tick/render`，尾参数追加 `fusion`），数值全部读 `w.stats`。
- `_buildDef/_syncDef`：把 JSON 配置装配成 `WEAPONS` 注册表条目；
  热合并时原地同步字段、保留 def 引用（武器实例持有 def，不能换对象）。

### 5.2 生命周期

- `onAdd`：打元素标 → 注册融合武器 → 装饰 weapons/upgrades → fetch 外部配置。
  装饰幂等（`__fusionHooks`），系统幂等（`engine.fusion`）。
- `reset`：清空印记/延迟效果/视觉/统计。融合武器定义留在注册表（全局资源），
  `WeaponSystem.reset` 只会重配初始武器，无跨局污染。
- `update`（仅 PLAYING）：毒 DoT → 印记清扫（0.5s 节流）→ 延迟效果结算 → 视觉衰减。
- `drawWorld`：引信预警环 → 反应弧线 → 印记指示点（视锥裁剪 + 400 上限守门）。

### 5.3 事件契约（供音效/连击/HUD 订阅）

| 事件 | 载荷 | 时机 |
|---|---|---|
| `fusion:reaction` | `{ id, name, enemy }` | 每次反应触发后 |
| `fusion:performed` | `{ id, name, from: [a,b], level }` | 融合执行完成后 |

### 5.4 装配

首选（集成轮一行接线）：`index.html` 在 `UpgradeSystem.js` 之后、`main.js` 之前加
`<script src="js/systems/ElementFusion.js"></script>`；脚本加载后自动轮询
`window.game`（250ms × 40 次）并 `addSystem`。手动 `engine.addSystem(new
ElementFusion())` 亦可，两者互斥幂等。本轮因并行任务正在修改 `index.html` 与
`main.js`，接线动作明确移交集成轮，避免同文件冲突。

## 6. 性能预算

- 印记读写 O(命中数)；反应处理器内查询全部走 `engine.combat` 空间网格；
- 反应频率上限 = 敌人数 × 元素对数 / 冷却，实际由「每命中最多 1 反应 +
  逐对冷却」双重限流，500 敌压力场景下反应结算不构成新的 O(n²) 热点；
- Map 键为敌人对象，清扫路径共三条（死亡即删 / 过期 0.5s 批删 / reset 全删），
  对照 Round 1 边界报告的 P0「内存泄漏」条目；
- 渲染守门：印记点做相机可见性裁剪，>400 标记敌人时整体跳过；
  区域/光束等武器视觉数量受武器数与 `count` 上限约束。

## 7. 测试与验收

```bash
node --test tests/element-fusion.test.js   # 9 项
node --test tests/*.test.js                # 全套回归（含并行系统）
```

覆盖：快照↔JSON 一致性、反应表完备性（10 对、处理器齐备、消耗合法、键字典序）、
武器↔元素对双射与原型存在性、注册表不污染 IDS、融合检测/等级门槛/执行/槽位账、
等级结转公式、反应触发/冷却/消耗、毒叠层上限、noReact 隔离、reset 清理。

手动验收清单（集成轮接线后）：
1. 火焰喷射 + 霜爆同时命中一片怪 → 每秒一次「蒸发」飘字与蒸汽爆裂；
2. 两把源武器升到 5 级 → 下次升级三选一必出对应融合卡（传说金框）；
3. 选卡后武器槽 -1，HUD 出现融合武器图标，双色冲击波演出；
4. 融合武器持续自触发签名反应；回旋蛋镖全程不产生任何印记；
5. 重开一局后印记/反应统计归零，融合武器不残留。

## 8. 设计取舍记录

- **装饰器而非改源码**：Round 2 多任务并行改共享文件，融合系统选择运行时装饰
  `dealDamage/spawn/buildPool/roll` 四个点，代价是对这四个方法签名有隐式依赖
  （已用测试锁住），收益是零合并冲突、可独立回滚。
- **一次命中至多一反应**：三元素同挂时按印记枚举顺序先到先得，比「全部触发」
  可预测、比「优先级表」简单；若后续要做四元素构筑再引入优先级。
- **反应不挂印记**（除折射/感电的 noReact 扩散）：防递归的最简规则。
- **保底融合卡**：替换三选一末位而非扩为四选一，不动 UpgradeSystem 的 DOM 契约。
- **雷元素 id 用 `volt`**：避开 `chainBolt/magicBolt` 命名撞车。

## 9. 移交 Round 3 的事项

1. **接线**：`index.html` 加一行 script（见 §5.4），冒烟走 §7 手动清单；
2. **伤害口径统一**：Round 1 武器存在 `rollDamage`(已乘增伤) → `dealDamage`(再乘)
   的双重增伤惯例，融合原型已按单倍（`preMultiplied: true`）实现；
   建议给基础武器统一补 `preMultiplied` 并重调平衡；
3. **音效**：反应/融合当前复用 `crit/fuse/nova`，可为 10 条反应做分元素配方；
4. **连击/Fever 联动**：订阅 `fusion:reaction` 加连击分、Fever 期间反应冷却减半
   之类的耦合放 ComboSystem 侧，融合系统不反向依赖；
5. **敌人元素抗性**：`Enemy.def` 增加 `resist: { fire: 0.5 }` 后在 `_hit` 里结算，
   数据位已预留（反应伤害统一出口）；
6. **平衡校准**：用 `fusion.stats.perReaction / reactionDamage` 做局内遥测，
   对照 §3.2 的 DPS 预算复核 unlockLevel 与 carryover。
