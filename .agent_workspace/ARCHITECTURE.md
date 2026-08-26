# 蛋壳特工：元素觉醒 — 完整架构文档

> Round 1 / fable-1 产出。本文档是实现子代理（引擎、玩家、敌人、武器、UI、测试）的**接口契约**。
> 所有公共 API、事件名、数据结构以本文为准；如需变更，先更新本文再改代码。

- 项目代号：`egg-survivor`
- 游戏名：**蛋壳特工：元素觉醒**（超越「蛋壳特工队」/ Survivor.io 类）
- 分支：`agent/egg-agent-survivor`
- 目标：浏览器内 60fps、零依赖、单人 Roguelike 生存射击，15 分钟一局

---

## 1. 技术栈选型

| 维度 | 选型 | 理由 |
|------|------|------|
| 渲染 | **HTML5 Canvas 2D**（单 canvas + 分层离屏 canvas） | 500+ 实体的 2D 俯视角游戏，Canvas 2D 性能充足；WebGL 收益不抵复杂度 |
| 语言 | **原生 JavaScript (ES2020)**，无构建步骤 | 零依赖、零工具链，克隆即可运行 |
| 模块化 | **经典 `<script>` 标签 + 全局命名空间 `EGG`**，按依赖顺序加载 | ES Modules 在 `file://` 下被浏览器 CORS 拦截；classic script 保证**双击 index.html 直接可玩** |
| 菜单 UI | **DOM/CSS 覆盖层**（主菜单、升级三选一、结算页） | DOM 做静态 UI 比 canvas 便宜且可访问性好；战斗 HUD 走 canvas |
| 美术资源 | **零图片资源**：程序化生成精灵（离屏 canvas 预渲染） | 免资产管线；蛋形角色/几何敌人非常适合程序化绘制 |
| 音频 | **Web Audio API 程序化合成** | 零音频文件；振荡器 + 噪声 + 包络即可合成全部 SFX 与 BGM |
| 存档 | `localStorage`（JSON，带版本号与迁移） | 元进度、设置、最高纪录 |
| 随机数 | 自研 **mulberry32 可种子 RNG** | 可复现测试、每日挑战种子 |
| 测试 | 纯逻辑模块 UMD 导出 + Node 原生 `node:test` / 浏览器测试页 | 数值/融合/波次逻辑可在 Node 里无头跑 |

**被否决的备选**：Phaser/PixiJS（违反零依赖）、TypeScript（需构建）、ES Modules（file:// 不可用）、OffscreenCanvas+Worker（兼容性成本 > 收益，性能预算内不需要）。

### 零依赖运行方式

```
方式 A（推荐）：双击 index.html —— classic script 保证可行
方式 B：python3 -m http.server 8000 后访问 localhost:8000
```

### 脚本加载顺序约定（index.html 中固定）

```
core(rng→events→pool→spatial) → data/* → systems(audio→particles→input→camera→terrain)
→ entities(player→enemies→pets→projectiles) → gameplay(weapons→upgrades→combo→waves→boss)
→ ui(hud→menus) → engine → main
```

每个文件形如：

```js
(function (EGG) {
  'use strict';
  class EventBus { /* ... */ }
  EGG.EventBus = EventBus;
  // 纯逻辑模块额外加 UMD 尾巴以便 Node 测试：
  if (typeof module !== 'undefined' && module.exports) module.exports = { EventBus };
})(typeof window !== 'undefined' ? (window.EGG = window.EGG || {}) : (globalThis.EGG = globalThis.EGG || {}));
```

---

## 2. 顶层架构图

