# Round 1 环境探针报告模板

## 元数据

- 模型 slug：`gpt-5.6-sol-xhigh-fast`
- 执行时间（UTC）：`<YYYY-MM-DD HH:mm:ss>`
- Git commit：`<commit-sha>`
- 操作系统：`<os-version>`
- Node.js：`<node --version>`
- npm：`<npm --version>`
- Python：`<python3 --version>`

## 执行

```bash
cd egg-agent-survivor
npm run probe
```

退出码：`<exit-code>`

## 检查结果

| 检查项 | 状态 | 备注 |
| --- | --- | --- |
| 必需项目文件存在 | `<PASS/FAIL>` | `<details>` |
| `package.json` 含开发服务器脚本 | `<PASS/FAIL>` | `<details>` |
| HTML 入口可发现 | `<PASS/FAIL>` | `<details>` |
| HTML 本地引用完整 | `<PASS/FAIL>` | `<details>` |
| 必需 JavaScript 文件存在 | `<PASS/FAIL>` | `<details>` |
| 所有 JavaScript 通过 `node --check` | `<PASS/FAIL>` | `<details>` |

## 原始输出

```text
<paste npm run probe output here>
```

## 失败诊断与后续动作

`<若失败，记录缺失文件、无效引用或语法错误，以及建议修复动作；若通过则填“无”。>`
