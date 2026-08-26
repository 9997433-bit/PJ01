# Egg Agent Survivor — 多子代理 3 轮循环进度

## Goal
打造超越「蛋壳特工队」(Survivor.io 类) 的 Roguelike 生存射击游戏：更好界面、更有趣玩法。

## Branch
`agent/egg-agent-survivor`

## Round Status

| Round | Status | Summary |
|-------|--------|---------|
| R1 | 🔄 IN_PROGRESS | 初始构建与基线探索 |
| R2 | ⏳ PENDING | 靶向重构与深度优化 |
| R3 | ⏳ PENDING | SOTA 打磨与最终验收 |

## Subagent Dispatch Log

### Round 1 (6 concurrent)
- [x] fable-1: 架构规划 & 技术选型 ✅（产出 ARCHITECTURE.md + GAME_DESIGN.md）
- [ ] fable-2: SOTA 竞品审计 & 验收标准
- [ ] opus-fast-1: 核心游戏引擎 & 玩家系统
- [ ] opus-fast-2: 敌人/波次/升级系统
- [ ] gpt-sol-1: 环境探针 & 构建脚本
- [ ] gpt-sol-2: 边界测试 & Mock 探针

## Artifacts
- `.agent_workspace/ARCHITECTURE.md` — 完整架构：技术栈（Canvas 2D + 原生 JS 零依赖，classic script 保证 file:// 双击可玩）、8 大模块 API 契约、固定步长游戏循环、池化轻量 ECS、事件总线 EV 常量表、5 大差异化玩法系统设计、性能预算、文件结构树、R1 实现切分
- `.agent_workspace/GAME_DESIGN.md` — GDD：4 角色 / 8 武器 + 6 融合武器 / 5 元素反应表 / 8 敌人 + 3 三阶段 Boss / 15 分钟波次时间轴 / 连击 & Fever 数值 / 5 宠物 / UI 风格指南（配色 token + juice 清单）/ 数值基线表 §16