```
                         ┌─────────────────────────────┐
                         │        main.js (启动)        │
                         └──────────────┬──────────────┘
                                        ▼
┌───────────────────────────────────────────────────────────────────┐
│  GameEngine  (游戏循环 / 状态机 / 系统注册表 / timeScale)            │
│  states: BOOT→MENU→PLAYING⇄LEVELUP⇄PAUSED→BOSS_INTRO→GAMEOVER/WIN │
└──────┬──────────────────────┬─────────────────────────┬───────────┘
       │ update(dt)           │ render(ctx)             │
       ▼                      ▼                          ▼
┌────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│  EventBus  │◄──┤  Gameplay Systems     │   │  Presentation       │
│ (全局脉络)  │   │  Player / EnemyMgr    │   │  UIRenderer (HUD)   │
│            │──►│  WeaponSystem         │   │  ParticleSystem     │
│            │   │  UpgradeSystem        │   │  Camera             │
│            │   │  ComboSystem          │   │  AudioManager       │
│            │   │  WaveDirector / Boss  │   │  DOM Menus          │
│            │   │  PetSystem / Terrain  │   └─────────────────────┘
└────────────┘   └──────────┬───────────┘
                            ▼
             ┌────────────────────────────┐
             │ Core: Pool / SpatialHash /  │
             │ RNG / SaveSystem / Sprites  │
             └────────────────────────────┘
```

原则：**gameplay 系统之间不互相直接调用**，跨系统通信一律走 EventBus；同系统内部直接方法调用。Presentation 层只读游戏状态 + 订阅事件，从不改写游戏状态。

---

## 3. 游戏循环设计

**固定时间步长 + 追帧上限**，保证数值确定性（连击窗口、DoT tick、波次时刻表都依赖确定 dt）：

```js
const STEP = 1 / 60;            // 固定逻辑步长
const MAX_STEPS = 5;            // 单帧最多追 5 步，防«死亡螺旋»
let acc = 0, last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  acc += Math.min((now - last) / 1000, 0.25); last = now;
  let n = 0;
  while (acc >= STEP && n < MAX_STEPS) {
    engine.update(STEP * engine.timeScale);   // timeScale 用于慢动作/暂停
    acc -= STEP; n++;
  }
  engine.render();                            // 每帧渲染一次当前状态
}
```

- `timeScale`：升级选卡时 = 0（世界冻结但粒子/UI 用独立 uiDt 继续动）；Boss 处决慢动作 = 0.25。
- 更新顺序（每 tick 固定）：`Input → Player → PetSystem → WeaponSystem(发射) → Projectiles(移动) → EnemyManager(AI/移动) → 碰撞解析 → ComboSystem → WaveDirector → Terrain → ParticleSystem → Camera → EventBus.flush()`。
- 渲染与逻辑分离：`render()` 不修改任何游戏状态。

---

## 4. 实体与组件模型（池化轻量 ECS）

不用完整 ECS（vanilla JS 下调度开销和复杂度不划算），采用 **「类型化对象池 + 能力字段」**：

- 每类实体（enemy / projectile / particle / pickup / pet）一个 **预分配对象池**（`core/pool.js`），杜绝战斗中 GC。
- 实体是扁平对象，字段即组件；系统按池遍历，不做动态组件查询：

```js
// 敌人池对象示例（字段即“组件”）
{ active, x, y, vx, vy, radius,                  // Transform + Physics
  hp, maxHp, touchDamage, armor,                  // Health + Combat
  typeId, tier, speed, ai,                        // Identity + Behavior
  element, statusFx: {burn, chill, shock, ...},   // 元素状态（见 §6.1）
  hitFlash, deathTimer, spriteKey }               // Presentation
```

- **SpatialHash**（`core/spatial.js`，格宽 = 96px ≈ 最大敌人直径）负责：敌人↔玩家碰撞、投射物↔敌人查询、敌人分离力（boids-lite，只查同格+邻格）。
- 池容量预算：enemies 400 / projectiles 800 / particles 1500 / pickups 300 / floatText 120。池满时按优先级淘汰（粒子淘汰最旧，敌人拒绝生成远处杂兵）。

---

## 5. 事件总线设计

`core/events.js`，单例 `EGG.bus`：

```js
bus.on(type, fn) / bus.off(type, fn) / bus.once(type, fn)
bus.emit(type, payload)        // 立即派发：输入、UI 点击
bus.queue(type, payload)       // 入队，tick 末 flush()：战斗事件，避免更新中途重入
```

### 核心事件表（实现子代理必须使用这些常量名，定义在 `core/events.js` 的 `EV` 中）

| 事件 | payload | 生产者 | 主要消费者 |
|------|---------|--------|-----------|
| `EV.ENEMY_HIT` | `{enemy, dmg, element, isCrit, srcWeapon}` | WeaponSystem | Particles, UI(伤害数字), Audio |
| `EV.ENEMY_KILLED` | `{enemy, byElement, overkill}` | EnemyManager | Combo, Pickups, Particles, WaveDirector |
| `EV.PLAYER_HURT` | `{dmg, from}` | Player | UI, Audio, Camera(shake) |
| `EV.PLAYER_LEVELUP` | `{level}` | Player | UpgradeSystem(开三选一), Audio |
| `EV.UPGRADE_PICKED` | `{option}` | UpgradeSystem | WeaponSystem/Player/PetSystem |
| `EV.WEAPON_FUSED` | `{recipe, weapon}` | WeaponSystem | UI(横幅), Audio, Particles |
| `EV.COMBO_TIER_UP` / `EV.COMBO_BREAK` | `{tier, count}` | ComboSystem | UI, Audio, Player(增益) |
| `EV.FEVER_START` / `EV.FEVER_END` | `{}` | ComboSystem | 全体（见 §6.3） |
| `EV.WAVE_STARTED` | `{waveIdx, label}` | WaveDirector | UI(波次横幅) |
| `EV.BOSS_SPAWN` / `EV.BOSS_PHASE` / `EV.BOSS_KILLED` | `{boss, phase?}` | BossController | Engine(状态), UI, Audio, Terrain |
| `EV.ELEM_REACTION` | `{kind, x, y, targets}` | StatusFx 解析器 | Particles, Audio, Combo |
| `EV.PICKUP_COLLECTED` | `{kind, value}` | Player | UI, Audio |
| `EV.TERRAIN_EVENT` | `{kind, ...}` | TerrainSystem | UI, EnemyManager |
| `EV.GAME_OVER` / `EV.VICTORY` | `{stats}` | Engine | DOM 结算页, SaveSystem |

规则：payload 是普通对象（事件量大的 `ENEMY_HIT` 等复用预分配 payload 对象）；消费者不得在 handler 里同步 emit 造成级联，需用 `queue`。

---

## 6. 模块详解（公共 API 契约）

### 6.0 GameEngine（`js/engine.js`）— opus-fast-1 负责

- 职责：RAF 循环、固定步长、状态机、系统注册与 update/render 编排、timeScale、运行统计（存活时间/击杀/DPS）。
- API：`engine.init(canvas)`, `engine.setState(s)`, `engine.state`, `engine.timeScale`, `engine.stats`, `engine.registerSystem(sys)`（sys 需实现 `update(dt)` 可选 `render(ctx, cam)` / `reset()`）。
- 状态机转移：`LEVELUP` 与 `PAUSED` 冻结 gameplay 更新但保留 UI/粒子；`BOSS_INTRO` 播 1.2s 演出后回 `PLAYING`。

### 6.1 Player（`js/entities/player.js`）— opus-fast-1 负责

- 职责：移动（加速度+阻尼）、HP/护盾、无敌帧（受击后 0.6s）、XP 与升级曲线、拾取磁吸半径、角色被动、统计快照。
- 核心数据 `player.stats`（升级系统直接读写的**唯一**属性入口）：
  `{maxHp, regen, moveSpeed, might(伤害%), area(范围%), cooldown(冷却%), amount(+投射物), magnet, armor, critChance, critMult, xpGain}`
- XP 曲线：`xpToNext(lv) = 5 + 10*lv + 3*lv^2`（前期快后期缓，15 分钟约 30 级）。
- API：`player.gainXp(n)`, `player.hurt(dmg, src)`, `player.heal(n)`, `player.applyCharacter(charDef)`。

### 6.2 EnemyManager（`js/entities/enemies.js` + `js/gameplay/waves.js`）— opus-fast-2 负责

- 职责：敌人池、生成（屏幕外环形随机点，半径 = 视口对角线 × 0.6）、AI（追踪/冲锋/远程/环绕/分裂）、分离力、接触伤害、死亡→掉落与事件。
- **WaveDirector**（数据驱动，读 `data/waves.js`）：按游戏时钟推进波次时间轴；维护「压力预算」：`budget(t) = base + t*ramp`，每 tick 用预算购买敌人（不同敌人有 cost），保证难度平滑且可调。
- 精英规则：每 60s 生成 1 只精英（随机词缀：加速/分裂/护盾/元素抗性），必掉宝箱。
- API：`enemies.spawn(typeId, x, y, mods)`, `enemies.nearest(x,y,r)`, `enemies.queryCircle(x,y,r,out)`, `enemies.forEachActive(fn)`, `enemies.aliveCount`。

### 6.3 WeaponSystem（`js/gameplay/weapons.js` + `js/entities/projectiles.js`）— opus-fast-2 负责

- 职责：6 武器槽 + 6 被动槽；每武器实例 `{defId, level, cooldownTimer, element}`；发射模式由 `data/weapons.js` 声明（pattern: `aimed | nearest | orbit | aura | boomerang | mine | beam | chain`）。
- **伤害管线**（纯函数，`js/gameplay/damage.js`，必须 UMD 导出供测试）：

```
finalDmg = base × level系数 × (1+might) × 元素克制 × 连击加成 × crit? critMult : 1
→ 应用元素上状态（burn/chill/shock/poison/void 层数）
→ 检查融合反应（§7.1 反应表）→ queue(EV.ELEM_REACTION)
```

- 命中判定：投射物每 tick 在 SpatialHash 查半径；穿透计数、命中冷却（同目标 0.2s）防多帧重复伤害。
- API：`weapons.addWeapon(defId)`, `weapons.levelUp(defId)`, `weapons.tryFuse()`, `weapons.slots`, `weapons.getDps()`。

### 6.4 UpgradeSystem（`js/gameplay/upgrades.js`）— opus-fast-2 负责

- 职责：升级时生成 **3 选 1**（含权重：新武器 / 武器升级 / 被动 / 稀有度 common 60% : rare 30% : epic 10%）；融合配方达成时置顶金色「融合卡」；重掷(每局2次)与放逐(每局1次)。
- 选项生成规则：已满级条目不出现；槽满后只出已持有条目；宝箱 = 免费随机升级 ×1~3。
- API：`upgrades.rollOptions(n=3)`, `upgrades.apply(option)`, `upgrades.reroll()`, `upgrades.banish(option)`。纯逻辑部分（权重抽样、去重、融合检测）UMD 导出。

### 6.5 UIRenderer（`js/ui/hud.js` + `js/ui/menus.js`）— R2 打磨，R1 出可用版

- Canvas HUD：HP/护盾条、XP 条（顶部通栏）、计时器、击杀数、金币、**连击计数器与热度环**（§7.3）、武器/被动图标栏、Boss 血条、伤害数字（对象池、上飘淡出、暴击放大变色）。
- DOM 层：主菜单/角色选择、三选一升级卡（CSS 动画翻入）、暂停、结算统计（DPS 图、击杀构成）。
- 约定：HUD 只读 `engine.stats / player / combo` 快照 + 订阅事件；DOM 菜单通过 `bus.emit(EV.UI_*)` 与引擎通信。

### 6.6 ParticleSystem（`js/systems/particles.js`）

- 池化粒子 `{x,y,vx,vy,life,size,color,drag,gravity,fade,glow}`；预设发射器：`hitSpark, deathBurst(按敌人色), levelUpRing, fusionNova, elemTrail(每元素), pickupTwinkle, bossTelegraph`。
- 附带「juice 服务」：屏幕震动（Camera trauma 衰减模型）、命中闪白（实体 hitFlash 计时）、命中停顿（hitStop ≤ 3 帧）。
- API：`particles.emit(preset, x, y, opts)`, `particles.setQuality(0..2)`（自动降质：fps < 50 时降一档）。

### 6.7 AudioManager（`js/systems/audio.js`）

- 全程序化合成：`shoot(方波+快速衰减)`, `hit(噪声burst)`, `explode(低频正弦+噪声)`, `levelup(琶音)`, `fuse(上滑合唱)`, `combo(音高随tier上升)`, `hurt`, `pickup`。
- 结构：`master → {sfxBus, musicBus}` 增益节点；BGM 为 4 小节程序化循环（小调五声音阶随机琶音 + 底鼓），Boss 战切换到高速模式；同类 SFX 20ms 节流防爆音。
- API：`audio.play(name, {pitch, vol})`, `audio.setMusic(mode)`, `audio.toggleMute()`。首次用户手势后 `resume()`（浏览器自动播放策略）。

### 6.8 支撑模块

| 模块 | 文件 | 要点 |
|------|------|------|
| Input | `js/systems/input.js` | WASD/方向键 + 手柄(可选) + **移动端虚拟摇杆**（触摸落点为原点）；输出归一化 `{mx, my}` |
| Camera | `js/systems/camera.js` | 平滑跟随(lerp 0.12) + trauma 抖动 + 视口剔除辅助 `cam.isVisible(x,y,r)` |
| TerrainSystem | `js/systems/terrain.js` | §7.4；静态障碍烘焙进背景离屏层 |
| PetSystem | `js/entities/pets.js` | §7.5 |
| ComboSystem | `js/gameplay/combo.js` | §7.3；纯逻辑 UMD 导出 |
| BossController | `js/gameplay/boss.js` | §7.2 |
| SaveSystem | `js/core/save.js` | `{version, coins, metaUpgrades, unlocks, bestStats, settings}`，写入节流 1s |
| Sprites | `js/systems/sprites.js` | 程序化画蛋形特工/几何敌人/武器图标 → 离屏 canvas 缓存，key = `type:variant:size` |

---

## 7. 五大差异化玩法（超越蛋壳特工队的核心设计）

### 7.1 元素融合武器（Elemental Fusion）

蛋壳特工队的武器进化是「武器+被动=固定进化」；我们升级为**元素反应 + 自由融合**双层系统：

- 五元素：🔥火 / ❄冰 / ⚡电 / ☠毒 / 🌀虚空。每把武器带元素，命中叠加元素状态层数。
- **反应表**（两种元素状态在同一敌人身上共存时触发，消耗层数）：

| 反应 | 组合 | 效果 |
|------|------|------|
| 蒸汽爆 | 火+冰 | AoE 爆炸 180% 伤害 + 击退 |
| 超导 | 冰+电 | 目标 -50% 护甲 4s，电弧跳 3 个目标 |
| 感电燃烧 | 火+电 | DoT 翻倍并扩散到 120px 内敌人 |
| 瘟疫引爆 | 毒+任意 | 死亡时毒云（继承 30% 伤害/秒 ×3s） |
| 虚空吞噬 | 虚空+任意 | 生成 1.5s 黑洞吸怪（CD 8s） |

- **武器融合**：两把满级(Lv5)不同元素武器 + 对应被动 → 融合成 12 种终极武器之一（见 GAME_DESIGN §4.3），继承双元素，反应触发率 100%。
- 实现落点：状态层数存于敌人 `statusFx`；反应检测在伤害管线尾部（纯函数，可测）；融合配方在 `data/fusion.js` 声明式定义。

### 7.2 Boss 阶段机制（Phase Bosses）

竞品 Boss = 大号精英；我们做**三阶段演出型 Boss**（每 5 分钟一只，共 3 只）：

- 每阶段（100%→65%→30% HP）切换技能组 + 场地变化；阶段转换时 1s 无敌 + 吼叫击退 + 场地事件（掉落岩浆带/冰墙合围）。
- 技能全部**预警后摇**（红色 telegraph 图形 0.8s 后生效），可走位躲避 —— 把«割草»升级为«弹幕舞蹈»。
- 血量 ≤5% 触发**处决 QTE**：全屏慢动作(timeScale 0.25) 2s，冲进 Boss 圈内触发处决 → 额外掉落；超时 Boss 回 10% 血。
- 实现落点：`BossController` 持 `{phaseIdx, pattern queue, telegraphs[]}`；telegraph 是数据对象由 Particles/HUD 渲染；场地事件走 `EV.TERRAIN_EVENT`。

### 7.3 连击奖励（Combo & Fever）

竞品无连击概念；我们加入**连击驱动的风险收益循环**：

- 击杀 +1 连击，2.5s 无击杀则断（受击立即断）；窗口随 tier 递减（T4 后 1.8s）→ 逼玩家往怪堆里走。
- 连击层级：T1(25) +5% 伤害 → T2(60) +10% 伤害+5% 移速 → T3(120) +15% 伤害+磁吸×1.5 → T4(200) +20% 伤害+10% 冷却。
- **Fever 模式**：连击 300 触发 8s 狂热——攻速 ×1.5、无限穿透、金币双倍、画面边缘火焰滤镜；结束后连击归 150。
- 断连惩罚轻（只清增益不扣资源），保持爽快基调。实现为纯逻辑状态机（`combo.js`），增益通过读 `combo.buffs` 由伤害管线/Player 消费。

### 7.4 地形障碍与场地事件（Living Arena）

竞品是空旷平地；我们的 3200×3200 竞技场是**活的**：

- 静态障碍：岩石(阻挡+可躲投射物)、可破坏蛋箱(15 HP，掉资源)、减速沼泽、加速导轨。
- **动态场地事件**（每 90s 随机一个，提前 3s 全屏预告）：
  - 陨石雨：8 处 telegraph 圈轰炸（伤敌也伤己）
  - 毒雾潮汐：地图一半覆毒雾 20s，逼迫转移阵地
  - 补给空投：远处落下高级宝箱，被 1 圈精英守卫
  - 电磁风暴：全场敌人获得 shock 层 → 配合电武器触发全屏超导
- 障碍参与战术：敌人寻路绕障碍（简单力场避障，不做 A*），玩家可«卡口»；虚空黑洞可把敌人吸到岩浆带借地形杀（触发 `环境击杀` 连击 ×2）。
- 实现落点：障碍是静态圆/矩形碰撞体列表（烘焙渲染）；事件由 `TerrainSystem` 调度，复用 telegraph 与粒子管线。

### 7.5 宠物协同（Pet Synergy）

竞品宠物只会自动攻击；我们做**元素协同宠物**：

- 每局可携 1 只（升级卡池可抽到第 2 只），宠物有元素属性 + 主动技（CD 制）+ 协同被动：
  - 焰羽小鸡🔥：喷火锥；协同 = 玩家火武器命中时 15% 概率点燃
  - 冰壳龟❄：冰环护盾挡 3 次弹；协同 = 受击时冻结周围 1s
  - 雷雀⚡：链电啄击；协同 = 玩家暴击时释放电弧
  - 毒液史莱姆☠：走位留毒径；协同 = 毒层数上限 +2
  - 虚空猫🌀：每 20s 吸一次小黑洞；协同 = 虚空反应 CD -25%
- **宠物-武器共鸣**：宠物元素与任一武器元素相同 → 该元素反应伤害 +30%，宠物体型进化（视觉反馈）。
- 宠物不可死亡（HP 归零休眠 10s），AI = 环绕玩家 + 索敌冲出 + 归位三状态机。

---

## 8. 渲染管线与性能预算

### 分层渲染（单主 canvas，逻辑分层）

```
L0 背景层: 预烘焙离屏 canvas（地面纹理+静态障碍），按 camera 偏移 drawImage 一次
L1 地表层: 沼泽/毒雾/telegraph（半透明形状）
L2 实体层: pickups → 敌人(按 y 排序可选) → 宠物 → 玩家 → 投射物
L3 特效层: 粒子（additive: glow 粒子用 globalCompositeOperation='lighter'）
L4 HUD 层: canvas HUD（伤害数字、血条、连击环）
DOM 层  : 菜单/升级卡/结算
```

### 性能预算（1080p / 中端机 60fps）

| 项 | 预算 | 手段 |
|----|------|------|
| 活跃敌人 | ≤ 300 | 池化、屏外 AI 降频(每 4 tick)、拒绝生成 |
| 投射物 | ≤ 500 | 池化、命中冷却、寿命上限 |
| 粒子 | ≤ 1200 | 池化、自动降质 3 档 |
| 碰撞查询 | O(n) 均摊 | SpatialHash 96px 格 |
| GC | 战斗中 0 分配 | 池 + 复用 payload/输出数组（`queryCircle(x,y,r,out)` 模式）|
| 绘制 | ≤ 900 draw call | 预渲染精灵 drawImage（禁 per-entity path 绘制）、视口剔除 |

帧率监控：`engine.stats.fps` 滚动平均；<50 触发粒子降质，<40 减少屏外敌人上限 20%。

---

## 9. 数据驱动内容层

所有内容与数值集中在 `js/data/*.js`，纯声明对象、无逻辑，策划调数值不碰系统代码：

```js
// data/weapons.js 示例
EGG.DATA.weapons.fireWand = {
  id: 'fireWand', name: '燃焰法杖', element: 'fire', pattern: 'nearest',
  base: { dmg: 12, cd: 1.1, speed: 420, pierce: 1, count: 1, area: 1 },
  perLevel: [ {dmg:+4}, {count:+1}, {cd:-0.15}, {dmg:+6, pierce:+1} ],  // Lv2..Lv5
  maxLevel: 5, evolvesWith: 'passive.magma', fusionTag: 'fire'
};
```

同构文件：`characters.js / weapons.js / passives.js 
/ enemies.js / waves.js / bosses.js / pets.js / fusion.js / terrain.js / meta.js`。
数值基线见 GAME_DESIGN §16。

---

## 10. 测试与质量策略（与 gpt-sol-2 的契约)

- **可无头测试的纯逻辑模块**（必须 UMD 导出、不 touch DOM/canvas）：
  `damage.js`（伤害管线+反应表）、`combo.js`、`upgrades.js` 的抽样逻辑、`waves.js` 的预算调度、`core/rng.js`、`core/pool.js`、`core/spatial.js`、`core/save.js` 迁移。
- Node 侧：`tests/*.test.js` 用 `node --test` 跑；浏览器侧：`tests/browser.html` 冒烟页（引擎 boot 300 tick 无异常 + 池不泄漏断言）。
- 不变量断言（DEBUG 模式启用）：池 active 数 ≤ 容量；敌人 hp ≤ maxHp；事件队列单 tick flush 后为空；timeScale∈[0,1]。
- 性能烟测：脚本注入 300 敌 + 500 弹跑 10s，平均帧时长 < 16.6ms 记为通过。

---

## 11. 文件结构树

```
/workspace
├── index.html                     # 入口：canvas + DOM 覆盖层 + 按序 <script> 标签
├── style.css                      # DOM 菜单/升级卡/结算样式（含 CSS 动画）
├── README.md                      # 运行说明 / 操作说明 / 架构索引
├── js/
│   ├── main.js                    # 启动：建 canvas、init 引擎、绑首次手势解锁音频
│   ├── engine.js                  # GameEngine：循环/状态机/系统编排        [opus-fast-1]
│   ├── core/
│   │   ├── events.js              # EventBus + EV 常量表（本文 §5）
│   │   ├── rng.js                 # mulberry32 种子随机                     [UMD]
│   │   ├── pool.js                # 通用对象池                              [UMD]
│   │   ├── spatial.js             # SpatialHash                             [UMD]
│   │   └── save.js                # localStorage 存档 + 版本迁移            [UMD]
│   ├── data/                      # ★ 全部数值/内容配置（§9）
│   │   ├── characters.js  ├── weapons.js   ├── passives.js
│   │   ├── enemies.js     ├── waves.js     ├── bosses.js
│   │   ├── pets.js        ├── fusion.js    ├── terrain.js
│   │   └── meta.js
│   ├── systems/
│   │   ├── input.js               # 键盘/触摸摇杆/手柄
│   │   ├── camera.js              # 跟随 + trauma 震动 + 剔除
│   │   ├── sprites.js             # 程序化精灵工厂（离屏缓存）
│   │   ├── particles.js           # ParticleSystem + juice（§6.6）
│   │   ├── audio.js               # AudioManager 合成音频（§6.7）
│   │   └── terrain.js             # 障碍/场地事件（§7.4）
│   ├── entities/
│   │   ├── player.js              # Player（§6.1）                          [opus-fast-1]
│   │   ├── enemies.js             # EnemyManager（§6.2）                    [opus-fast-2]
│   │   ├── projectiles.js         # 投射物池 + 运动模式                     [opus-fast-2]
│   │   ├── pickups.js             # XP 宝石/金币/宝箱/磁铁/血包
│   │   └── pets.js                # PetSystem（§7.5）
│   ├── gameplay/
│   │   ├── damage.js              # 伤害管线 + 元素反应（§7.1）             [UMD]
│   │   ├── weapons.js             # WeaponSystem（§6.3）                    [opus-fast-2]
│   │   ├── upgrades.js            # UpgradeSystem 三选一（§6.4）            [UMD 部分]
│   │   ├── combo.js               # 连击/Fever（§7.3）                      [UMD]
│   │   ├── waves.js               # WaveDirector 压力预算（§6.2）           [UMD 部分]
│   │   └── boss.js                # BossController 阶段机（§7.2）
│   └── ui/
│       ├── hud.js                 # Canvas HUD（§6.5）
│       └── menus.js               # DOM 菜单/升级卡/结算
├── tests/
│   ├── run.sh                     # node --test tests/
│   ├── damage.test.js  ├── combo.test.js  ├── upgrades.test.js
│   ├── waves.test.js   ├── core.test.js
│   └── browser.html               # 浏览器冒烟测试页
└── .agent_workspace/              # 多代理协作文档（本目录）
    ├── PROGRESS.md  ├── ARCHITECTURE.md  └── GAME_DESIGN.md
```

---

## 12. 实现顺序建议（R1 剩余工作切分）

1. **opus-fast-1**：`core/*` → `engine.js` → `input/camera/sprites` → `player.js` → 最小 HUD。验收：蛋在地图上跑、有 XP 条。
2. **opus-fast-2**：`data/*` 骨架 → `enemies + waves` → `projectiles + weapons + damage` → `upgrades`。验收：能打完 3 分钟并升 5 级。
3. 两者并行的接缝就是本文的事件表(§5)与 `player.stats`(§6.1)、池 API(§4)。
4. R1 收尾集成：particles / audio / combo 最小版接入；terrain / pets / boss 允许留到 R2 但**接口按本文预留**。

> 冲突仲裁原则：接口以本文为准；数值以 GAME_DESIGN.md §16 为准；两文档冲突时以 ARCHITECTURE 的接口 + GAME_DESIGN 的数值为准。
